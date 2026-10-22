import { DailyLogRecord, ExtraNoteRecord, TaskAssigneeRecord, TaskRecord } from '../types/database';
import { dedupeReportSourceReferences } from './reportContracts';
import { isDateInReportPeriod, ReportPeriod } from './reportPeriods';
import { isTaskDone, resolveTaskAssigneeIds } from './taskLifecycle';

export interface ClientReportSources {
  dailyLogs: DailyLogRecord[];
}

export type ReportTaskWorkKind = 'design' | 'video' | 'mixed' | 'unclassified';

export interface EmployeeTaskReportSource {
  task: TaskRecord;
  evidenceLogs: DailyLogRecord[];
  workKind: ReportTaskWorkKind;
  classificationSignals: string[];
  subjectIsCurrentAssignee: boolean;
  completionInPeriod: boolean;
}

export interface EmployeeReportSources {
  dailyLogs: DailyLogRecord[];
  extraNotes: ExtraNoteRecord[];
  tasks: EmployeeTaskReportSource[];
}

export type EmployeeClientScopeMode = 'all_clients' | 'selected_clients' | 'employee_overall';

export interface EmployeeClientScope {
  mode: EmployeeClientScopeMode;
  clientIds: string[];
}

const VIDEO_PATTERN = /\b(video|videos|reel|reels|motion|animation|montage|edit|editing)\b|فيديو|فيديوهات|ريل|ريلز|موشن|مونتاج|تحريك/iu;
const DESIGN_PATTERN = /\b(design|designs|graphic|graphics|banner|poster|carousel|visual|thumbnail|creative)\b|تصميم|تصميمات|جرافيك|بنر|بوستر|كاروسيل|غلاف|كرياتيف/iu;

