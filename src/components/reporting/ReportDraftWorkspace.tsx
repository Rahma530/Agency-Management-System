import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CheckCircle2, Download, FilePenLine, Save, Sparkles, Trash2, X } from 'lucide-react';
import {
  ClientRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  ReportAiSuggestionRecord,
  ReportContentVersionRecord,
  ReportRecord,
  ReportSourceItemRecord,
  ServiceType,
  TaskAssigneeRecord,
  TaskAttachmentRecord,
  TaskRecord,
  UserRecord,
} from '../../types/database';
import { supabase, supabaseRaw } from '../../lib/supabase';
import { formatLocalCalendarDate, parseReportPeriodRange, resolveReportPeriod, resolveReportTypeLabel } from '../../lib/reportPeriods';
import {
  collectClientReportSources, collectEmployeeReportSources, dedupeIdenticalWorkLogs, EmployeeClientScopeMode,
} from '../../lib/reportDraftSources';
import { downloadReportPdf, OTHER_SERVICE_BUCKET_LABEL, parseReportContentIntoParagraphs, REPORT_SECTION_HEADINGS } from '../../lib/pdfExport';
import { buildIndividualReportHtml, downloadHtmlReport } from '../../lib/reportHtmlExport';
import { getReportClientServiceLock, isCreativeReportSubject } from '../../lib/reportAgentEligibility';
import { extractLinks } from '../../lib/textLinks';
import { CLIENT_SERVICES, getClientServices, SERVICE_LABELS } from '../../lib/clientServices';
import { classifyWorkLogService } from '../../lib/workLogServiceClassification';
import { CampaignSummaryWorkItem, WorkItemGroup, WorkItemGroupGenerationResult, formatPeriodLabel } from './ComparisonDisplay';
import { ReportContentPreview } from './ReportContentPreview';

// scope/period/creatorNote are CONTROLLED (owned by ReportsHub, the unified single-page parent)
// so the same values drive both this component's own Sources/Draft logic AND the Comparison
// section ReportsHub renders alongside it — a single scope+period picker for the whole page,
// per the unification: one Setup section at the top, no second scope/period selector anywhere
// else on the page. 'own' (scopeKind) is a thin convenience preset over the existing
// scopeType='employee'/employeeScopeMode='all_clients' shape — not a new backend concept, and not
// a new RPC arg: it still sends p_scope_type:'employee' with subjectUserId = the current user.
export type ReportScopeKind = 'client' | 'employee' | 'own';

interface Props {
  currentUser: UserRecord;
  users: UserRecord[];
  clients: ClientRecord[];
  employees: UserRecord[];
  reports: ReportRecord[];
  dailyLogs: DailyLogRecord[];
  extraNotes: ExtraNoteRecord[];
  tasks: TaskRecord[];
  taskAssignees: TaskAssigneeRecord[];
  openReportId?: string | null;
  onOpenReportHandled?: () => void;
  onReportChanged: (report: ReportRecord) => void;
  onReportDeleted: (reportId: string) => void;
  // Controlled scope/period — see the ReportScopeKind comment above.
  scopeKind: ReportScopeKind;
  onScopeKindChange: (kind: ReportScopeKind) => void;
  clientId: string;
  onClientIdChange: (id: string) => void;
  subjectUserId: string;
  onSubjectUserIdChange: (id: string) => void;
  employeeScopeMode: EmployeeClientScopeMode | '';
  onEmployeeScopeModeChange: (mode: EmployeeClientScopeMode | '') => void;
  selectedClientIds: string[];
  onSelectedClientIdsChange: (ids: string[]) => void;
  // Per-service CLIENT-scope filter (null = "All services"). Owned by ReportsHub's top bar, same
  // controlled-prop pattern as clientId/employeeScopeMode. Only sent to the server when
  // effectiveScopeType === 'client' — the server recomputes and enforces its own effective filter
  // regardless (see report_caller_client_service_lock() /
  // 20261125000000_report_client_service_filter.sql), so this can only narrow what a "Choice" role
  // asks for, never widen a Locked role's access.
  clientServiceFilter: ServiceType | null;
  periodStart: string;
  onPeriodStartChange: (value: string) => void;
  periodEnd: string;
  onPeriodEndChange: (value: string) => void;
  // AI Summary is the sole AI action inside the draft now (Suggest rewrite's button was removed
  // from this UI — the RPC/edge function it used, create_report_ai_suggestion/ai-router
  // REPORT_REWRITE, and apply_report_ai_suggestion for any already-pending suggestion, are
  // untouched). Resolves to replacement draft text, or a safe message on failure — ReportsHub
  // owns ensuring/generating the underlying comparison and calling onGenerateAiSummary itself,
  // so this component stays decoupled from CampaignSummaryPayload's shape. The current
  // creatorNote text is passed as an argument (not lifted to ReportsHub as its own controlled
  // prop) since this component is the only owner of that textarea's live value.
  onRequestAiSummary?: (
    creatorNote?: string,
    workItems?: CampaignSummaryWorkItem[]
  ) => Promise<
    | { ok: true; text: string; partial?: boolean; items?: { id: string; text: string }[] }
    | { ok: false; message: string }
  >;
  // "Group similar entries" — a separate, narrower AI action from AI Summary above. It never
  // rewrites prose; it only decides which same-employee work-log lines repeat the exact same
  // activity and merges them into one line with a count the server has independently verified
  // (taskRegistry.ts's WORK_ITEM_GROUP never takes the model's count on its word — see
  // groupSimilarEntries below). Optional for the same reason onRequestAiSummary is.
  onGroupWorkItems?: (
    items: { id: string; employee?: string; text: string }[]
  ) => Promise<WorkItemGroupGenerationResult>;
  // Bumped by ReportsHub whenever the top-bar scope/period changes to a combination with no
  // matching draft — tells this workspace to confirm-discard (if needed) and reset to its empty,
  // new-draft state. A matching draft instead arrives via openReportId as usual.
  clearSignal?: number;
}

const today = () => formatLocalCalendarDate(new Date());

interface SourceManifest { source_hash: string; source_count: number; sources: Array<Omit<ReportSourceItemRecord, 'id' | 'report_id'>> }

// Task attachments (images/files uploaded via a task's own attachment panel) are never copied
// anywhere — not onto the daily_logs row the task-completion trigger auto-creates, and not into
// report_source_items' immutable snapshot. They stay the single source of truth in
// task_attachments/storage, and this just resolves them, live, for whichever tasks a daily log's
// own linked_task_ids happen to point at, every time a report is built/regenerated. Both the
// metadata read and the signed-URL grant are still governed by task_attachments'/storage.objects'
// own RLS (task_visible_v2) — a viewer who cannot see a task at all simply gets no attachments for
// it here either, the same authorized-scope narrowing as everywhere else in this file.
//
// A private bucket has no permanent public link, so any URL embedded in a generated report/PDF
// necessarily expires eventually — 30 days is chosen so it still works for the realistic window a
// report is actually opened and reviewed in, not as a promise it works forever. This is a known,
// accepted limitation (documented in the PR), not something to chase further here.
const ATTACHMENT_LINK_TTL_SECONDS = 60 * 60 * 24 * 30;

async function fetchTaskAttachmentLinks(taskIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (!ids.length) return result;
  const { data, error } = await supabaseRaw.from('task_attachments').select('*').in('task_id', ids);
  if (error || !data) return result;
  await Promise.all((data as TaskAttachmentRecord[]).map(async (attachment) => {
    const { data: signed } = await supabase.storage
      .from('task-attachments')
      .createSignedUrl(attachment.storage_path, ATTACHMENT_LINK_TTL_SECONDS);
    if (!signed?.signedUrl) return;
    result.set(attachment.task_id, [...(result.get(attachment.task_id) || []), signed.signedUrl]);
  }));
  return result;
}

function linkedTaskIdsOf(source: Pick<ReportSourceItemRecord, 'snapshot'>): string[] {
  return Array.isArray(source.snapshot.linked_task_ids) ? (source.snapshot.linked_task_ids as string[]) : [];
}

// Only meaningful for a CLIENT-scope report: "this client's subscribed services" has no single
// meaning for an employee-scope report, which can span several clients at once. usersById is the
// full roster (not just this manifest's authors) so a lookup never misses an active or deactivated
// user. See classifyWorkLogService's own comment for the role->service mapping and its limits.
interface WorkLogServiceGrouping {
  client: ClientRecord;
  usersById: Map<string, UserRecord>;
}

