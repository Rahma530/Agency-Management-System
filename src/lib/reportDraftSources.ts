import { DailyLogRecord, ExtraNoteRecord } from '../types/database';
import { dedupeReportSourceReferences } from './reportContracts';
import { isDateInReportPeriod, ReportPeriod } from './reportPeriods';

export interface ClientReportSources {
  dailyLogs: DailyLogRecord[];
}

export interface EmployeeReportSources {
  dailyLogs: DailyLogRecord[];
  extraNotes: ExtraNoteRecord[];
}

function byDateThenId<T extends { date: string; id: string }>(a: T, b: T): number {
  return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
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
  return { dailyLogs: references.map((item) => item.row).sort(byDateThenId) };
}

export function collectEmployeeReportSources(
  dailyLogs: DailyLogRecord[],
  extraNotes: ExtraNoteRecord[],
  userId: string,
  period: ReportPeriod
): EmployeeReportSources {
  const work = dedupeReportSourceReferences(
    dailyLogs
      .filter((log) => log.user_id === userId && isDateInReportPeriod(log.date, period))
      .map((log) => ({ sourceKind: 'daily_log' as const, sourceId: log.id, row: log }))
  );
  const notes = dedupeReportSourceReferences(
    extraNotes
      .filter((note) => note.user_id === userId && isDateInReportPeriod(note.date, period))
      .map((note) => ({ sourceKind: 'extra_note' as const, sourceId: note.id, row: note }))
  );
  return {
    dailyLogs: work.map((item) => item.row).sort(byDateThenId),
    extraNotes: notes.map((item) => item.row).sort(byDateThenId),
  };
}

export function composeInitialReportContent(
  scope: 'client' | 'employee',
  dailyLogs: DailyLogRecord[],
  extraNotes: ExtraNoteRecord[],
  creatorNote: string,
  employeeNames: Map<string, string>
): string {
  const workLines = dailyLogs.map(
    (log) => `${log.date} — ${employeeNames.get(log.user_id) || 'Employee'}: ${log.summary_text.trim()}`
  );
  const noteLines = scope === 'employee'
    ? extraNotes.map((note) => `${note.date} — ${note.note_text.trim()}`)
    : [];
  const sections: string[] = [];
  if (workLines.length) sections.push(`Work completed\n${workLines.join('\n')}`);
  if (noteLines.length) sections.push(`Additional context\n${noteLines.join('\n')}`);
  // For client reports this note is deliberately folded into the narrative as client context;
  // it is never labelled "Extra Note". The original remains stored separately by the RPC.
  if (creatorNote.trim()) sections.push(`Context and observations\n${creatorNote.trim()}`);
  return sections.join('\n\n') || 'No eligible work records were found for this period.';
}
