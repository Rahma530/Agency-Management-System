import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Bot, CheckCircle2, Download, FilePenLine, Save, Sparkles, Trash2 } from 'lucide-react';
import {
  ClientRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  ReportAiSuggestionRecord,
  ReportContentVersionRecord,
  ReportRecord,
  ReportSourceItemRecord,
  TaskAssigneeRecord,
  TaskRecord,
  UserRecord,
} from '../../types/database';
import { supabaseRaw } from '../../lib/supabase';
import { formatLocalCalendarDate, resolveReportPeriod } from '../../lib/reportPeriods';
import {
  collectClientReportSources, collectEmployeeReportSources, EmployeeClientScopeMode,
} from '../../lib/reportDraftSources';
import { downloadReportPdf } from '../../lib/pdfExport';
import { isCreativeReportSubject, isEligibleReportSubject } from '../../lib/reportAgentEligibility';

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
  onReportChanged: (report: ReportRecord) => void;
  onReportDeleted: (reportId: string) => void;
}

const today = () => formatLocalCalendarDate(new Date());
const monthStart = () => `${today().slice(0, 8)}01`;

interface SourceManifest { source_hash: string; source_count: number; sources: Array<Omit<ReportSourceItemRecord, 'id' | 'report_id'>> }

function composeManifestContent(manifest: SourceManifest, creatorNote: string, names: Map<string, string>, creative: boolean): string {
  const logs = manifest.sources.filter((source) => source.source_kind === 'daily_log');
  const notes = manifest.sources.filter((source) => source.source_kind === 'extra_note');
  const tasks = manifest.sources.filter((source) => source.source_kind === 'task');
  const sections: string[] = [];
  if (logs.length) sections.push(`Work logs (primary source)\n${logs.map((source) => `${source.source_date} — ${names.get(source.user_id) || 'Employee'}: ${String(source.snapshot.summary_text || '').trim()}`).join('\n')}`);
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
  onReportChanged,
  onReportDeleted,
}) => {
  const [scopeType, setScopeType] = useState<'client' | 'employee'>('client');
  const [clientId, setClientId] = useState('');
  const [subjectUserId, setSubjectUserId] = useState('');
  const [employeeScopeMode, setEmployeeScopeMode] = useState<EmployeeClientScopeMode | ''>('');
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const [clientSearch, setClientSearch] = useState('');
  const [periodStart, setPeriodStart] = useState(monthStart());
  const [periodEnd, setPeriodEnd] = useState(today());
  const [creatorNote, setCreatorNote] = useState('');
  const [draftText, setDraftText] = useState('');
  const [selectedReportId, setSelectedReportId] = useState('');
  const [versions, setVersions] = useState<ReportContentVersionRecord[]>([]);
  const [sources, setSources] = useState<ReportSourceItemRecord[]>([]);
  const [suggestion, setSuggestion] = useState<ReportAiSuggestionRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [previewManifest, setPreviewManifest] = useState<SourceManifest | null>(null);
  const creationKey = useRef<string | null>(null);

  const selectedReport = reports.find((report) => report.id === selectedReportId) || null;
  const currentVersion = selectedReport
    ? versions.find((version) => version.id === selectedReport.current_version_id) || versions[0] || null
    : null;
  const names = useMemo(() => new Map(users.map((user) => [user.id, user.name])), [users]);
  const selectedSubject = users.find((user) => user.id === subjectUserId);
  const employeeOptions = useMemo(() => {
    const map = new Map<string, UserRecord>();
    if (isEligibleReportSubject(currentUser)) map.set(currentUser.id, currentUser);
    employees.forEach((employee) => map.set(employee.id, employee));
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [currentUser, employees]);

  const period = useMemo(() => {
    try {
      return resolveReportPeriod(periodStart, periodEnd);
    } catch {
      return null;
    }
  }, [periodStart, periodEnd]);

  const preview = useMemo(() => {
    if (!period) return { dailyLogs: [] as DailyLogRecord[], extraNotes: [] as ExtraNoteRecord[], tasks: [] };
    if (scopeType === 'client') {
      const result = collectClientReportSources(dailyLogs, clientId, period);
      return { dailyLogs: result.dailyLogs, extraNotes: [] as ExtraNoteRecord[], tasks: [] };
    }
    return collectEmployeeReportSources(dailyLogs, extraNotes, tasks, taskAssignees, subjectUserId, period, {
      mode: employeeScopeMode || 'employee_overall',
      clientIds: employeeScopeMode === 'selected_clients' ? selectedClientIds : clients.map((client) => client.id),
    });
  }, [period, scopeType, clientId, subjectUserId, employeeScopeMode, selectedClientIds, clients, dailyLogs, extraNotes, tasks, taskAssignees]);

  const buildPreview = async () => {
    if (!period || (scopeType === 'client' ? !clientId : !subjectUserId || !employeeScopeMode || (employeeScopeMode === 'selected_clients' && !selectedClientIds.length))) {
      setMessage('Choose the report subject, period, and an explicit employee client scope first.');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabaseRaw.rpc('preview_report_sources_v2', {
        p_scope_type: scopeType, p_client_id: scopeType === 'client' ? clientId : null,
        p_subject_user_id: scopeType === 'employee' ? subjectUserId : null,
        p_employee_scope_mode: scopeType === 'employee' ? employeeScopeMode : null,
        p_employee_client_ids: scopeType === 'employee' && employeeScopeMode === 'selected_clients' ? selectedClientIds : [],
        p_period_start: period.startInclusive, p_period_end_exclusive: period.endExclusive,
      });
      if (error) throw error;
      const manifest = data as unknown as SourceManifest;
      setPreviewManifest(manifest);
      setDraftText(composeManifestContent(manifest, creatorNote, names, !!selectedSubject && isCreativeReportSubject(selectedSubject)));
      creationKey.current = null;
      setMessage(`Preview built from ${manifest.source_count} authorized immutable source(s).`);
    } catch {
      setMessage('Unable to build the server-authorized source preview. Confirm the lifecycle migration is applied.');
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!selectedReportId) {
      setVersions([]);
      setSources([]);
      setSuggestion(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const [versionResult, sourceResult, suggestionResult] = await Promise.all([
        supabaseRaw.from('report_content_versions').select('*').eq('report_id', selectedReportId).order('version_no', { ascending: false }),
        supabaseRaw.from('report_source_items').select('*').eq('report_id', selectedReportId).order('source_date'),
        supabaseRaw.from('report_ai_suggestions').select('*').eq('report_id', selectedReportId).eq('status', 'pending').order('created_at', { ascending: false }).limit(1),
      ]);
      if (cancelled) return;
      const error = versionResult.error || sourceResult.error || suggestionResult.error;
      if (error) {
        setMessage('Report storage is not available yet. Apply the approved reports migration first.');
        return;
      }
      const loadedVersions = (versionResult.data || []) as ReportContentVersionRecord[];
      setVersions(loadedVersions);
      setSources((sourceResult.data || []) as ReportSourceItemRecord[]);
      setSuggestion(((suggestionResult.data || [])[0] as ReportAiSuggestionRecord) || null);
      const report = reports.find((item) => item.id === selectedReportId);
      const version = loadedVersions.find((item) => item.id === report?.current_version_id) || loadedVersions[0];
      setDraftText(version?.content_text || '');
    })();
    return () => { cancelled = true; };
  }, [selectedReportId, reports]);

  const createDraft = async () => {
    if (!period || !previewManifest || !draftText.trim() || (scopeType === 'client' ? !clientId : !subjectUserId || !employeeScopeMode)) return;
    setBusy(true);
    setMessage(null);
    try {
      const client = clients.find((item) => item.id === clientId);
      creationKey.current ||= crypto.randomUUID();
      const { data, error } = await supabaseRaw.rpc('create_report_draft_v2', {
        p_scope_type: scopeType,
        p_client_id: scopeType === 'client' ? clientId : null,
        p_subject_user_id: scopeType === 'employee' ? subjectUserId : null,
        p_responsible_user_id: scopeType === 'client' ? client?.am_agent_id || null : subjectUserId,
        p_employee_scope_mode: scopeType === 'employee' ? employeeScopeMode : null,
        p_employee_client_ids: scopeType === 'employee' && employeeScopeMode === 'selected_clients' ? selectedClientIds : [],
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

  const requestRewrite = async () => {
    if (!selectedReport || !currentVersion || !draftText.trim()) return;
    if (draftText !== currentVersion.content_text) {
      setMessage('Save the current editor text before requesting an AI rewrite.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const { data: aiData, error: aiError } = await supabaseRaw.functions.invoke('ai-router', {
        body: {
          task: 'REPORT_REWRITE',
          language: 'ar',
          payload: {
            report_id: selectedReport.id,
            current_text: draftText,
            creator_note: selectedReport.creator_note || '',
            base_version_id: currentVersion.id,
            source_hash: selectedReport.source_hash,
            audience: selectedReport.type === 'client' ? 'client' : 'internal',
          },
        },
      });
      if (aiError || !aiData?.ok || !aiData?.result?.suggested_text) throw new Error('rewrite failed');
      const { data, error } = await supabaseRaw.rpc('create_report_ai_suggestion', {
        p_report_id: selectedReport.id,
        p_base_version_id: currentVersion.id,
        p_source_hash: selectedReport.source_hash,
        p_suggested_text: aiData.result.suggested_text,
      });
      if (error) throw error;
      setSuggestion(data as unknown as ReportAiSuggestionRecord);
      setMessage('AI proposal is ready for review. It has not changed the report.');
    } catch {
      setMessage('AI rewrite is unavailable. The current text and manual note remain unchanged.');
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
    if (!selectedReport) return;
    const reason = window.prompt('Reason for archiving this report:') ?? '';
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
    if (!selectedReport?.archived_at) return;
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
    if (!selectedReport?.archived_at || !['executive', 'head_of_technical'].includes(currentUser.role)) return;
    const reason = window.prompt('Permanent deletion reason:') ?? '';
    if (!reason.trim() || !window.confirm('Permanently delete this archived report? This cannot be undone.')) return;
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
    await downloadReportPdf({
      filename: `report-${selectedReport.period || selectedReport.id}.pdf`,
      title: selectedReport.type === 'client' ? 'Client Report' : 'Employee Report',
      subtitle: `${selectedReport.period} · ${selectedReport.scope_type === 'employee' ? (names.get(selectedReport.subject_user_id || '') || 'Employee') : (clients.find((client) => client.id === selectedReport.client_id)?.name || 'Client')}`,
      paragraphs: [
        { heading: 'Report Details', body: `Scope: ${selectedReport.employee_scope_mode || selectedReport.scope_type || 'legacy'}\nResponsible: ${names.get(selectedReport.responsible_user_id || '') || 'Not assigned'}\nEvidence: ${sources.length} saved source item(s)${selectedReport.type === 'client' ? '' : ` · Source hash: ${selectedReport.source_hash || 'legacy'}`}` },
        { heading: 'Final Report', body: currentVersion.content_text },
      ],
    });
  };

  const workspaceReports = reports.filter((report) => (report.scope_type === 'client' || report.scope_type === 'employee') && (!!report.archived_at === showArchived));
  const hasUnsavedChanges = !!draftText.trim() && (!currentVersion || draftText !== currentVersion.content_text);
  const confirmDiscard = () => !hasUnsavedChanges || window.confirm('Discard unsaved editor changes?');

  return (
    <section className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-bold text-white flex items-center gap-2"><FilePenLine className="w-4 h-4 text-purple-400" />Versioned Report Workspace</h3>
        <div className="flex gap-2">
        <button onClick={() => { if (confirmDiscard()) { setShowArchived((value) => !value); setSelectedReportId(''); setDraftText(''); } }} className="px-3 py-2 rounded-lg text-xs bg-stone-800 text-stone-200">{showArchived ? 'Active reports' : 'Archived reports'}</button>
        <select value={selectedReportId} onChange={(event) => { if (confirmDiscard()) setSelectedReportId(event.target.value); }} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white">
          <option value="">Create a new draft</option>
          {workspaceReports.map((report) => <option key={report.id} value={report.id}>{report.period} — {report.scope_type}{report.archived_at ? ' (archived)' : ''}</option>)}
        </select>
        </div>
      </div>

      {!selectedReport && (
        <div className="space-y-3">
          <div className="flex gap-2">
            {(['client', 'employee'] as const).map((kind) => <button key={kind} onClick={() => { if (confirmDiscard()) { setScopeType(kind); setDraftText(''); setPreviewManifest(null); } }} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${scopeType === kind ? 'bg-purple-600 text-white' : 'bg-stone-900 text-stone-400'}`}>{kind === 'client' ? 'Specific Client' : 'Specific Agent'}</button>)}
          </div>
          {scopeType === 'client' ? (
            <select value={clientId} onChange={(event) => { if (confirmDiscard()) { setClientId(event.target.value); setDraftText(''); setPreviewManifest(null); } }} className="w-full px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white"><option value="">Select client</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select>
          ) : (
            <div className="space-y-3">
              <select value={subjectUserId} onChange={(event) => { if (confirmDiscard()) { setSubjectUserId(event.target.value); setDraftText(''); setPreviewManifest(null); } }} className="w-full px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white"><option value="">Select an employee (required)</option>{employeeOptions.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select>
              <select value={employeeScopeMode} onChange={(event) => { if (confirmDiscard()) { setEmployeeScopeMode(event.target.value as EmployeeClientScopeMode | ''); setSelectedClientIds([]); setDraftText(''); setPreviewManifest(null); } }} className="w-full px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white"><option value="">Select client scope (required)</option><option value="all_clients">All Clients</option><option value="selected_clients">Selected Clients</option><option value="employee_overall">Employee Overall</option></select>
              {employeeScopeMode === 'selected_clients' && <div className="p-3 rounded-xl border border-purple-900/40 space-y-2">
                <input value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} placeholder="Search clients" className="w-full px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
                <div className="flex gap-2"><button onClick={() => { setSelectedClientIds(clients.map((client) => client.id)); setPreviewManifest(null); }} className="text-xs text-purple-300">Select All</button><button onClick={() => { setSelectedClientIds([]); setPreviewManifest(null); }} className="text-xs text-stone-400">Clear All</button></div>
                <div className="max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1">{clients.filter((client) => client.name.toLowerCase().includes(clientSearch.toLowerCase())).map((client) => <label key={client.id} className="flex items-center gap-2 text-xs text-stone-300"><input type="checkbox" checked={selectedClientIds.includes(client.id)} onChange={(event) => { setSelectedClientIds((current) => event.target.checked ? [...new Set([...current, client.id])] : current.filter((id) => id !== client.id)); setPreviewManifest(null); }} />{client.name}</label>)}</div>
              </div>}
              {employeeScopeMode && <p className="text-[11px] text-stone-400">Scope: {employeeScopeMode === 'all_clients' ? 'all authorized client-associated work' : employeeScopeMode === 'employee_overall' ? 'all eligible employee work, including non-client records' : `${selectedClientIds.length} selected client(s)`}</p>}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input type="date" value={periodStart} onChange={(event) => { setPeriodStart(event.target.value); setPreviewManifest(null); }} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
            <input type="date" value={periodEnd} onChange={(event) => { setPeriodEnd(event.target.value); setPreviewManifest(null); }} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
          </div>
          <textarea value={creatorNote} onChange={(event) => { setCreatorNote(event.target.value); setPreviewManifest(null); }} placeholder="Creator context (stored internally and incorporated professionally in client content)" className="w-full min-h-20 px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
          <div className="flex gap-2"><button disabled={busy} onClick={buildPreview} className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white disabled:opacity-50">Build server source preview</button><span className="text-[11px] text-stone-400 self-center">{preview.dailyLogs.length} visible work logs · {preview.tasks.length} evidenced tasks · {preview.extraNotes.length} employee notes · Fridays excluded</span></div>
        </div>
      )}

      <textarea disabled={selectedReport?.status === 'final' || !!selectedReport?.archived_at} value={draftText} onChange={(event) => setDraftText(event.target.value)} placeholder="Build a preview or select a saved report" className="w-full min-h-56 px-3 py-3 rounded-xl text-sm bg-[#100c1c] border border-purple-900/50 text-white disabled:opacity-70" />

      <div className="flex flex-wrap gap-2">
        {!selectedReport ? <button disabled={busy || !draftText.trim() || !previewManifest} onClick={createDraft} className="filled-purple-action px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"><Save className="w-3.5 h-3.5 inline mr-1" />Save draft</button> : <>
          <button disabled={busy || !!selectedReport.archived_at || selectedReport.status === 'final'} onClick={saveVersion} className="filled-purple-action px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"><Save className="w-3.5 h-3.5 inline mr-1" />Save version</button>
          <button disabled={busy || !!selectedReport.archived_at || selectedReport.status === 'final'} onClick={requestRewrite} className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-900/50 text-indigo-200 disabled:opacity-50"><Bot className="w-3.5 h-3.5 inline mr-1" />Suggest rewrite</button>
          {selectedReport.status !== 'final' && <button disabled={busy || !!selectedReport.archived_at} onClick={approveSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-emerald-950/50 text-emerald-200 disabled:opacity-50"><CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />Approve final</button>}
          <button onClick={exportPdf} className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white"><Download className="w-3.5 h-3.5 inline mr-1" />PDF</button>
          {selectedReport.archived_at
            ? <><button disabled={busy} onClick={restoreSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-emerald-950/50 text-emerald-200 disabled:opacity-50"><Archive className="w-3.5 h-3.5 inline mr-1" />Restore</button>{['executive', 'head_of_technical'].includes(currentUser.role) && <button disabled={busy} onClick={deleteSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-red-950/50 text-red-200 disabled:opacity-50"><Trash2 className="w-3.5 h-3.5 inline mr-1" />Delete permanently</button>}</>
            : <button disabled={busy} onClick={archiveSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-amber-950/50 text-amber-200 disabled:opacity-50"><Archive className="w-3.5 h-3.5 inline mr-1" />Archive</button>}
        </>}
      </div>

      {suggestion && selectedReport?.status !== 'final' && !selectedReport?.archived_at && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-3 rounded-xl border border-indigo-800/40 bg-indigo-950/20">
          <div><p className="text-xs font-bold text-stone-300 mb-2">Current text</p><pre className="whitespace-pre-wrap text-xs text-stone-300">{draftText}</pre></div>
          <div><p className="text-xs font-bold text-indigo-200 mb-2">AI proposal</p><pre className="whitespace-pre-wrap text-xs text-stone-200">{suggestion.suggested_text}</pre><div className="flex gap-2 mt-3"><button disabled={busy} onClick={applySuggestion} className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-600 text-white"><Sparkles className="w-3.5 h-3.5 inline mr-1" />Apply as new version</button><button onClick={() => setSuggestion(null)} className="px-3 py-2 rounded-lg text-xs bg-stone-800 text-stone-300">Keep current</button></div></div>
        </div>
      )}
      {message && <p className="text-xs text-amber-200">{message}</p>}
    </section>
  );
};