// workLogGroups (optional): the result of "Group similar entries" (onGroupWorkItems), keyed by
// each log's own source_id. When present, it REPLACES the plain per-log line rendering below with
// one line per group — a group of 2+ ids becomes one merged line (its already-server-verified
// text), a group of 1 id renders exactly like an ungrouped log always has. Every log's source_id
// must appear in exactly one group (groupSimilarEntries' caller guarantees this; see its own
// comment), so nothing here needs its own "leftover" handling.
//
// serviceGrouping (optional): when present, the rendered lines are additionally bucketed by the
// author's classified service (classifyWorkLogService) and emitted as one sub-section per service
// — heading line, then its lines, blank line, next service — ordered by the client's own
// subscribed-services order (CLIENT_SERVICES), with any classified service the client isn't
// actually subscribed to still shown (never dropped) right after, and an "Other updates" bucket
// for anything that couldn't be confidently classified always last. pdfExport.ts's
// parseReportContentIntoParagraphs recovers this exact same structure back out of the saved
// content_text at PDF-export time to give each service its own heading and a decorative divider —
// see that function's own comment for the heading strings this must stay in sync with.
// source_date is a plain `date` column, always "YYYY-MM-DD" — a straight substring split, no
// Date() parsing/timezone conversion involved. Day/month only (no year): within a single report
// period the year never needs spelling out.
function toDayMonth(isoDate: string): string {
  const [, month, day] = isoDate.split('-');
  return `${day}/${month}`;
}

// Report header's period range — "From 10/22/2026 To 10/26/2026" per the agency owner's latest,
// more specific request (superseding the earlier "22 - 10  to  25 - 10" shape): MM/DD/YYYY with
// the year included, and "From"/"To" spelled out so each date reads unambiguously next to the
// other. Plain text here (no bold) — this is the degraded/fallback path: the PDF header has no
// safe way to mix bold and normal runs within one right-aligned Arabic-shaped line (see
// pdfExport.ts's own header-drawing comment), and the HTML export only falls back to this string
// when buildIndividualReportHtml's own renderDateRangeHtml (reportHtmlExport.ts), which DOES
// render true bold "From"/"To" spans, can't parse the period at all. Delegates the actual
// parsing/formatting to parseReportPeriodRange so both export paths agree on what "the date part"
// looks like. selectedReport.period is always "<fromIso>_<toIso>" (resolveReportPeriod's own
// format) or empty.
function formatReportPeriodRange(period: string): string {
  const parsed = parseReportPeriodRange(period);
  if (!parsed) return period || '';
  return `${parsed.from.label} ${parsed.from.date} ${parsed.to.label} ${parsed.to.date}`;
}

function renderWorkLogSection(
  logs: Array<Omit<ReportSourceItemRecord, 'id' | 'report_id'>>,
  names: Map<string, string>,
  attachmentLinksByTask: Map<string, string[]>,
  workLogGroups?: WorkItemGroup[],
  serviceGrouping?: WorkLogServiceGrouping,
  // Previously true only for employee-scope reports (whose single subject's name the report
  // header/subtitle already shows) — client-scope reports (which can span several employees) used
  // to always keep an "Employee: text" prefix as the only way to tell whose line is whose. Dropped
  // per request for both scopes: it cluttered the pulled draft and had to be manually deleted line
  // by line. `names`/`omitAuthorPrefix` are kept as parameters (every call site still passes them)
  // even though renderLine no longer reads either — `names` is still used below to resolve
  // employee roles into serviceGrouping's per-service buckets, which has nothing to do with
  // whether a name is PRINTED on the line.
  omitAuthorPrefix?: boolean
): string {
  // date (optional): woven into the line as a trailing clause — "تم نشر بوست بتاريخ 22/10" — not
  // a separate line above the text. Omitted (undefined) for a merged multi-log group (2+ ids):
  // that text already describes several days' worth of entries at once ("posted X times"-style),
  // so a single date would misrepresent it. A single-log entry, grouped or not, always gets one.
  const renderLine = (_employeeName: string, text: string, attachmentLines: string[], date?: string): string => {
    // A log the employee attached a file/link to without typing any description used to render as
    // a bare "بتاريخ D/M" line once the date clause below was appended to the (empty) text — a
    // card with no content of its own, reading in the export as a stray, disconnected date next to
    // its attachment. Falling back to a short placeholder keeps every entry self-contained: the
    // date and attachment(s) always anchor to real visible text, never to nothing.
    const baseText = text || (attachmentLines.length ? 'مرفق' : text);
    const firstLine = date ? `${baseText} بتاريخ ${toDayMonth(date)}` : baseText;
    return attachmentLines.length ? [firstLine, ...attachmentLines].join('\n') : firstLine;
  };

  type RenderedLine = { userId: string; line: string };
  let lines: RenderedLine[];
  if (!workLogGroups || !workLogGroups.length) {
    lines = logs.map((source) => ({
      userId: source.user_id,
      line: renderLine(
        names.get(source.user_id) || 'Employee',
        String(source.snapshot.summary_text || '').trim(),
        linkedTaskIdsOf(source).flatMap((taskId) => attachmentLinksByTask.get(taskId) || []),
        source.source_date
      ),
    }));
  } else {
    const logsById = new Map(logs.map((source) => [source.source_id, source]));
    lines = workLogGroups
      .map((group) => {
        const first = logsById.get(group.ids[0]);
        if (!first) return null; // a stale group referencing a log no longer in this manifest
        const attachmentLines = group.ids.flatMap((id) => {
          const source = logsById.get(id);
          return source ? linkedTaskIdsOf(source).flatMap((taskId) => attachmentLinksByTask.get(taskId) || []) : [];
        });
        const date = group.ids.length === 1 ? first.source_date : undefined;
        return { userId: first.user_id, line: renderLine(names.get(first.user_id) || 'Employee', group.text, attachmentLines, date) };
      })
      .filter((entry): entry is RenderedLine => entry !== null);
  }

  if (!serviceGrouping) return lines.map((entry) => entry.line).join('\n');

  type ServiceBucketKey = ServiceType | 'other';
  const buckets = new Map<ServiceBucketKey, string[]>();
  lines.forEach((entry) => {
    const role = serviceGrouping.usersById.get(entry.userId)?.role;
    const key: ServiceBucketKey = classifyWorkLogService(role) ?? 'other';
    buckets.set(key, [...(buckets.get(key) || []), entry.line]);
  });
  const subscribedServices = getClientServices(serviceGrouping.client);
  const orderedKeys: ServiceBucketKey[] = [
    ...subscribedServices.filter((service) => buckets.has(service)),
    ...CLIENT_SERVICES.filter((service) => !subscribedServices.includes(service) && buckets.has(service)),
    ...(buckets.has('other') ? (['other'] as ServiceBucketKey[]) : []),
  ];
  return orderedKeys
    .map((key) => `${key === 'other' ? OTHER_SERVICE_BUCKET_LABEL : SERVICE_LABELS[key]}\n${buckets.get(key)!.join('\n')}`)
    .join('\n\n');
}

function composeManifestContent(
  manifest: SourceManifest,
  creatorNote: string,
  names: Map<string, string>,
  creative: boolean,
  attachmentLinksByTask: Map<string, string[]>,
  workLogGroups?: WorkItemGroup[],
  serviceGrouping?: WorkLogServiceGrouping,
  // See renderWorkLogSection's own comment: true for employee-scope reports, so the subject's name
  // (already shown in the report header) isn't repeated on every work-log line.
  omitAuthorPrefix?: boolean
): string {
  // dedupeIdenticalWorkLogs: see its own comment in reportDraftSources.ts — collapses a daily_log
  // row auto-created from a delivered task's own title/description (source='auto_task') with a
  // same-day manual entry an employee also wrote for that same task, when the two read as byte-
  // identical text. Applied here (not only in the brand-new-draft collectors) so Pull sources
  // again/Group similar entries/AI Summary/Revert to original sources on an ALREADY-OPEN report
  // all see the same deduped set too, since they all route through this composer.
  const logs = dedupeIdenticalWorkLogs(
    manifest.sources.filter((source) => source.source_kind === 'daily_log'),
    (source) => `${source.user_id}|${source.client_id ?? ''}|${source.source_date}|${String(source.snapshot.summary_text || '').trim()}`
  );
  const notes = manifest.sources.filter((source) => source.source_kind === 'extra_note');
  const tasks = manifest.sources.filter((source) => source.source_kind === 'task');
  const sections: string[] = [];
  if (logs.length) sections.push(`${REPORT_SECTION_HEADINGS.workLogs}\n${renderWorkLogSection(logs, names, attachmentLinksByTask, workLogGroups, serviceGrouping, omitAuthorPrefix)}`);
  if (creative && tasks.length) {
    const count = (kind: string) => tasks.filter((source) => source.snapshot.work_kind === kind).length;
    sections.push(`${REPORT_SECTION_HEADINGS.creativeSummary}\nDesign tasks evidenced by linked work logs: ${count('design')}\nVideo tasks evidenced by linked work logs: ${count('video')}\nMixed or unclassified tasks requiring review: ${count('mixed') + count('unclassified')}`);
  }
  // Newly composed reports no longer include a "Task evidence ledger" section (see
  // composeInitialReportContent's matching comment in reportDraftSources.ts) — the task rows
  // themselves are still fully preserved in manifest.sources/report_source_items either way.
  // REPORT_SECTION_HEADINGS.taskLedger and its parsing/rendering stay untouched so an
  // already-saved report that has this section in its stored content_text keeps rendering as-is.
  if (notes.length) sections.push(`${REPORT_SECTION_HEADINGS.employeeContext}\n${notes.map((source) => `${source.source_date} — ${String(source.snapshot.note_text || '').trim()}`).join('\n')}`);
  if (creatorNote.trim()) sections.push(`${REPORT_SECTION_HEADINGS.creatorContext}\n${creatorNote.trim()}`);
  return sections.join('\n\n') || 'No eligible work records were found for this period.';
}