function byDateThenId<T extends { date: string; id: string }>(a: T, b: T): number {
  return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

// Collapses rows that are genuine, DIFFERENT database rows (different ids — dedupeReportSourceKey
// above only ever catches the SAME id appearing twice) but describe the exact same piece of work:
// same author, same client, same day, byte-identical text once trimmed. Confirmed cause: a task's
// delivery auto-creates its own daily_logs row (source='auto_task', using the task's own title/
// description as the summary — see 20261120000000_auto_daily_log_from_delivered_task.sql), and if
// the same employee ALSO logs that same task manually on the same day, both rows are individually
// legitimate, but showing both reads as the exact same line repeated in the report. Only an EXACT
// match collapses — a close-but-not-identical wording is left alone, since this project never
// silently merges two entries that might carry genuinely different details. Keeps whichever one
// comes first in the caller's own ordering (deterministic, but arbitrary as to manual vs
// auto_task — the frontend has no way to tell those apart today, since report_source_manifest_v2's
// snapshot never includes the `source` column, only `date/user_id/client_id/summary_text/
// linked_task_ids`).
export function dedupeIdenticalWorkLogs<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function taskClassificationFields(task: TaskRecord): Array<[string, string]> {
  return [
    ['task_type', task.task_type || ''],
    ['task_type_other', task.task_type_other || ''],
    ['team', task.team || ''],
    ['title', task.title || ''],
    ['description', task.description || ''],
  ];
}

export function classifyReportTask(task: TaskRecord): {
  workKind: ReportTaskWorkKind;
  classificationSignals: string[];
} {
  const fields = taskClassificationFields(task);
  const videoSignals = fields.filter(([, value]) => VIDEO_PATTERN.test(value)).map(([field]) => `${field}:video`);
  const designSignals = fields.filter(([, value]) => DESIGN_PATTERN.test(value)).map(([field]) => `${field}:design`);
  const classificationSignals = [...videoSignals, ...designSignals];
  const workKind: ReportTaskWorkKind = videoSignals.length && designSignals.length
    ? 'mixed'
    : videoSignals.length
      ? 'video'
      : designSignals.length
        ? 'design'
        : 'unclassified';
  return { workKind, classificationSignals };
}

export function collectClientReportSources(
  dailyLogs: DailyLogRecord[],
  clientId: string,
  period: ReportPeriod
): ClientReportSources {
  const references = dedupeReportSourceReferences(
    dailyLogs
      .filter((log) => log.client_id === clientId && isDateInReportPeriod(log.date, period))
      .map((log) => ({ sourceKind: 'daily_log' as const, sourceId: log.id, row: log }))
  );
  const sorted = references.map((item) => item.row).sort(byDateThenId);
  return {
    dailyLogs: dedupeIdenticalWorkLogs(
      sorted,
      (log) => `${log.user_id}|${log.client_id ?? ''}|${log.date}|${log.summary_text.trim()}`
    ),
  };
}

export function collectEmployeeReportSources(
  dailyLogs: DailyLogRecord[],
  extraNotes: ExtraNoteRecord[],
  tasks: TaskRecord[],
  taskAssignees: TaskAssigneeRecord[],
  userId: string,
  period: ReportPeriod,
  clientScope: EmployeeClientScope = { mode: 'employee_overall', clientIds: [] }
): EmployeeReportSources {
  const allowedClientIds = new Set(clientScope.clientIds);
  const matchesClientScope = (clientId?: string | null): boolean => {
    if (clientScope.mode === 'employee_overall') return true;
    if (!clientId) return false;
    return allowedClientIds.has(clientId);
  };
  const work = dedupeReportSourceReferences(
    dailyLogs
      .filter((log) => log.user_id === userId && matchesClientScope(log.client_id) && isDateInReportPeriod(log.date, period))
      .map((log) => ({ sourceKind: 'daily_log' as const, sourceId: log.id, row: log }))
  );
  const eligibleLogs = dedupeIdenticalWorkLogs(
    work.map((item) => item.row).sort(byDateThenId),
    (log) => `${log.user_id}|${log.client_id ?? ''}|${log.date}|${log.summary_text.trim()}`
  );
  const notes = dedupeReportSourceReferences(
    (clientScope.mode === 'employee_overall' ? extraNotes : [])
      .filter((note) => note.user_id === userId && isDateInReportPeriod(note.date, period))
      .map((note) => ({ sourceKind: 'extra_note' as const, sourceId: note.id, row: note }))
  );

  // Assignment alone is never evidence of work. A task enters an employee report only when that
  // employee authored an eligible daily log that explicitly links the task. The task list itself
  // is already RLS-filtered by Supabase before it reaches this client-side preview.
  const evidenceByTaskId = new Map<string, DailyLogRecord[]>();
  eligibleLogs.forEach((log) => {
    [...new Set(log.linked_task_ids || [])].forEach((taskId) => {
      const evidence = evidenceByTaskId.get(taskId) || [];
      evidence.push(log);
      evidenceByTaskId.set(taskId, evidence);
    });
  });
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const taskSources = [...evidenceByTaskId.entries()]
    .map(([taskId, evidenceLogs]): EmployeeTaskReportSource | null => {
      const task = tasksById.get(taskId);
      if (!task) return null;
      const classification = classifyReportTask(task);
      const completionDate = task.completed_at?.slice(0, 10) || '';
      let completionInPeriod = false;
      if (isTaskDone(task.status) && completionDate) {
        try {
          completionInPeriod = isDateInReportPeriod(completionDate, period);
        } catch {
          completionInPeriod = false;
        }
      }
      return {
        task,
        evidenceLogs: [...evidenceLogs].sort(byDateThenId),
        ...classification,
        subjectIsCurrentAssignee: resolveTaskAssigneeIds(task.id, taskAssignees, task.assigned_to).includes(userId),
        completionInPeriod,
      };
    })
    .filter((source): source is EmployeeTaskReportSource => source !== null)
    .sort((a, b) => a.evidenceLogs[0].date.localeCompare(b.evidenceLogs[0].date) || a.task.id.localeCompare(b.task.id));

  return {
    dailyLogs: eligibleLogs,
    extraNotes: notes.map((item) => item.row).sort(byDateThenId),
    tasks: taskSources,
  };
}

export function composeInitialReportContent(
  scope: 'client' | 'employee',
  dailyLogs: DailyLogRecord[],
  extraNotes: ExtraNoteRecord[],
  taskSources: EmployeeTaskReportSource[],
  creatorNote: string,
  employeeNames: Map<string, string>,
  isCreativeSubject: boolean
): string {
  // No date prefix: the composed narrative reads as plain lines. log.date (and every log's full
  // row) stays exactly as stored — this only changes what's displayed/drafted, never
  // report_source_items (the audit ledger, which still orders by and keeps source_date).
  //
  // Employee-scope reports cover a single subject whose name is already shown in the report
  // header/subtitle, so repeating it on every line was always redundant. Client-scope reports can
  // span several employees at once, and used to keep an "Employee: text" prefix as the only way to
  // tell whose line is whose — dropped per request: it cluttered the pulled draft and had to be
  // manually deleted line by line before every report. `employeeNames`/`scope` are kept as
  // parameters (other call sites still pass them, and `scope` still gates the sections below) even
  // though work lines themselves no longer read either.
  const workLines = dailyLogs.map((log) => log.summary_text.trim());
  const noteLines = scope === 'employee'
    ? extraNotes.map((note) => `${note.date} — ${note.note_text.trim()}`)
    : [];
  const sections: string[] = [];
  if (workLines.length) sections.push(`Work logs (primary source)\n${workLines.join('\n')}`);

  if (scope === 'employee' && taskSources.length) {
    if (isCreativeSubject) {
      const designs = taskSources.filter((source) => source.workKind === 'design').length;
      const videos = taskSources.filter((source) => source.workKind === 'video').length;
      const unresolved = taskSources.filter((source) => source.workKind === 'mixed' || source.workKind === 'unclassified').length;
      const completedDesigns = taskSources.filter((source) => source.workKind === 'design' && source.completionInPeriod).length;
      const completedVideos = taskSources.filter((source) => source.workKind === 'video' && source.completionInPeriod).length;
      sections.push([
        'Creative task evidence summary',
        `Design tasks evidenced by linked work logs: ${designs} (confirmed completed in period: ${completedDesigns})`,
        `Video tasks evidenced by linked work logs: ${videos} (confirmed completed in period: ${completedVideos})`,
        `Mixed or unclassified tasks requiring review: ${unresolved}`,
      ].join('\n'));
    }
    // Newly composed reports no longer include a "Task evidence ledger" section — it read as
    // confusing, unexplained extra content to the report's audience. The underlying task-evidence
    // data these lines would have shown is still fully preserved in report_source_items (the audit
    // ledger) and still available to anything that reads the raw sources; this only stops it from
    // being composed into the narrative text going forward. REPORT_SECTION_HEADINGS.taskLedger and
    // its parsing/rendering (pdfExport.ts, reportHtmlExport.ts) are deliberately left untouched so
    // any already-saved report that still has this section in its stored content_text keeps
    // rendering exactly as before.
  }

  if (noteLines.length) sections.push(`Additional employee context\n${noteLines.join('\n')}`);
  // For client reports this note is deliberately folded into the narrative as client context;
  // it is never labelled "Extra Note". The original remains stored separately by the RPC.
  if (creatorNote.trim()) sections.push(`Context and observations\n${creatorNote.trim()}`);
  return sections.join('\n\n') || 'No eligible work records were found for this period.';
}
