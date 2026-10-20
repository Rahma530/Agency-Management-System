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
  TaskAssigneeRecord,
  TaskAttachmentRecord,
  TaskRecord,
  UserRecord,
} from '../../types/database';
import { supabase, supabaseRaw } from '../../lib/supabase';
import { formatLocalCalendarDate, resolveReportPeriod } from '../../lib/reportPeriods';
import {
  collectClientReportSources, collectEmployeeReportSources, EmployeeClientScopeMode,
} from '../../lib/reportDraftSources';
import { downloadReportPdf } from '../../lib/pdfExport';
import { isCreativeReportSubject } from '../../lib/reportAgentEligibility';
import { extractLinks } from '../../lib/textLinks';
import { CampaignSummaryWorkItem, formatPeriodLabel } from './ComparisonDisplay';

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
  ) => Promise<{ ok: true; text: string; partial?: boolean } | { ok: false; message: string }>;
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

function composeManifestContent(
  manifest: SourceManifest,
  creatorNote: string,
  names: Map<string, string>,
  creative: boolean,
  attachmentLinksByTask: Map<string, string[]>
): string {
  const logs = manifest.sources.filter((source) => source.source_kind === 'daily_log');
  const notes = manifest.sources.filter((source) => source.source_kind === 'extra_note');
  const tasks = manifest.sources.filter((source) => source.source_kind === 'task');
  const sections: string[] = [];
  if (logs.length) sections.push(`Work logs (primary source)\n${logs.map((source) => {
    const line = `${names.get(source.user_id) || 'Employee'}: ${String(source.snapshot.summary_text || '').trim()}`;
    const attachmentLines = linkedTaskIdsOf(source).flatMap((taskId) => attachmentLinksByTask.get(taskId) || []);
    return attachmentLines.length ? [line, ...attachmentLines].join('\n') : line;
  }).join('\n')}`);
  if (creative && tasks.length) {
    const count = (kind: string) => tasks.filter((source) => source.snapshot.work_kind === kind).length;
    sections.push(`Creative task evidence summary\nDesign tasks evidenced by linked work logs: ${count('design')}\nVideo tasks evidenced by linked work logs: ${count('video')}\nMixed or unclassified tasks requiring review: ${count('mixed') + count('unclassified')}`);
  }
  if (tasks.length) sections.push(`Task evidence ledger (not additional work items)\n${tasks.map((source) => `${String(source.snapshot.title || 'Task')} — ${String(source.snapshot.work_kind || 'unclassified')} (content-inferred); status: ${String(source.snapshot.status || '')}; linked log dates: ${Array.isArray(source.snapshot.evidence_dates) ? source.snapshot.evidence_dates.join(', ') : source.source_date}`).join('\n')}`);
  if (notes.length) sections.push(`Additional employee context\n${notes.map((source) => `${source.source_date} — ${String(source.snapshot.note_text || '').trim()}`).join('\n')}`);
  if (creatorNote.trim()) sections.push(`Context and observations\n${creatorNote.trim()}`);
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
  periodStart,
  onPeriodStartChange,
  periodEnd,
  onPeriodEndChange,
  onRequestAiSummary,
  clearSignal,
}) => {
  // scopeKind 'own' always resolves to the current user's own employee-overall-all-clients work
  // — the same p_scope_type:'employee' shape as a manually picked employee, just with
  // subjectUserId/employeeScopeMode pinned rather than offered as pickers.
  const effectiveScopeType: 'client' | 'employee' = scopeKind === 'client' ? 'client' : 'employee';
  const effectiveSubjectUserId = scopeKind === 'own' ? currentUser.id : subjectUserId;
  const effectiveEmployeeScopeMode: EmployeeClientScopeMode | '' = scopeKind === 'own' ? 'all_clients' : employeeScopeMode;

  const [clientSearch, setClientSearch] = useState('');
  const [creatorNote, setCreatorNote] = useState('');
  const [draftText, setDraftText] = useState('');
  const [selectedReportId, setSelectedReportId] = useState('');
  const [versions, setVersions] = useState<ReportContentVersionRecord[]>([]);
  const [sources, setSources] = useState<ReportSourceItemRecord[]>([]);
  const [suggestion, setSuggestion] = useState<ReportAiSuggestionRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [previewManifest, setPreviewManifest] = useState<SourceManifest | null>(null);
  const creationKey = useRef<string | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);

  const selectedReport = reports.find((report) => report.id === selectedReportId) || null;
  const currentVersion = selectedReport
    ? versions.find((version) => version.id === selectedReport.current_version_id) || versions[0] || null
    : null;
  const names = useMemo(() => new Map(users.map((user) => [user.id, user.name])), [users]);
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
      return { dailyLogs: result.dailyLogs, extraNotes: [] as ExtraNoteRecord[], tasks: [] };
    }
    return collectEmployeeReportSources(dailyLogs, extraNotes, tasks, taskAssignees, effectiveSubjectUserId, period, {
      mode: effectiveEmployeeScopeMode || 'employee_overall',
      clientIds: effectiveEmployeeScopeMode === 'selected_clients' ? selectedClientIds : clients.map((client) => client.id),
    });
  }, [period, effectiveScopeType, clientId, effectiveSubjectUserId, effectiveEmployeeScopeMode, selectedClientIds, clients, dailyLogs, extraNotes, tasks, taskAssignees]);

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
  const workItemsFromOriginalSources = async (
    sourceList: Array<Pick<ReportSourceItemRecord, 'source_kind' | 'source_id' | 'user_id' | 'snapshot'>>
  ): Promise<CampaignSummaryWorkItem[]> => {
    const logSources = sourceList.filter((source) => source.source_kind === 'daily_log');
    const attachmentLinksByTask = await fetchTaskAttachmentLinks(logSources.flatMap(linkedTaskIdsOf));
    return logSources
      .map((source) => {
        const { cleanText, links } = extractLinks(String(source.snapshot.summary_text || '').trim());
        const attachmentLinks = linkedTaskIdsOf(source).flatMap((taskId) => attachmentLinksByTask.get(taskId) || []);
        const allLinks = [...links, ...attachmentLinks];
        return {
          id: source.source_id,
          employee: names.get(source.user_id) || undefined,
          text: cleanText,
          ...(allLinks.length ? { links: allLinks } : {}),
        };
      })
      .filter((item) => item.text);
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
      setDraftText(composeManifestContent(manifest, creatorNote, names, !!selectedSubject && isCreativeReportSubject(selectedSubject), attachmentLinksByTask));
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
    setDraftText(currentVersion?.content_text || '');
    setMessage(null);
  };

  useEffect(() => {
    // A previously-pulled preview is scoped to whichever report was open when it was fetched —
    // never carry it over to a different report (switching drafts, or opening a different filed
    // report) where it would silently feed the wrong report's AI Summary/"save as new draft".
    setPreviewManifest(null);
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
      const report = reports.find((item) => item.id === selectedReportId);
      const version = loadedVersions.find((item) => item.id === report?.current_version_id) || loadedVersions[0];
      setDraftText(version?.content_text || '');
      setIsLoadingDetails(false);
    })();
    return () => { cancelled = true; };
  }, [selectedReportId, reports]);

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
      const workItems = await workItemsFromOriginalSources(manifest.sources);
      const result = await onRequestAiSummary(creatorNote, workItems);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setDraftText(result.text);
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
      : (clients.find((client) => client.id === selectedReport.client_id)?.name || 'Client');
    const [periodFrom, periodTo] = (selectedReport.period || '').split('_');
    const periodRange = periodTo ? `${periodFrom} to ${periodTo}` : (selectedReport.period || '');
    await downloadReportPdf({
      filename: `report-${selectedReport.period || selectedReport.id}.pdf`,
      title: selectedReport.type === 'client' ? 'Client Report' : 'Employee Report',
      subtitle: `${subjectName} — ${periodRange}`,
      // No "Report Details" block (scope/responsible/evidence count) — the header above already
      // carries everything this PDF is meant to show: client/employee name + period.
      paragraphs: [
        { heading: 'Final Report', body: currentVersion.content_text },
      ],
    });
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
              <select value={employeeScopeMode} onChange={(event) => { if (confirmDiscard()) { onEmployeeScopeModeChange(event.target.value as EmployeeClientScopeMode | ''); onSelectedClientIdsChange([]); setDraftText(''); setPreviewManifest(null); } }} className="w-full px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white"><option value="">Select client scope (required)</option><option value="all_clients">All Clients</option><option value="selected_clients">Selected Clients</option><option value="employee_overall">Employee Overall</option></select>
              {employeeScopeMode === 'selected_clients' && <div className="p-3 rounded-xl border border-purple-900/40 space-y-2">
                <input value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} placeholder="Search clients" className="w-full px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
                <div className="flex gap-2"><button onClick={() => { onSelectedClientIdsChange(clients.map((client) => client.id)); setPreviewManifest(null); }} className="text-xs text-purple-300">Select All</button><button onClick={() => { onSelectedClientIdsChange([]); setPreviewManifest(null); }} className="text-xs text-stone-400">Clear All</button></div>
                <div className="max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1">{clients.filter((client) => client.name.toLowerCase().includes(clientSearch.toLowerCase())).map((client) => <label key={client.id} className="flex items-center gap-2 text-xs text-stone-300"><input type="checkbox" checked={selectedClientIds.includes(client.id)} onChange={(event) => { onSelectedClientIdsChange(event.target.checked ? [...new Set([...selectedClientIds, client.id])] : selectedClientIds.filter((id) => id !== client.id)); setPreviewManifest(null); }} />{client.name}</label>)}</div>
              </div>}
              {employeeScopeMode && <p className="text-[11px] text-stone-400">Scope: {employeeScopeMode === 'all_clients' ? 'all authorized client-associated work' : employeeScopeMode === 'employee_overall' ? 'all eligible employee work, including non-client records' : `${selectedClientIds.length} selected client(s)`}</p>}
            </div>
          )}
          <textarea value={creatorNote} onChange={(event) => { setCreatorNote(event.target.value); setPreviewManifest(null); }} placeholder="Editorial guidance for AI Summary — focus, tone, or ordering only (never adds numbers or facts). Saved with this draft." className="w-full min-h-20 px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
          <div className="flex gap-2 items-center flex-wrap"><button disabled={busy} onClick={buildPreview} className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white disabled:opacity-50">Pull sources again</button>{previewManifest && <button disabled={busy} onClick={() => cancelLastPull(true)} title="Discard this pulled snapshot and clear the draft" className="px-2 py-2 rounded-lg text-xs font-bold bg-stone-900 text-stone-300 border border-stone-700 disabled:opacity-50">✕ Cancel pull</button>}<span className="text-[11px] text-stone-400 self-center">{preview.dailyLogs.length} visible work logs · {preview.tasks.length} evidenced tasks · {preview.extraNotes.length} employee notes · Fridays excluded</span></div>
        </div>
      )}

      {/* Always visible for an already-open report (point أ of the fix): previously this button
          only existed in the !selectedReport branch above, so once the top bar auto-opened a
          matching draft, there was no way to re-pull fresh sources for it at all. Never touches
          draftText by itself — see pullSourcesAgain's own comment. */}
      {selectedReport && (
        <div className="flex items-center gap-2 flex-wrap">
          <button disabled={busy || !!selectedReport.archived_at || selectedReport.status === 'final'} onClick={pullSourcesAgain} className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white disabled:opacity-50">Pull sources again</button>
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

      <div className="flex flex-wrap gap-2">
        {!selectedReport ? <button disabled={busy || !draftText.trim() || !previewManifest} onClick={createDraft} className="filled-purple-action px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"><Save className="w-3.5 h-3.5 inline mr-1" />Save draft</button> : <>
          <button disabled={busy || !!selectedReport.archived_at || selectedReport.status === 'final'} onClick={saveVersion} className="filled-purple-action px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"><Save className="w-3.5 h-3.5 inline mr-1" />Save version</button>
          {onRequestAiSummary && (
            <button disabled={busy || !!selectedReport.archived_at || selectedReport.status === 'final'} onClick={requestAiSummary} className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-900/50 text-indigo-200 disabled:opacity-50"><Sparkles className="w-3.5 h-3.5 inline mr-1" />AI Summary</button>
          )}
          {hasUnsavedChanges && !selectedReport.archived_at && selectedReport.status !== 'final' && (
            <button disabled={busy} onClick={clearAiText} title="Discard the current draft text and revert to the last saved version" className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-900 text-stone-300 border border-stone-700 disabled:opacity-50">✕ Clear AI text</button>
          )}
          {selectedReport.status !== 'final' && <button disabled={busy || !!selectedReport.archived_at} onClick={approveSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-emerald-950/50 text-emerald-200 disabled:opacity-50"><CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />Approve final</button>}
          <button onClick={exportPdf} className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white"><Download className="w-3.5 h-3.5 inline mr-1" />PDF</button>
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
          <div><p className="text-xs font-bold text-stone-300 mb-2">Current text</p><pre dir="auto" className="whitespace-pre-wrap text-xs text-stone-300">{draftText}</pre></div>
          <div><p className="text-xs font-bold text-indigo-200 mb-2">AI proposal</p><pre dir="auto" className="whitespace-pre-wrap text-xs text-stone-200">{suggestion.suggested_text}</pre><div className="flex gap-2 mt-3"><button disabled={busy} onClick={applySuggestion} className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-600 text-white"><Sparkles className="w-3.5 h-3.5 inline mr-1" />Apply as new version</button><button onClick={() => setSuggestion(null)} className="px-3 py-2 rounded-lg text-xs bg-stone-800 text-stone-300">Keep current</button></div></div>
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
                  <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] text-stone-300">{version.content_text}</pre>
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