export const ReportDraftWorkspace: React.FC<Props> = ({
  currentUser,
  users,
  clients,
  employees,
  reports,
  dailyLogs,
  extraNotes,
  tasks,
  taskAssignees,
  openReportId,
  onOpenReportHandled,
  onReportChanged,
  onReportDeleted,
  scopeKind,
  onScopeKindChange,
  clientId,
  onClientIdChange,
  subjectUserId,
  onSubjectUserIdChange,
  employeeScopeMode,
  onEmployeeScopeModeChange,
  selectedClientIds,
  onSelectedClientIdsChange,
  clientServiceFilter,
  periodStart,
  onPeriodStartChange,
  periodEnd,
  onPeriodEndChange,
  onRequestAiSummary,
  onGroupWorkItems,
  clearSignal,
}) => {
  // scopeKind 'own' always resolves to the current user's own employee-overall-all-clients work
  // — the same p_scope_type:'employee' shape as a manually picked employee, just with
  // subjectUserId/employeeScopeMode pinned rather than offered as pickers.
  const effectiveScopeType: 'client' | 'employee' = scopeKind === 'client' ? 'client' : 'employee';
  const effectiveSubjectUserId = scopeKind === 'own' ? currentUser.id : subjectUserId;
  const effectiveEmployeeScopeMode: EmployeeClientScopeMode | '' = scopeKind === 'own' ? 'all_clients' : employeeScopeMode;
  // Client-side mirror of the server's own-lock resolution, for the preview count below only — the
  // server (report_caller_client_service_lock()) is the real enforcer regardless of what this
  // computes or what clientServiceFilter holds.
  const reportClientServiceLock = useMemo(() => getReportClientServiceLock(currentUser.role), [currentUser.role]);
  const effectiveClientServiceFilter = reportClientServiceLock === 'choice' ? clientServiceFilter : reportClientServiceLock;

  const [clientSearch, setClientSearch] = useState('');
  const [creatorNote, setCreatorNote] = useState('');
  const [draftText, setDraftText] = useState('');
  // The currently-active per-log "grouping" state for the work-log lines in the editor: which
  // source_ids are merged together (same shape WorkItemGroup already uses for "Group similar
  // entries"), and what text currently represents each group — raw original wording for an
  // untouched log, the merged "posted X times"-style wording for a server-verified merge, or the
  // latest AI Summary rephrase, whichever happened most recently. undefined means "no grouping/
  // rephrase history yet — use each log's raw original text, one line per log", the same as before
  // this state existed.
  //
  // Both AI Summary (requestAiSummary) and Group similar entries (groupSimilarEntries) read this
  // before building their own request, and both write an updated version back after a successful
  // run — so running one after the other carries the other's result forward instead of silently
  // discarding it (requested fix: grouping used to vanish the moment AI Summary ran again, since it
  // always rebuilt one item per raw log row from scratch; Group now also passes along whatever
  // wording AI Summary last gave each line, instead of always reverting to the raw original text).
  // Reset to undefined wherever previewManifest is reset for a reason that invalidates it too (a
  // different report opened, a fresh "Pull sources again"/new draft, "Clear AI text", or a
  // scope/period change) — see the selectedReportId effect, buildPreview, and clearAiText below.
  const [activeWorkLogGroups, setActiveWorkLogGroups] = useState<WorkItemGroup[] | undefined>(undefined);
  // One-step undo for whatever draftText (and activeWorkLogGroups) held right before AI Summary,
  // Group similar entries, or Clear AI text last overwrote them — so an accidental or unwanted
  // overwrite can be undone with one click instead of a full page refresh. Reset to null whenever a
  // different report (or no report) is opened, so a snapshot never applies across reports (see the
  // clearSignal/selectedReportId effect below).
  const [undoSnapshot, setUndoSnapshot] = useState<{ text: string; groups: WorkItemGroup[] | undefined } | null>(null);
  const [selectedReportId, setSelectedReportId] = useState('');
  const [versions, setVersions] = useState<ReportContentVersionRecord[]>([]);
  const [sources, setSources] = useState<ReportSourceItemRecord[]>([]);
  const [suggestion, setSuggestion] = useState<ReportAiSuggestionRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [previewManifest, setPreviewManifest] = useState<SourceManifest | null>(null);
  // Optional, per-report, NOT persisted: lets a client-scope report show a different name in the
  // exported PDF/HTML than the client's own stored name (e.g. an English name for a client
  // registered with an Arabic name in the system) — requested as something to fill in fresh each
  // time, not a standing per-client setting, so deliberately kept as throwaway local state (reset
  // on report switch above) rather than a new column/migration. Empty means "use the real name" —
  // see exportPdf/exportHtml below for where it's applied, and the input next to those buttons.
  const [clientDisplayNameOverride, setClientDisplayNameOverride] = useState('');
  const creationKey = useRef<string | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  // Mirrors `reports` on every render WITHOUT being a reactive dependency anywhere below. `reports`
  // is the whole app's global report list (App.tsx), replaced with a brand-new array reference on
  // every unrelated mutation anywhere in the app (another bulk task action, another report being
  // saved, a background refetch) — not only when this specific report's own content actually
  // changes. The report-switch effect below used to depend on `reports` directly, so any of those
  // unrelated refreshes silently re-ran it mid-session: it re-read `content_text` from the (still
  // correct, but now a different object) version record and wiped the in-progress
  // activeWorkLogGroups/undoSnapshot/previewManifest, reproducing exactly the "Group similar
  // entries, then AI Summary un-merges it again, with no refresh involved" symptom. Reading
  // `reportsRef.current` instead keeps the lookup correct (always the latest data) while only
  // *reacting* to an actual `selectedReportId` change, matching this effect's own stated intent of
  // "never carry [draft state] over to a different report".
  const reportsRef = useRef(reports);
  reportsRef.current = reports;

  const selectedReport = reports.find((report) => report.id === selectedReportId) || null;
  const currentVersion = selectedReport
    ? versions.find((version) => version.id === selectedReport.current_version_id) || versions[0] || null
    : null;
  const names = useMemo(() => new Map(users.map((user) => [user.id, user.name])), [users]);
  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  // Drives the PDF-by-service grouping (renderWorkLogSection) — undefined for an employee-scope
  // report (see WorkLogServiceGrouping's own comment for why) or if the picked client can't be
  // found (e.g. a stale/deleted id), in which case the work-log section just renders flat, exactly
  // as it always has.
  const workLogServiceGrouping = useMemo(() => {
    if (effectiveScopeType !== 'client') return undefined;
    const client = clients.find((item) => item.id === clientId);
    return client ? { client, usersById } : undefined;
  }, [effectiveScopeType, clientId, clients, usersById]);
  // Point 2: "name — من X إلى Y" (not "{period} — {name}") so the Arabic subject name and the
  // period's two dates each keep their own reading order instead of garbling together — see
  // formatPeriodLabel's own comment (ComparisonDisplay.tsx) for why raw "start_end" labels read
  // backwards next to Arabic text. reportSubjectName is kept separate from reportLabel so the
  // on-screen title (507 below) can additionally wrap just the name in <bdi>; window.prompt/
  // window.confirm (407/444/445 below) have no bidi markup of their own, so they get the plain
  // string version.
  const reportSubjectName = selectedReport
    ? (selectedReport.scope_type === 'employee'
        ? names.get(selectedReport.subject_user_id || '') || 'Employee'
        : clients.find((client) => client.id === selectedReport.client_id)?.name || 'Client')
    : '';
  const reportLabel = selectedReport
    ? `${reportSubjectName} — ${formatPeriodLabel(selectedReport.period)}`
    : 'new report';
  const selectedSubject = users.find((user) => user.id === effectiveSubjectUserId);
  const period = useMemo(() => {
    try {
      return resolveReportPeriod(periodStart, periodEnd);
    } catch {
      return null;
    }
  }, [periodStart, periodEnd]);

  const preview = useMemo(() => {
    if (!period) return { dailyLogs: [] as DailyLogRecord[], extraNotes: [] as ExtraNoteRecord[], tasks: [] };
    if (effectiveScopeType === 'client') {
      const result = collectClientReportSources(dailyLogs, clientId, period);
      const filteredLogs = !effectiveClientServiceFilter
        ? result.dailyLogs
        : effectiveClientServiceFilter === 'own_entries'
        ? result.dailyLogs.filter((log) => log.user_id === currentUser.id)
        : result.dailyLogs.filter(
            (log) => classifyWorkLogService(users.find((user) => user.id === log.user_id)?.role) === effectiveClientServiceFilter
          );
      return { dailyLogs: filteredLogs, extraNotes: [] as ExtraNoteRecord[], tasks: [] };
    }
    return collectEmployeeReportSources(dailyLogs, extraNotes, tasks, taskAssignees, effectiveSubjectUserId, period, {
      mode: effectiveEmployeeScopeMode || 'employee_overall',
      clientIds: effectiveEmployeeScopeMode === 'selected_clients' ? selectedClientIds : clients.map((client) => client.id),
    });
  }, [period, effectiveScopeType, clientId, effectiveClientServiceFilter, currentUser.id, users, effectiveSubjectUserId, effectiveEmployeeScopeMode, selectedClientIds, clients, dailyLogs, extraNotes, tasks, taskAssignees]);

  useEffect(() => {
    if (!openReportId) return;
    const report = reports.find((item) => item.id === openReportId);
    if (!report || (report.scope_type !== 'client' && report.scope_type !== 'employee')) {
      onOpenReportHandled?.();
      return;
    }
    const hasPendingEditorText = !!draftText.trim() && (!currentVersion || draftText !== currentVersion.content_text);
    if (hasPendingEditorText && !window.confirm('Discard unsaved editor changes and open the filed report?')) {
      onOpenReportHandled?.();
      return;
    }
    setSelectedReportId(report.id);
    setMessage(null);
    workspaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    onOpenReportHandled?.();
    // This effect consumes an explicit open request. Report-list refreshes must not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReportId]);

  // Shared by buildPreview (new-draft flow, below) and pullSourcesAgain (an already-open report,
  // further down): both just need a fresh, server-authorized source manifest for the current
  // scope/period — preview_report_sources_v2 is read-only (`language sql stable`, no side
  // effects), so calling it again any number of times is always safe. Returns null (and sets
  // `message`) on a validation/RPC failure instead of throwing, so each caller's own try/finally
  // stays simple.
  const fetchSourceManifest = async (): Promise<SourceManifest | null> => {
    if (!period || (effectiveScopeType === 'client' ? !clientId : !effectiveSubjectUserId || !effectiveEmployeeScopeMode || (effectiveEmployeeScopeMode === 'selected_clients' && !selectedClientIds.length))) {
      setMessage('Choose the report subject, period, and an explicit employee client scope first.');
      return null;
    }
    try {
      const { data, error } = await supabaseRaw.rpc('preview_report_sources_v2', {
        p_scope_type: effectiveScopeType, p_client_id: effectiveScopeType === 'client' ? clientId : null,
        p_subject_user_id: effectiveScopeType === 'employee' ? effectiveSubjectUserId : null,
        p_employee_scope_mode: effectiveScopeType === 'employee' ? effectiveEmployeeScopeMode : null,
        p_employee_client_ids: effectiveScopeType === 'employee' && effectiveEmployeeScopeMode === 'selected_clients' ? selectedClientIds : [],
        p_period_start: period.startInclusive, p_period_end_exclusive: period.endExclusive,
        p_service_filter: effectiveScopeType === 'client' ? clientServiceFilter : null,
      });
      if (error) throw error;
      return data as unknown as SourceManifest;
    } catch {
      setMessage('Unable to build the server-authorized source preview. Confirm the lifecycle migration is applied.');
      return null;
    }
  };

  // Keep AI input separate from both the editable report text and any saved AI output. This maps
  // only original daily-log snapshots from a just-fetched, server-authorized manifest; it never
  // reads draftText, report_content_versions, or a prior summary. Also resolves each log's linked
  // task(s)' own attachments (see fetchTaskAttachmentLinks above) and folds them into the same
  // `links` array a manually-typed URL in the log text already uses — AI rewrite strips/reattaches
  // that array unchanged (ComparisonDisplay.tsx's own comment on CampaignSummaryWorkItem), so an
  // attachment link survives an AI Summary exactly like a manual one already does, with no further
  // change needed downstream (PDF export already turns every `links` entry into its own clickable
  // annotation).
  // groups (optional): the currently-active work-log grouping (activeWorkLogGroups) — when given,
  // builds exactly ONE work item PER GROUP (using the group's already-merged/rephrased text)
  // instead of one item per raw log row, so a prior "Group similar entries" merge survives an AI
  // Summary rephrase instead of being silently exploded back into individual lines. Any id in a
  // group that's no longer present in this fresh manifest (a stale group from a since-changed
  // source set) is dropped from that group; a group left with no valid ids is skipped entirely —
  // the same staleness handling renderWorkLogSection already applies to workLogGroups. Also
  // returns the effective groups actually used (aligned 1:1 with the returned items by id), so the
  // caller can later zip the AI's rephrased text for each id back onto the right group.
  const workItemsFromOriginalSources = async (
    sourceList: Array<Pick<ReportSourceItemRecord, 'source_kind' | 'source_id' | 'user_id' | 'snapshot'>>,
    groups?: WorkItemGroup[]
  ): Promise<{ items: CampaignSummaryWorkItem[]; groups: WorkItemGroup[] }> => {
    const logSources = sourceList.filter((source) => source.source_kind === 'daily_log');
    const attachmentLinksByTask = await fetchTaskAttachmentLinks(logSources.flatMap(linkedTaskIdsOf));
    const logsById = new Map(logSources.map((source) => [source.source_id, source]));

    const effectiveGroups: WorkItemGroup[] = groups && groups.length
      ? groups
          .map((group) => ({ ...group, ids: group.ids.filter((id) => logsById.has(id)) }))
          .filter((group) => group.ids.length > 0)
      : logSources.map((source) => ({ ids: [source.source_id], text: String(source.snapshot.summary_text || '').trim() }));

    const items = effectiveGroups
      .map((group): CampaignSummaryWorkItem | null => {
        const first = logsById.get(group.ids[0]);
        if (!first) return null;
        const { cleanText, links } = extractLinks(group.text.trim());
        const attachmentLinks = group.ids.flatMap((id) => {
          const source = logsById.get(id);
          return source ? linkedTaskIdsOf(source).flatMap((taskId) => attachmentLinksByTask.get(taskId) || []) : [];
        });
        const allLinks = [...links, ...attachmentLinks];
        return {
          id: group.ids[0],
          employee: names.get(first.user_id) || undefined,
          text: cleanText,
          ...(allLinks.length ? { links: allLinks } : {}),
        };
      })
      .filter((item): item is CampaignSummaryWorkItem => item !== null && !!item.text);
    return { items, groups: effectiveGroups };
  };

  const buildPreview = async () => {
    setBusy(true);
    try {
      const manifest = await fetchSourceManifest();
      if (!manifest) return;
      setPreviewManifest(manifest);
      const attachmentLinksByTask = await fetchTaskAttachmentLinks(
        manifest.sources.filter((source) => source.source_kind === 'daily_log').flatMap(linkedTaskIdsOf)
      );
      setDraftText(composeManifestContent(manifest, creatorNote, names, !!selectedSubject && isCreativeReportSubject(selectedSubject), attachmentLinksByTask, undefined, workLogServiceGrouping, effectiveScopeType === 'employee'));
      setActiveWorkLogGroups(undefined);
      creationKey.current = null;
      setMessage(`Preview built from ${manifest.source_count} authorized immutable source(s).`);
    } finally { setBusy(false); }
  };

  // "سحب المصادر من جديد" for an ALREADY-OPEN report: pulls a fresh source snapshot for the same
  // scope/period, but — unlike buildPreview above — never touches draftText and never saves
  // anything by itself. save_report_version_v2 (below) only ever re-saves TEXT under the report's
  // EXISTING source_hash/ledger; it has no way to adopt a new one. So when this fresh manifest's
  // source_hash actually differs from the open report's, the only way to persist it is a NEW
  // report row (saveAsNewDraftFromPulledSources, via create_report_draft_v2 — confirmed allowed:
  // there is no unique constraint on (scope, period) in reports, only on (generated_by,
  // creation_key)). Note: AI Summary no longer builds its work_items from this pulled preview —
  // requestAiSummary below fetches its own fresh manifest on every click instead (see
  // workItemsFromOriginalSources), so this preview is for display/"save as new draft" only.
  const pullSourcesAgain = async () => {
    setBusy(true);
    try {
      const manifest = await fetchSourceManifest();
      if (!manifest) return;
      setPreviewManifest(manifest);
      setMessage(
        selectedReport && manifest.source_hash === selectedReport.source_hash
          ? `A fresh snapshot was pulled but it matches the currently saved sources (${manifest.source_count} source(s)). Nothing new to save.`
          : `A new source snapshot was pulled: ${manifest.source_count} authorized source(s). The draft text has not changed — use AI Summary or edit it manually, then "Save as new draft with these sources" to save it (a new version/report, with its new evidence). Changed your mind? Use "Cancel pull" below to discard this snapshot.`
      );
    } finally { setBusy(false); }
  };

  // Discards a freshly-pulled snapshot (from pullSourcesAgain, or buildPreview's new-draft flow)
  // and returns to exactly the state before that click — previewManifest is the only thing either
  // of those set, so this is simply clearing it back out, plus restoring draftText for the
  // new-draft flow (buildPreview is the only caller that touches draftText from a pull).
  const cancelLastPull = (wasNewDraftFlow: boolean) => {
    setPreviewManifest(null);
    setMessage(null);
    if (wasNewDraftFlow) setDraftText('');
  };

  // Lets the user discard whatever text is currently sitting in the editor (a stale or unwanted
  // AI Summary result, or an in-progress manual edit) and fall back to the last explicitly saved
  // version — NOT to blank — so "Clear AI text" then "AI Summary" reliably starts from a known,
  // saved baseline instead of an empty draft.
  const clearAiText = () => {
    if (!window.confirm('Discard the current draft text and revert to the last saved version?')) return;
    // Reverting to the last saved version also clears any active grouping/rephrase tracking — the
    // saved text has no known association with it (it may predate "Group similar entries"
    // entirely, or reflect a different combination of merges than whatever was just active).
    setDraftTextWithUndo(currentVersion?.content_text || '', undefined);
    setMessage(null);
  };

  // Snapshots the CURRENT draftText and activeWorkLogGroups into the one-step undo slot before
  // replacing them — used by every action that overwrites the whole draft (AI Summary, Group
  // similar entries, Clear AI text) so "Undo" always restores exactly what was there a moment ago,
  // whatever it was, including which lines were merged/rephrased at the time.
  const setDraftTextWithUndo = (next: string, nextGroups: WorkItemGroup[] | undefined) => {
    setUndoSnapshot({ text: draftText, groups: activeWorkLogGroups });
    setDraftText(next);
    setActiveWorkLogGroups(nextGroups);
  };

  const undoLastAiChange = () => {
    if (undoSnapshot === null) return;
    setDraftText(undoSnapshot.text);
    setActiveWorkLogGroups(undoSnapshot.groups);
    setUndoSnapshot(null);
    setMessage(null);
  };

  useEffect(() => {
    // A previously-pulled preview is scoped to whichever report was open when it was fetched —
    // never carry it over to a different report (switching drafts, or opening a different filed
    // report) where it would silently feed the wrong report's AI Summary/"save as new draft". The
    // one-step undo snapshot is scoped the same way — never offer to "undo" into a different
    // report's text. Likewise the active grouping/rephrase tracking is scoped to whichever
    // report's sources it was built from. clientDisplayNameOverride is the same kind of per-report,
    // not-persisted, deliberately throwaway state (see its own declaration below) — reset here too.
    setUndoSnapshot(null);
    setActiveWorkLogGroups(undefined);
    setPreviewManifest(null);
    setClientDisplayNameOverride('');
    if (!selectedReportId) {
      setVersions([]);
      setSources([]);
      setSuggestion(null);
      setIsLoadingDetails(false);
      setDetailsError(null);
      return;
    }
    let cancelled = false;
    setIsLoadingDetails(true);
    setDetailsError(null);
    (async () => {
      const [versionResult, sourceResult, suggestionResult] = await Promise.all([
        supabaseRaw.from('report_content_versions').select('*').eq('report_id', selectedReportId).order('version_no', { ascending: false }),
        supabaseRaw.from('report_source_items').select('*').eq('report_id', selectedReportId).order('source_date'),
        supabaseRaw.from('report_ai_suggestions').select('*').eq('report_id', selectedReportId).eq('status', 'pending').order('created_at', { ascending: false }).limit(1),
      ]);
      if (cancelled) return;
      const error = versionResult.error || sourceResult.error || suggestionResult.error;
      if (error) {
        setDetailsError('Unable to load this report\'s saved content, versions, or source ledger.');
        setIsLoadingDetails(false);
        return;
      }
      const loadedVersions = (versionResult.data || []) as ReportContentVersionRecord[];
      setVersions(loadedVersions);
      setSources((sourceResult.data || []) as ReportSourceItemRecord[]);
      setSuggestion(((suggestionResult.data || [])[0] as ReportAiSuggestionRecord) || null);
      const report = reportsRef.current.find((item) => item.id === selectedReportId);
      const version = loadedVersions.find((item) => item.id === report?.current_version_id) || loadedVersions[0];
      setDraftText(version?.content_text || '');
      setIsLoadingDetails(false);
    })();
    return () => { cancelled = true; };
    // reportsRef (not `reports`) is intentional — see its declaration above. This effect must only
    // re-run when the OPEN report actually changes, never on an unrelated global `reports` refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedReportId]);

  const createDraft = async () => {
    if (!period || !previewManifest || !draftText.trim() || (effectiveScopeType === 'client' ? !clientId : !effectiveSubjectUserId || !effectiveEmployeeScopeMode)) return;
    setBusy(true);
    setMessage(null);
    try {
      const client = clients.find((item) => item.id === clientId);
      creationKey.current ||= crypto.randomUUID();
      const { data, error } = await supabaseRaw.rpc('create_report_draft_v2', {
        p_scope_type: effectiveScopeType,
        p_client_id: effectiveScopeType === 'client' ? clientId : null,
        p_subject_user_id: effectiveScopeType === 'employee' ? effectiveSubjectUserId : null,
        p_responsible_user_id: effectiveScopeType === 'client' ? client?.am_agent_id || null : effectiveSubjectUserId,
        p_employee_scope_mode: effectiveScopeType === 'employee' ? effectiveEmployeeScopeMode : null,
        p_employee_client_ids: effectiveScopeType === 'employee' && effectiveEmployeeScopeMode === 'selected_clients' ? selectedClientIds : [],
        p_period_start: period.startInclusive,
        p_period_end_exclusive: period.endExclusive,
        p_creator_note: creatorNote,
        p_content_text: draftText,
        p_expected_source_hash: previewManifest.source_hash,
        p_creation_key: creationKey.current,
        p_service_filter: effectiveScopeType === 'client' ? clientServiceFilter : null,
      });
      if (error) throw error;
      const report = data as unknown as ReportRecord;
      onReportChanged(report);
      setSelectedReportId(report.id);
      creationKey.current = null;
      setMessage('Draft saved with an immutable source snapshot.');
    } catch {
      setMessage('Unable to save the draft. Confirm the reports migration is applied and your scope is authorized.');
    } finally {
      setBusy(false);
    }
  };

  const saveVersion = async () => {
    if (!selectedReport || !draftText.trim()) return;
    setBusy(true);
    try {
      const { data, error } = await supabaseRaw.rpc('save_report_version_v2', {
        p_report_id: selectedReport.id,
        p_content_text: draftText,
        p_origin: 'manual',
        p_expected_version_id: currentVersion?.id || null,
      });
      if (error) throw error;
      const version = data as unknown as ReportContentVersionRecord;
      setVersions((current) => [version, ...current]);
      onReportChanged({ ...selectedReport, current_version_id: version.id, updated_at: new Date().toISOString() });
      setSuggestion(null);
      setMessage(`Version ${version.version_no} saved.`);
    } catch {
      setMessage('Unable to save this version. Your current editor text has not been cleared.');
    } finally {
      setBusy(false);
    }
  };

  const hasUnsavedChanges = !!draftText.trim() && (!currentVersion || draftText !== currentVersion.content_text);
  const confirmDiscard = () => !hasUnsavedChanges || window.confirm('Discard unsaved editor changes?');

  // save_report_version_v2 only ever re-saves TEXT under the report's EXISTING source_hash/
  // ledger (confirmed in the migration: it copies v_report.source_hash verbatim, never touches
  // report_source_items) — it cannot adopt a freshly-pulled snapshot. So once previewManifest's
  // hash genuinely differs from the open report's, createDraft (confirmed to have no "only when
  // !selectedReport" gate, and no unique constraint on (scope, period) blocks a second report for
  // the same one) is reused as-is to create a NEW report row carrying the new ledger — it already
  // switches selectedReportId to that new report on success.
  const canSaveAsNewDraftFromPulledSources =
    !!selectedReport && !!previewManifest && previewManifest.source_hash !== selectedReport.source_hash
    && !selectedReport.archived_at && selectedReport.status !== 'final';

  const clearSignalSeen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (clearSignal === undefined) return;
    if (clearSignalSeen.current === undefined) {
      clearSignalSeen.current = clearSignal;
      return;
    }
    if (clearSignalSeen.current === clearSignal) return;
    clearSignalSeen.current = clearSignal;
    if (!selectedReportId && !draftText.trim()) return;
    if (!confirmDiscard()) return;
    setSelectedReportId('');
    setDraftText('');
    setPreviewManifest(null);
    setMessage(null);
    // confirmDiscard/hasUnsavedChanges close over draftText/currentVersion on every render; only
    // clearSignal should retrigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSignal]);

  const requestAiSummary = async () => {
    if (!onRequestAiSummary || busy) return;
    if (hasUnsavedChanges && !window.confirm('Replace the current draft text with the AI Summary? Your unsaved manual edits will be lost.')) return;
    setBusy(true);
    setMessage(null);
    try {
      // Every click starts from the live original source records under the RPC's existing RLS
      // checks. Do not reuse previewManifest/sources here: those are useful display and saved
      // evidence snapshots, but are not a cache for a new AI request.
      const manifest = await fetchSourceManifest();
      if (!manifest) return;
      // Build work items from whatever grouping is currently active (undefined the first time —
      // one item per raw log row, same as before this existed) so an earlier "Group similar
      // entries" merge is rephrased as ONE item, not exploded back into its original individual
      // lines.
      const { items: workItems, groups: effectiveGroups } = await workItemsFromOriginalSources(manifest.sources, activeWorkLogGroups);
      const result = await onRequestAiSummary(creatorNote, workItems);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      // Carry the rephrase forward onto the SAME groups (same ids/merges), just with each group's
      // text updated to its freshly rephrased wording — so a later "Group similar entries" groups
      // from this rephrased wording instead of reverting to the raw original log text, and a later
      // AI Summary click still sees (and keeps) this same merge.
      const rephrasedById = new Map<string, string>((result.items || []).map((item) => [item.id, item.text]));
      const nextGroups = effectiveGroups.map((group) => ({ ids: group.ids, text: rephrasedById.get(group.ids[0]) ?? group.text }));
      setDraftTextWithUndo(result.text, nextGroups);
      setPreviewManifest(null);
      setMessage(
        result.partial
          ? 'AI Summary inserted into the draft, but some work-log batches could not be rephrased and were kept in their original wording. Save a version to keep it.'
          : 'AI Summary inserted into the draft. Save a version to keep it.'
      );
    } finally {
      setBusy(false);
    }
  };

  // "Group similar entries" (onGroupWorkItems): fetches a FRESH manifest (same "always fresh,
  // never reused" rule as requestAiSummary/pullSourcesAgain above — never built from
  // previewManifest or the current draftText), asks the AI to find same-employee lines that
  // describe the exact same recurring activity, and re-renders the Work logs section with any
  // confidently-merged groups collapsed into one line with a count. The count is always verified
  // server-side against the real number of ids merged (taskRegistry.ts's WORK_ITEM_GROUP) — this
  // UI never trusts a count the model merely states. A singleton (ungrouped) line is rendered
  // completely unchanged, in its own original wording — this action can only ever merge, never
  // reword, an untouched line. Sets previewManifest exactly like pullSourcesAgain does (so "Save
  // as new draft with these sources" lights up if the source hash changed).
  //
  // Groups from whatever text is currently active for each log (activeWorkLogGroups — a prior AI
  // Summary's rephrase, if one is still active for that exact log, else its raw original wording),
  // not always the raw original: this is what lets grouping run AFTER an AI Summary without
  // reverting every line back to its unrephrased wording. A log that's part of an already-merged,
  // multi-id group has no single well-defined "current text" to hand back per individual id, so
  // that edge case still falls back to each log's raw original text, same as before this existed.
  const groupSimilarEntries = async () => {
    if (!onGroupWorkItems || busy) return;
    if (hasUnsavedChanges && !window.confirm('Replace the current draft text with a grouped version of the fresh work logs? Your unsaved changes will be lost.')) return;
    setBusy(true);
    setMessage(null);
    try {
      const manifest = await fetchSourceManifest();
      if (!manifest) return;
      const logSources = manifest.sources.filter((source) => source.source_kind === 'daily_log');
      const attachmentLinksByTask = await fetchTaskAttachmentLinks(logSources.flatMap(linkedTaskIdsOf));
      const creativeSubject = !!selectedSubject && isCreativeReportSubject(selectedSubject);
      if (!logSources.length) {
        setPreviewManifest(manifest);
        setDraftTextWithUndo(composeManifestContent(manifest, creatorNote, names, creativeSubject, attachmentLinksByTask, undefined, workLogServiceGrouping, effectiveScopeType === 'employee'), undefined);
        setMessage('No work-log lines to group for this period.');
        return;
      }
      const activeTextById = new Map<string, string>();
      (activeWorkLogGroups || []).forEach((group) => {
        if (group.ids.length === 1) activeTextById.set(group.ids[0], group.text);
      });
      const items = logSources
        .map((source) => ({
          id: source.source_id,
          employee: names.get(source.user_id) || undefined,
          text: activeTextById.get(source.source_id) ?? String(source.snapshot.summary_text || '').trim(),
        }))
        .filter((item) => item.text);
      const result = await onGroupWorkItems(items);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setPreviewManifest(manifest);
      setDraftTextWithUndo(composeManifestContent(manifest, creatorNote, names, creativeSubject, attachmentLinksByTask, result.result.groups, workLogServiceGrouping, effectiveScopeType === 'employee'), result.result.groups);
      const mergedCount = result.result.groups.filter((group) => group.ids.length > 1).length;
      setMessage(
        mergedCount
          ? `${mergedCount} group(s) of genuinely repeated work were merged (each count independently verified, never taken on the AI's word). Everything else is unchanged. Save a version to keep it.`
          : 'No confidently repeated work was found to merge — the work logs are unchanged.'
      );
    } finally {
      setBusy(false);
    }
  };

  // "Revert to original sources" (already-open report only): rebuilds the draft text from a
  // FRESH, server-authorized source manifest with NO grouping and NO AI rephrase — i.e. discards
  // whatever "Group similar entries"/"AI Summary" currently has active and gets back to the exact
  // shape a brand-new draft would start from. Unlike "Pull sources again"/pullSourcesAgain (which
  // deliberately never touches draftText — see its own comment, just above), this is the one
  // explicit action for an already-open report that DOES overwrite it, so it gets the same confirm
  // + one-step Undo guard as AI Summary/Group similar entries, and clears activeWorkLogGroups so a
  // later Group/AI Summary click starts clean rather than reusing stale grouping state. Does NOT
  // touch previewManifest/"Save as new draft with these sources" — this action is scoped to the
  // editor text only, never to adopting a new source ledger (use "Pull sources again" for that).
  const revertToOriginalSources = async () => {
    if (busy) return;
    if (hasUnsavedChanges && !window.confirm('Replace the current draft text with the original sources, undoing any grouping or AI rephrasing? Your unsaved changes will be lost.')) return;
    setBusy(true);
    setMessage(null);
    try {
      const manifest = await fetchSourceManifest();
      if (!manifest) return;
      const attachmentLinksByTask = await fetchTaskAttachmentLinks(
        manifest.sources.filter((source) => source.source_kind === 'daily_log').flatMap(linkedTaskIdsOf)
      );
      const creativeSubject = !!selectedSubject && isCreativeReportSubject(selectedSubject);
      setDraftTextWithUndo(
        composeManifestContent(manifest, creatorNote, names, creativeSubject, attachmentLinksByTask, undefined, workLogServiceGrouping, effectiveScopeType === 'employee'),
        undefined
      );
      setMessage('Draft text reverted to the original sources — any grouping or AI rephrasing was discarded. Save a version to keep it.');
    } finally {
      setBusy(false);
    }
  };

  const applySuggestion = async () => {
    if (!suggestion || !selectedReport) return;
    setBusy(true);
    try {
      const { data, error } = await supabaseRaw.rpc('apply_report_ai_suggestion', { p_suggestion_id: suggestion.id });
      if (error) throw error;
      const version = data as unknown as ReportContentVersionRecord;
      setDraftText(version.content_text);
      setVersions((current) => [version, ...current]);
      onReportChanged({ ...selectedReport, current_version_id: version.id, updated_at: new Date().toISOString() });
      setSuggestion(null);
      setMessage(`AI proposal applied as version ${version.version_no}.`);
    } catch {
      setMessage('This proposal is stale or unavailable. No report text was changed.');
    } finally {
      setBusy(false);
    }
  };

  const archiveSelected = async () => {
    if (!selectedReport || busy) return;
    const reason = window.prompt(`Reason for archiving "${reportLabel}":`) ?? '';
    if (!reason.trim()) return;
    setBusy(true);
    try {
      const { data, error } = await supabaseRaw.rpc('archive_report_v2', { p_report_id: selectedReport.id, p_reason: reason, p_restore: false, p_expected_version_id: currentVersion?.id || null });
      if (error) throw error;
      onReportChanged(data as unknown as ReportRecord);
      setMessage('Report archived. Its versions and audit history were preserved.');
    } catch {
      setMessage('Unable to archive this report within your authorized scope.');
    } finally {
      setBusy(false);
    }
  };

  const restoreSelected = async () => {
    if (!selectedReport?.archived_at || busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabaseRaw.rpc('archive_report_v2', {
        p_report_id: selectedReport.id,
        p_reason: '',
        p_restore: true,
        p_expected_version_id: currentVersion?.id || null,
      });
      if (error) throw error;
      onReportChanged(data as unknown as ReportRecord);
      setMessage('Report restored with its versions and audit history intact.');
    } catch {
      setMessage('Unable to restore this report within your authorized scope.');
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (!selectedReport?.archived_at || busy || !['executive', 'head_of_technical'].includes(currentUser.role)) return;
    const reason = window.prompt(`Permanent deletion reason for "${reportLabel}":`) ?? '';
    if (!reason.trim() || !window.confirm(`Permanently delete "${reportLabel}"? Its report content, versions, source snapshots, and report audit events will be removed. Original tasks, activity logs, campaigns, and client data are not deleted. A deletion tombstone remains, but the report cannot be restored.`)) return;
    setBusy(true);
    try {
      const { error } = await supabaseRaw.rpc('delete_report_permanently', {
        p_report_id: selectedReport.id, p_expected_updated_at: selectedReport.updated_at, p_reason: reason,
      });
      if (error) throw error;
      onReportDeleted(selectedReport.id);
      setSelectedReportId('');
      setMessage('Report permanently deleted. An independent deletion tombstone was preserved.');
    } catch { setMessage('Unable to delete. Refresh the archived report and confirm your authorization.'); }
    finally { setBusy(false); }
  };

  const approveSelected = async () => {
    if (!selectedReport || selectedReport.status === 'final') return;
    if (!currentVersion || draftText !== currentVersion.content_text) {
      setMessage('Save the current text as a version before approving the report.');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabaseRaw.rpc('approve_report_v2', { p_report_id: selectedReport.id, p_expected_version_id: currentVersion.id });
      if (error) throw error;
      onReportChanged(data as unknown as ReportRecord);
      setMessage('Report approved and its current saved version marked final.');
    } catch {
      setMessage('Unable to approve this report within your authorized scope.');
    } finally {
      setBusy(false);
    }
  };

  const exportPdf = async () => {
    if (!selectedReport || !currentVersion?.content_text.trim()) return;
    if (draftText !== currentVersion.content_text) {
      setMessage('Save the current text as a version before exporting the PDF.');
      return;
    }
    const subjectName = selectedReport.scope_type === 'employee'
      ? (names.get(selectedReport.subject_user_id || '') || 'Employee')
      : (clientDisplayNameOverride.trim() || clients.find((client) => client.id === selectedReport.client_id)?.name || 'Client');
    const periodRange = formatReportPeriodRange(selectedReport.period || '');
    // parseReportContentIntoParagraphs falls back to the literal heading "Final Report" whenever a
    // report's content_text doesn't match the recognized section shape (see its own comment).
    // Swap that literal for the period-derived Weekly/Monthly/Period label here, right before it's
    // drawn — same resolveReportTypeLabel() the HTML export uses, kept as a display-only rename so
    // parseReportContentIntoParagraphs itself (shared with the HTML path) still produces the
    // original literal string everywhere else that checks for it.
    const dynamicReportTypeLabel = resolveReportTypeLabel(selectedReport.period || '');
    const paragraphs = parseReportContentIntoParagraphs(currentVersion.content_text).map((p) =>
      p.heading === 'Final Report' ? { ...p, heading: dynamicReportTypeLabel } : p
    );
    await downloadReportPdf({
      filename: `report-${selectedReport.period || selectedReport.id}.pdf`,
      title: selectedReport.type === 'client' ? 'Client Report' : 'Employee Report',
      subtitle: `${subjectName} — ${periodRange}`,
      // No "Report Details" block (scope/responsible/evidence count) — the header above already
      // carries everything this PDF is meant to show: client/employee name + period.
      paragraphs,
    });
  };

  // Second export format, requested directly: a self-contained HTML page (branded cards, embedded
  // screenshots) alongside the existing PDF — see reportHtmlExport.ts's own header comment for why
  // this exists as a separate format rather than replacing the PDF. Same save-before-export gate
  // as exportPdf (never exports text that hasn't been saved as a version yet), and reads from the
  // exact same saved `currentVersion.content_text` — no separate live-data path.
  const exportHtml = async () => {
    if (!selectedReport || !currentVersion?.content_text.trim()) return;
    if (draftText !== currentVersion.content_text) {
      setMessage('Save the current text as a version before exporting the HTML report.');
      return;
    }
    const subjectName = selectedReport.scope_type === 'employee'
      ? (names.get(selectedReport.subject_user_id || '') || 'Employee')
      : (clientDisplayNameOverride.trim() || clients.find((client) => client.id === selectedReport.client_id)?.name || 'Client');
    const periodRange = formatReportPeriodRange(selectedReport.period || '');
    const html = await buildIndividualReportHtml({
      // Title is the actual client/employee name now, not the literal word "Client"/"Employee" —
      // the eyebrow line just above it already says which kind of report this is.
      title: subjectName,
      eyebrow: `${selectedReport.type === 'client' ? 'Client Report' : 'Employee Report'} — KESRA Management System`,
      // Plain-text fallback only — buildIndividualReportHtml prefers the bold "From … To …" line it
      // derives itself from `period` whenever that parses, and falls back to this string otherwise
      // (e.g. a legacy report whose period field is somehow empty).
      subtitle: periodRange,
      contentText: currentVersion.content_text,
      period: selectedReport.period || '',
    });
    downloadHtmlReport(html, `report-${selectedReport.period || selectedReport.id}.html`);
  };

  return (
    <section ref={workspaceRef} className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-4 scroll-mt-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 dir="auto" className="text-xs font-bold text-white flex items-center gap-2">
          <FilePenLine className="w-4 h-4 text-purple-400" />
          {selectedReport
            ? <><bdi>{reportSubjectName}</bdi> — {formatPeriodLabel(selectedReport.period)}<span className={selectedReport.archived_at ? 'text-stone-400' : selectedReport.status === 'final' ? 'text-emerald-300' : 'text-amber-300'}> · {selectedReport.archived_at ? 'archived' : selectedReport.status || 'legacy'}</span></>
            : 'New draft'}
        </h3>
      </div>

      {!selectedReport && (
        <div className="space-y-3">
          {scopeKind === 'employee' && (
            <div className="space-y-3">
              <select value={employeeScopeMode} onChange={(event) => { if (confirmDiscard()) { onEmployeeScopeModeChange(event.target.value as EmployeeClientScopeMode | ''); onSelectedClientIdsChange([]); setDraftText(''); setPreviewManifest(null); setActiveWorkLogGroups(undefined); } }} className="w-full px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white"><option value="">Select client scope (required)</option><option value="all_clients">All Clients</option><option value="selected_clients">Selected Clients</option><option value="employee_overall">Employee Overall</option></select>
              {employeeScopeMode === 'selected_clients' && <div className="p-3 rounded-xl border border-purple-900/40 space-y-2">
                <input value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} placeholder="Search clients" className="w-full px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
                <div className="flex gap-2"><button onClick={() => { onSelectedClientIdsChange(clients.map((client) => client.id)); setPreviewManifest(null); setActiveWorkLogGroups(undefined); }} className="text-xs text-purple-300">Select All</button><button onClick={() => { onSelectedClientIdsChange([]); setPreviewManifest(null); setActiveWorkLogGroups(undefined); }} className="text-xs text-stone-400">Clear All</button></div>
                <div className="max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1">{clients.filter((client) => client.name.toLowerCase().includes(clientSearch.toLowerCase())).map((client) => <label key={client.id} className="flex items-center gap-2 text-xs text-stone-300"><input type="checkbox" checked={selectedClientIds.includes(client.id)} onChange={(event) => { onSelectedClientIdsChange(event.target.checked ? [...new Set([...selectedClientIds, client.id])] : selectedClientIds.filter((id) => id !== client.id)); setPreviewManifest(null); }} />{client.name}</label>)}</div>
              </div>}
              {employeeScopeMode && <p className="text-[11px] text-stone-400">Scope: {employeeScopeMode === 'all_clients' ? 'all authorized client-associated work' : employeeScopeMode === 'employee_overall' ? 'all eligible employee work, including non-client records' : `${selectedClientIds.length} selected client(s)`}</p>}
            </div>
          )}
          <textarea value={creatorNote} onChange={(event) => { setCreatorNote(event.target.value); setPreviewManifest(null); }} placeholder="Editorial guidance for AI Summary — focus, tone, or ordering only (never adds numbers or facts). Saved with this draft." className="w-full min-h-20 px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
          <div className="flex gap-2 items-center flex-wrap"><button disabled={busy} onClick={buildPreview} className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white disabled:opacity-50">Pull sources again</button>{onGroupWorkItems && <button disabled={busy} onClick={groupSimilarEntries} title="Merge genuinely repeated same-employee work-log lines into one line with a verified count" className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-950/40 text-indigo-200 border border-indigo-800/40 disabled:opacity-50">Group similar entries</button>}{previewManifest && <button disabled={busy} onClick={() => cancelLastPull(true)} title="Discard this pulled snapshot and clear the draft" className="px-2 py-2 rounded-lg text-xs font-bold bg-stone-900 text-stone-300 border border-stone-700 disabled:opacity-50">✕ Cancel pull</button>}{undoSnapshot !== null && <button disabled={busy} onClick={undoLastAiChange} title="Restore the draft text exactly as it was before the last Group similar entries action" className="px-2 py-2 rounded-lg text-xs font-bold bg-stone-900 text-stone-300 border border-stone-700 disabled:opacity-50">↶ Undo</button>}<span className="text-[11px] text-stone-400 self-center">{preview.dailyLogs.length} visible work logs · {preview.tasks.length} evidenced tasks · {preview.extraNotes.length} employee notes · Fridays excluded</span></div>
        </div>
      )}

      {/* Always visible for an already-open report (point أ of the fix): previously this button
          only existed in the !selectedReport branch above, so once the top bar auto-opened a
          matching draft, there was no way to re-pull fresh sources for it at all. Never touches
          draftText by itself — see pullSourcesAgain's own comment. */}
      {selectedReport && (
        <div className="flex items-center gap-2 flex-wrap">
          <button disabled={busy || !!selectedReport.archived_at || selectedReport.status === 'final'} onClick={pullSourcesAgain} className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white disabled:opacity-50">Pull sources again</button>
          {onGroupWorkItems && (
            <button disabled={busy || !!selectedReport.archived_at || selectedReport.status === 'final'} onClick={groupSimilarEntries} title="Merge genuinely repeated same-employee work-log lines into one line with a verified count" className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-950/40 text-indigo-200 border border-indigo-800/40 disabled:opacity-50">Group similar entries</button>
          )}
          <button disabled={busy || !!selectedReport.archived_at || selectedReport.status === 'final'} onClick={revertToOriginalSources} title="Rebuild the draft text from the original sources, discarding any grouping or AI rephrasing currently applied" className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-900 text-stone-200 border border-stone-700 disabled:opacity-50">Revert to original sources</button>
          {previewManifest && (
            <button disabled={busy} onClick={() => cancelLastPull(false)} title="Discard this pulled snapshot (the draft text is untouched either way)" className="px-2 py-2 rounded-lg text-xs font-bold bg-stone-900 text-stone-300 border border-stone-700 disabled:opacity-50">✕ Cancel pull</button>
          )}
          <span className="text-[11px] text-stone-400">{preview.dailyLogs.length} visible work logs · {preview.tasks.length} evidenced tasks · {preview.extraNotes.length} employee notes · Fridays excluded</span>
          {canSaveAsNewDraftFromPulledSources && (
            <button disabled={busy || !draftText.trim()} onClick={createDraft} className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-900/50 text-indigo-200 disabled:opacity-50"><Save className="w-3.5 h-3.5 inline mr-1" />Save as new draft with these sources</button>
          )}
        </div>
      )}

      {isLoadingDetails ? (
        <div className="min-h-56 rounded-xl border border-purple-900/50 bg-[#100c1c] flex items-center justify-center text-xs text-stone-400">Loading saved report content…</div>
      ) : detailsError ? (
        <div className="min-h-32 rounded-xl border border-red-900/50 bg-red-950/20 flex items-center justify-center text-xs text-red-200 px-4 text-center">{detailsError}</div>
      ) : (
        <textarea dir="auto" readOnly={selectedReport?.status === 'final' || !!selectedReport?.archived_at} value={draftText} onChange={(event) => setDraftText(event.target.value)} placeholder="Pull sources or select a saved report" className="w-full min-h-56 px-3 py-3 rounded-xl text-sm bg-[#100c1c] border border-purple-900/50 text-white read-only:text-stone-200 read-only:cursor-default" />
      )}

      {/* Live preview of the draft text above — shows exactly what the PDF/HTML export will
          produce (real image thumbnails, short "View attachment" links) instead of the raw
          150+ character signed URLs the textarea itself displays. See ReportContentPreview.tsx. */}
      {!isLoadingDetails && !detailsError && draftText.trim() && (
        <details className="rounded-xl border border-purple-900/30 bg-stone-950/30 p-3">
          <summary className="cursor-pointer text-[11px] font-bold text-purple-200">Live preview (as it will appear in the export)</summary>
          <div className="mt-2"><ReportContentPreview contentText={draftText} /></div>
        </details>
      )}

      <div className="flex flex-wrap gap-2">
        {!selectedReport ? <button disabled={busy || !draftText.trim() || !previewManifest} onClick={createDraft} className="filled-purple-action px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"><Save className="w-3.5 h-3.5 inline mr-1" />Save draft</button> : <>
          <button disabled={busy || !!selectedReport.archived_at || selectedReport.status === 'final'} onClick={saveVersion} className="filled-purple-action px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"><Save className="w-3.5 h-3.5 inline mr-1" />Save version</button>
          {onRequestAiSummary && (
            <button disabled={busy || !!selectedReport.archived_at || selectedReport.status === 'final'} onClick={requestAiSummary} className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-900/50 text-indigo-200 disabled:opacity-50"><Sparkles className="w-3.5 h-3.5 inline mr-1" />AI Summary</button>
          )}
          {hasUnsavedChanges && !selectedReport.archived_at && selectedReport.status !== 'final' && (
            <button disabled={busy} onClick={clearAiText} title="Discard the current draft text and revert to the last saved version" className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-900 text-stone-300 border border-stone-700 disabled:opacity-50">✕ Clear AI text</button>
          )}
          {undoSnapshot !== null && !selectedReport.archived_at && selectedReport.status !== 'final' && (
            <button disabled={busy} onClick={undoLastAiChange} title="Restore the draft text exactly as it was before the last AI Summary / Group similar entries / Clear AI text action" className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-900 text-stone-300 border border-stone-700 disabled:opacity-50">↶ Undo</button>
          )}
          {selectedReport.status !== 'final' && <button disabled={busy || !!selectedReport.archived_at} onClick={approveSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-emerald-950/50 text-emerald-200 disabled:opacity-50"><CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />Approve final</button>}
          {selectedReport.scope_type === 'client' && (
            <input
              type="text"
              value={clientDisplayNameOverride}
              onChange={(e) => setClientDisplayNameOverride(e.target.value)}
              placeholder={`Name in PDF/HTML (optional) — default: ${clients.find((c) => c.id === selectedReport.client_id)?.name || 'Client'}`}
              title="Overrides only how the client's name appears in the exported PDF/HTML — not saved, type it again next time"
              className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white placeholder-stone-500 w-64 focus:outline-none focus:border-purple-400"
            />
          )}
          <button onClick={exportPdf} className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white"><Download className="w-3.5 h-3.5 inline mr-1" />PDF</button>
          <button onClick={exportHtml} title="Branded HTML report (cards, embedded screenshots) — a second format alongside PDF" className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white"><Download className="w-3.5 h-3.5 inline mr-1" />HTML</button>
          {selectedReport.archived_at
            ? <><button disabled={busy} onClick={restoreSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-emerald-950/50 text-emerald-200 disabled:opacity-50"><Archive className="w-3.5 h-3.5 inline mr-1" />Restore</button>{['executive', 'head_of_technical'].includes(currentUser.role) && <button disabled={busy} onClick={deleteSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-red-950/50 text-red-200 disabled:opacity-50"><Trash2 className="w-3.5 h-3.5 inline mr-1" />Delete permanently</button>}</>
            : <button disabled={busy} onClick={archiveSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-amber-950/50 text-amber-200 disabled:opacity-50"><Archive className="w-3.5 h-3.5 inline mr-1" />Archive</button>}
        </>}
      </div>

      {/* A pending suggestion from a PRIOR REPORT_REWRITE request (created before the Suggest
          rewrite button was removed from this UI) can still be reviewed/applied here — only the
          button that CREATES a new one is gone; apply_report_ai_suggestion itself is untouched. */}
      {suggestion && selectedReport?.status !== 'final' && !selectedReport?.archived_at && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-3 rounded-xl border border-indigo-800/40 bg-indigo-950/20">
          <div><p className="text-xs font-bold text-stone-300 mb-2">Current text</p><pre dir="auto" className="whitespace-pre-wrap break-words text-xs text-stone-300">{draftText}</pre></div>
          <div><p className="text-xs font-bold text-indigo-200 mb-2">AI proposal</p><pre dir="auto" className="whitespace-pre-wrap break-words text-xs text-stone-200">{suggestion.suggested_text}</pre><div className="flex gap-2 mt-3"><button disabled={busy} onClick={applySuggestion} className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-600 text-white"><Sparkles className="w-3.5 h-3.5 inline mr-1" />Apply as new version</button><button onClick={() => setSuggestion(null)} className="px-3 py-2 rounded-lg text-xs bg-stone-800 text-stone-300">Keep current</button></div></div>
        </div>
      )}
      {selectedReport && !isLoadingDetails && !detailsError && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <details className="rounded-xl border border-purple-900/30 bg-stone-950/30 p-3">
            <summary className="cursor-pointer text-xs font-bold text-purple-200">Version history ({versions.length})</summary>
            {versions.length === 0 ? <p className="text-[11px] text-stone-500 mt-2">No saved content versions are available for this record.</p> : (
              <div className="space-y-2 mt-2">{versions.map((version) => (
                <details key={version.id} className="rounded-lg border border-stone-800 p-2">
                  <summary className="cursor-pointer text-[11px] text-stone-300">v{version.version_no} · {version.origin.replace('_', ' ')}{version.id === selectedReport.current_version_id ? ' · current' : ''}{version.created_at ? ` · ${new Date(version.created_at).toLocaleString()}` : ''}</summary>
                  <div className="mt-2"><ReportContentPreview contentText={version.content_text} /></div>
                </details>
              ))}</div>
            )}
          </details>
          <details className="rounded-xl border border-purple-900/30 bg-stone-950/30 p-3">
            <summary className="cursor-pointer text-xs font-bold text-purple-200">Saved source ledger ({sources.length})</summary>
            {sources.length === 0 ? <p className="text-[11px] text-stone-500 mt-2">No immutable source items are available for this legacy record.</p> : (
              <div className="space-y-1.5 mt-2">{sources.map((source) => (
                <div key={source.id} className="rounded-lg border border-stone-800 p-2 text-[11px] text-stone-300">
                  <span className="font-semibold text-white">{source.source_kind.replace('_', ' ')}</span> · {source.source_date} · {names.get(source.user_id) || 'Employee'}
                  <span className="block text-stone-500 font-mono break-all">{source.source_id}</span>
                </div>
              ))}</div>
            )}
          </details>
        </div>
      )}
      {message && <p className="text-xs text-amber-200">{message}</p>}
    </section>
  );
};
