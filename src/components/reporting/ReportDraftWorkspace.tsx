import React, { useEffect, useMemo, useState } from 'react';
import { Archive, Bot, CheckCircle2, Download, FilePenLine, Save, Sparkles } from 'lucide-react';
import {
  ClientRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  ReportAiSuggestionRecord,
  ReportContentVersionRecord,
  ReportRecord,
  ReportSourceItemRecord,
  UserRecord,
} from '../../types/database';
import { supabaseRaw } from '../../lib/supabase';
import { resolveReportPeriod } from '../../lib/reportPeriods';
import {
  collectClientReportSources,
  collectEmployeeReportSources,
  composeInitialReportContent,
} from '../../lib/reportDraftSources';
import { downloadReportPdf } from '../../lib/pdfExport';

interface Props {
  currentUser: UserRecord;
  users: UserRecord[];
  clients: ClientRecord[];
  employees: UserRecord[];
  reports: ReportRecord[];
  dailyLogs: DailyLogRecord[];
  extraNotes: ExtraNoteRecord[];
  onReportChanged: (report: ReportRecord) => void;
}

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

export const ReportDraftWorkspace: React.FC<Props> = ({
  currentUser,
  users,
  clients,
  employees,
  reports,
  dailyLogs,
  extraNotes,
  onReportChanged,
}) => {
  const [scopeType, setScopeType] = useState<'client' | 'employee'>('client');
  const [clientId, setClientId] = useState('');
  const [subjectUserId, setSubjectUserId] = useState(currentUser.id);
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

  const selectedReport = reports.find((report) => report.id === selectedReportId) || null;
  const currentVersion = selectedReport
    ? versions.find((version) => version.id === selectedReport.current_version_id) || versions[0] || null
    : null;
  const names = useMemo(() => new Map(users.map((user) => [user.id, user.name])), [users]);
  const employeeOptions = useMemo(() => {
    const map = new Map<string, UserRecord>([[currentUser.id, currentUser]]);
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
    if (!period) return { dailyLogs: [] as DailyLogRecord[], extraNotes: [] as ExtraNoteRecord[] };
    if (scopeType === 'client') {
      const result = collectClientReportSources(dailyLogs, clientId, period);
      return { dailyLogs: result.dailyLogs, extraNotes: [] as ExtraNoteRecord[] };
    }
    return collectEmployeeReportSources(dailyLogs, extraNotes, subjectUserId, period);
  }, [period, scopeType, clientId, subjectUserId, dailyLogs, extraNotes]);

  const buildPreview = () => {
    setDraftText(composeInitialReportContent(scopeType, preview.dailyLogs, preview.extraNotes, creatorNote, names));
    setMessage(`Preview built from ${preview.dailyLogs.length} work log(s) and ${preview.extraNotes.length} employee note(s).`);
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
    if (!period || !draftText.trim() || (scopeType === 'client' ? !clientId : !subjectUserId)) return;
    setBusy(true);
    setMessage(null);
    try {
      const client = clients.find((item) => item.id === clientId);
      const { data, error } = await supabaseRaw.rpc('create_report_draft', {
        p_scope_type: scopeType,
        p_client_id: scopeType === 'client' ? clientId : null,
        p_subject_user_id: scopeType === 'employee' ? subjectUserId : null,
        p_responsible_user_id: scopeType === 'client' ? client?.am_agent_id || null : subjectUserId,
        p_period_start: period.startInclusive,
        p_period_end_exclusive: period.endExclusive,
        p_creator_note: creatorNote,
        p_content_text: draftText,
      });
      if (error) throw error;
      const report = data as unknown as ReportRecord;
      onReportChanged(report);
      setSelectedReportId(report.id);
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
      const { data, error } = await supabaseRaw.rpc('save_report_version', {
        p_report_id: selectedReport.id,
        p_content_text: draftText,
        p_origin: 'manual',
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
    setBusy(true);
    setMessage(null);
    try {
      // Send only reportable facts to the provider — never database ids, client ids, user ids,
      // hashes, or the full internal snapshot object.
      const facts = sources.map((source) => {
        const text = source.source_kind === 'daily_log'
          ? source.snapshot.summary_text
          : source.snapshot.note_text;
        return `${source.source_date}: ${typeof text === 'string' ? text : ''}`;
      });
      const { data: aiData, error: aiError } = await supabaseRaw.functions.invoke('ai-router', {
        body: {
          task: 'REPORT_REWRITE',
          language: 'ar',
          payload: {
            current_text: draftText,
            creator_note: selectedReport.creator_note || '',
            facts,
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
      const { data, error } = await supabaseRaw.rpc('archive_report', { p_report_id: selectedReport.id, p_reason: reason, p_restore: false });
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
      const { data, error } = await supabaseRaw.rpc('archive_report', {
        p_report_id: selectedReport.id,
        p_reason: '',
        p_restore: true,
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

  const approveSelected = async () => {
    if (!selectedReport || selectedReport.status === 'final') return;
    if (!currentVersion || draftText !== currentVersion.content_text) {
      setMessage('Save the current text as a version before approving the report.');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabaseRaw.rpc('approve_report', { p_report_id: selectedReport.id });
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
      subtitle: selectedReport.period,
      paragraphs: [{ heading: 'Final Report', body: currentVersion.content_text }],
    });
  };

  const workspaceReports = reports.filter((report) => report.scope_type === 'client' || report.scope_type === 'employee');

  return (
    <section className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-bold text-white flex items-center gap-2"><FilePenLine className="w-4 h-4 text-purple-400" />Versioned Report Workspace</h3>
        <select value={selectedReportId} onChange={(event) => setSelectedReportId(event.target.value)} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white">
          <option value="">Create a new draft</option>
          {workspaceReports.map((report) => <option key={report.id} value={report.id}>{report.period} — {report.scope_type}{report.archived_at ? ' (archived)' : ''}</option>)}
        </select>
      </div>

      {!selectedReport && (
        <div className="space-y-3">
          <div className="flex gap-2">
            {(['client', 'employee'] as const).map((kind) => <button key={kind} onClick={() => setScopeType(kind)} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${scopeType === kind ? 'bg-purple-600 text-white' : 'bg-stone-900 text-stone-400'}`}>{kind === 'client' ? 'Client report' : 'Employee report'}</button>)}
          </div>
          {scopeType === 'client' ? (
            <select value={clientId} onChange={(event) => setClientId(event.target.value)} className="w-full px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white"><option value="">Select client</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select>
          ) : (
            <select value={subjectUserId} onChange={(event) => setSubjectUserId(event.target.value)} className="w-full px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white">{employeeOptions.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
            <input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
          </div>
          <textarea value={creatorNote} onChange={(event) => setCreatorNote(event.target.value)} placeholder="Creator context (stored internally and incorporated professionally in client content)" className="w-full min-h-20 px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
          <div className="flex gap-2"><button onClick={buildPreview} className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white">Build source preview</button><span className="text-[11px] text-stone-400 self-center">{preview.dailyLogs.length} work logs · {preview.extraNotes.length} employee notes · Fridays excluded</span></div>
        </div>
      )}

      <textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} placeholder="Build a preview or select a saved report" className="w-full min-h-56 px-3 py-3 rounded-xl text-sm bg-[#100c1c] border border-purple-900/50 text-white" />

      <div className="flex flex-wrap gap-2">
        {!selectedReport ? <button disabled={busy || !draftText.trim()} onClick={createDraft} className="filled-purple-action px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"><Save className="w-3.5 h-3.5 inline mr-1" />Save draft</button> : <>
          <button disabled={busy || !!selectedReport.archived_at} onClick={saveVersion} className="filled-purple-action px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"><Save className="w-3.5 h-3.5 inline mr-1" />Save version</button>
          <button disabled={busy || !!selectedReport.archived_at} onClick={requestRewrite} className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-900/50 text-indigo-200 disabled:opacity-50"><Bot className="w-3.5 h-3.5 inline mr-1" />Suggest rewrite</button>
          {selectedReport.status !== 'final' && <button disabled={busy || !!selectedReport.archived_at} onClick={approveSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-emerald-950/50 text-emerald-200 disabled:opacity-50"><CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />Approve final</button>}
          <button onClick={exportPdf} className="px-3 py-2 rounded-lg text-xs font-bold bg-stone-800 text-white"><Download className="w-3.5 h-3.5 inline mr-1" />PDF</button>
          {selectedReport.archived_at
            ? <button disabled={busy} onClick={restoreSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-emerald-950/50 text-emerald-200 disabled:opacity-50"><Archive className="w-3.5 h-3.5 inline mr-1" />Restore</button>
            : <button disabled={busy} onClick={archiveSelected} className="px-3 py-2 rounded-lg text-xs font-bold bg-amber-950/50 text-amber-200 disabled:opacity-50"><Archive className="w-3.5 h-3.5 inline mr-1" />Archive</button>}
        </>}
      </div>

      {suggestion && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-3 rounded-xl border border-indigo-800/40 bg-indigo-950/20">
          <div><p className="text-xs font-bold text-stone-300 mb-2">Current text</p><pre className="whitespace-pre-wrap text-xs text-stone-300">{draftText}</pre></div>
          <div><p className="text-xs font-bold text-indigo-200 mb-2">AI proposal</p><pre className="whitespace-pre-wrap text-xs text-stone-200">{suggestion.suggested_text}</pre><div className="flex gap-2 mt-3"><button disabled={busy} onClick={applySuggestion} className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-600 text-white"><Sparkles className="w-3.5 h-3.5 inline mr-1" />Apply as new version</button><button onClick={() => setSuggestion(null)} className="px-3 py-2 rounded-lg text-xs bg-stone-800 text-stone-300">Keep current</button></div></div>
        </div>
      )}
      {message && <p className="text-xs text-amber-200">{message}</p>}
    </section>
  );
};
