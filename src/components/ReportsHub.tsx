import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, TrendingUp, FileText, Users, AlertTriangle, ClipboardList, Search, Edit2, Trash2, X } from 'lucide-react';
import {
  ClientRecord,
  UserRecord,
  AssignmentRecord,
  ReportRecord,
  ClientComparisonRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  ServiceType,
  TaskRecord,
  TaskAssigneeRecord,
  PlatformConnectionRecord,
} from '../types/database';
import {
  ComparisonGranularity,
  DateRange,
  ReportMode,
  ReportScope,
  resolveClientsForSubject,
  detectClientAnomalies,
  ClientAnomalyResult,
  ensureComparisonForSummary as resolveOrGenerateComparison,
} from '../lib/reportingEngine';
import { matchesClientQuery } from '../lib/clientSearch';
import { canEditOwnDailyLog } from '../lib/dailyLogs';
import { getTodayStr } from '../lib/employeeWork';
import { TEAM_LEAD_TO_AGENT_ROLE } from '../data/roles';
import { canSelectAnyReportAgent, isSelectableReportAgent } from '../lib/reportAgentEligibility';
import { EmployeeClientScopeMode } from '../lib/reportDraftSources';
import {
  ComparisonCard,
  FiledReportsList,
  describeComparisonScope,
  buildCampaignSummaryPayload,
  CampaignSummaryPayload,
  CampaignSummaryGenerationResult,
} from './reporting/ComparisonDisplay';
import { DailyLogEditModal } from './DailyLogEditModal';
import { ReportDraftWorkspace, ReportScopeKind } from './reporting/ReportDraftWorkspace';

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function daysBetweenIso(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

interface ReportsHubProps {
  currentUser: UserRecord;
  users: UserRecord[];
  clients: ClientRecord[];
  assignments: AssignmentRecord[];
  reports: ReportRecord[];
  clientComparisons: ClientComparisonRecord[];
  dailyLogs?: DailyLogRecord[];
  extraNotes?: ExtraNoteRecord[];
  // Only needed for the Daily Activity Log feed's Edit modal (a log's own linked-tasks checklist)
  // — never used for scoping/filtering anything else in this hub.
  tasks?: TaskRecord[];
  taskAssignees?: TaskAssigneeRecord[];
  // Comparison section's media_buying/social_media gating — see unconnectedServices below.
  platformConnections?: PlatformConnectionRecord[];
  onGenerateComparison: (
    scope: ReportScope,
    mode: ReportMode,
    granularity: ComparisonGranularity | 'custom',
    custom?: { currentRange: DateRange; previousRange?: DateRange }
  ) => Promise<ClientComparisonRecord | null>;
  onGenerateReport: (comparisonId: string, period: string) => Promise<void>;
  // Phase 4 (AI Orchestrator): reuses this hub's existing nav-level access gate. The single AI
  // action on this page is bound to the selected scope/period controls below, both for the
  // Comparison section's own button and for "AI Summary" inside the Draft section.
  onGenerateAiSummary?: (payload: CampaignSummaryPayload) => Promise<CampaignSummaryGenerationResult>;
  onUpdateDailyLog: (
    logId: string,
    updates: { date: string; summary_text: string; linked_task_ids: string[]; client_id: string | null }
  ) => Promise<void>;
  onDeleteDailyLog: (logId: string) => Promise<void>;
  onReportChanged: (report: ReportRecord) => void;
  onReportDeleted: (reportId: string) => void;
}

// Role-agnostic reporting entry point: unlike ClientDashboard's per-client "Reports &
// Comparisons" tab (which requires already being inside one client's dashboard), this covers
// the two cases that don't fit that model — "all of my clients pooled together" and, for team
// leads, "a specific direct report's clients pooled together" — alongside the same single-client
// generation ClientDashboard already offers, so a client-scoped report can be started from
// either surface. Available to every team lead and agent role plus Executive/Head of Technical;
// gated at the nav level via the 'reports' AppModuleId in data/roles.ts.
//
// Single unified page (no Create/Workspace/Saved/Archived tabs): Setup (scope+period+Pull
// sources) -> Sources (work logs + merged daily-activity feed) -> Comparison (same scope, its own
// two editable periods A/B) -> Draft (edit + AI Summary) -> Save/Approve/PDF/Archive -> Saved +
// Archived reports list, in that order, all on one scroll.
export const ReportsHub: React.FC<ReportsHubProps> = ({
  currentUser,
  users,
  clients,
  assignments,
  reports,
  clientComparisons,
  dailyLogs = [],
  extraNotes = [],
  tasks = [],
  taskAssignees = [],
  platformConnections = [],
  onGenerateComparison,
  onGenerateReport,
  onGenerateAiSummary,
  onUpdateDailyLog,
  onDeleteDailyLog,
  onReportChanged,
  onReportDeleted,
}) => {
  const agentRoleForLead = TEAM_LEAD_TO_AGENT_ROLE[currentUser.role];
  const isTeamLead = !!agentRoleForLead;
  const canSelectAnyActiveAgent = canSelectAnyReportAgent(currentUser.role);
  const canSelectSpecificAgent = isTeamLead || canSelectAnyActiveAgent;

  // Combined-scope item C (extended here to close the same gap ClientDashboard.tsx just closed):
  // which service(s) this viewer may see on a comparison row's ComparisonCard. Unlike
  // ClientDashboard.tsx's version, this needs no per-client check — visibleComparisons below
  // already restricts which ROWS this viewer sees at all (via resolveClientsForSubject/myClientIds,
  // the same client-scoping mechanism), so every row that gets this far is already one this viewer
  // is allowed to know exists; this only narrows which SERVICE(S) within that row they see, exactly
  // the same DISPLAY-level narrowing ClientDashboard.tsx's viewerServiceFilter does, since RLS/the
  // client-scoping above operates per-row, never per-key inside metrics_current's JSON blob. An
  // am_agent here is unconditionally "sees everything" (not scoped to one specific client's
  // am_agent_id the way ClientDashboard.tsx's hasReportsAccess is) because myClientIds already only
  // ever contains clients THIS am_agent owns (resolveClientsForSubject's am_agent branch) — any row
  // visible here is already their own client's row.
  const seesAllServices =
    currentUser.role === 'executive' ||
    currentUser.role === 'head_of_technical' ||
    currentUser.role === 'am_team_lead' ||
    currentUser.role === 'ai_engineer' ||
    currentUser.role === 'am_agent';
  const viewerServiceFilter: ServiceType[] | undefined = seesAllServices
    ? undefined
    : currentUser.role === 'media_buying_team_lead' || currentUser.role === 'media_buying_agent'
    ? ['media_buying']
    : currentUser.role === 'seo_team_lead' || currentUser.role === 'seo_agent' || currentUser.role === 'store_manager'
    ? ['seo']
    : currentUser.role === 'social_media_team_lead' || currentUser.role === 'social_media_agent'
    ? ['social_media']
    : undefined;

  // Point 9's aggregate daily-activity report — manager/leadership audience only. Note this
  // never widens visibility: dailyLogs here is whatever direct_report_visible() already let
  // through (a team lead's own reports' logs; executive/head_of_technical see everyone's), the
  // same scope MyWorkHub/DailyOperationsModule already operate under. This is a client filter
  // over already-visible rows, not a new access grant.
  const canSeeDailyActivityReport =
    currentUser.role === 'executive' || currentUser.role === 'head_of_technical' || currentUser.role === 'ai_engineer' || isTeamLead;
  const [dailyLogClientFilter, setDailyLogClientFilter] = useState('all');
  // Sorted by the log's own `date` (newest first), then by `created_at` as a tiebreaker for logs
  // sharing the same date — so a backdated or future-dated entry sits where its date says.
  const filteredDailyLogs = useMemo(
    () =>
      dailyLogs
        .filter((l) => dailyLogClientFilter === 'all' || l.client_id === dailyLogClientFilter)
        .sort((a, b) => b.date.localeCompare(a.date) || (b.created_at || '').localeCompare(a.created_at || '')),
    [dailyLogs, dailyLogClientFilter]
  );
  const todayStr = useMemo(() => getTodayStr(), []);
  const [editingDailyLog, setEditingDailyLog] = useState<DailyLogRecord | null>(null);
  const [selectedDailyLog, setSelectedDailyLog] = useState<DailyLogRecord | null>(null);
  const [dailyLogActionError, setDailyLogActionError] = useState<string | null>(null);
  const [workspaceReportId, setWorkspaceReportId] = useState<string | null>(null);
  const [selectedLegacyReport, setSelectedLegacyReport] = useState<ReportRecord | null>(null);
  const [reportListFilter, setReportListFilter] = useState<'all' | 'active' | 'archived'>('all');
  const [reportSearch, setReportSearch] = useState('');
  const [reportStatusFilter, setReportStatusFilter] = useState<'all' | 'draft' | 'final'>('all');
  const [selectedComparisonId, setSelectedComparisonId] = useState('');

  const handleSaveEditedDailyLog = async (updates: {
    date: string;
    summary_text: string;
    linked_task_ids: string[];
    client_id: string | null;
  }) => {
    if (!editingDailyLog) return;
    await onUpdateDailyLog(editingDailyLog.id, updates);
    setEditingDailyLog(null);
  };

  const handleDeleteDailyLogClick = async (log: DailyLogRecord) => {
    if (!window.confirm('Delete this daily log? This cannot be undone.')) return;
    setDailyLogActionError(null);
    try {
      await onDeleteDailyLog(log.id);
    } catch (err: any) {
      setDailyLogActionError(err?.message || 'Unable to delete this log.');
    }
  };
  const clientsWithLogs = useMemo(
    () => clients.filter((c) => dailyLogs.some((l) => l.client_id === c.id)),
    [clients, dailyLogs]
  );

  const openFiledReport = (report: ReportRecord) => {
    setWorkspaceReportId(report.id);
    setSelectedLegacyReport(report.scope_type === 'client' || report.scope_type === 'employee' ? null : report);
  };

  const handleWorkspaceReportChanged = (report: ReportRecord) => {
    onReportChanged(report);
    setWorkspaceReportId(report.id);
  };

  const handleWorkspaceReportDeleted = (reportId: string) => {
    onReportDeleted(reportId);
    setWorkspaceReportId(null);
  };

  const myClients = useMemo(
    () => resolveClientsForSubject(currentUser, clients, assignments),
    [currentUser, clients, assignments]
  );

  const selectableAgents = useMemo(
    () =>
      users
        .filter((user) => isSelectableReportAgent(currentUser, user))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [users, currentUser]
  );

  // ======================================================================
  // Setup — one scope, one from-to period, shared by Sources/Draft (ReportDraftWorkspace) AND
  // Comparison below (resolvedScope). No second scope/period picker anywhere else on this page.
  // ======================================================================
  const [scopeKind, setScopeKind] = useState<ReportScopeKind>('client');
  const [clientId, setClientId] = useState('');
  const [subjectUserId, setSubjectUserId] = useState('');
  const [employeeScopeMode, setEmployeeScopeMode] = useState<EmployeeClientScopeMode | ''>('');
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const todayIso = useMemo(() => getTodayStr(), []);
  const [periodStart, setPeriodStart] = useState(`${todayIso.slice(0, 8)}01`);
  const [periodEnd, setPeriodEnd] = useState(todayIso);
  const [clientSearchQuery, setClientSearchQuery] = useState('');

  const searchedClients = useMemo(
    () => myClients.filter((c) => matchesClientQuery(c, clientSearchQuery)),
    [myClients, clientSearchQuery]
  );

  const resolvedScope: ReportScope | null =
    scopeKind === 'client'
      ? (clientId ? { type: 'client', clientId } : null)
      : scopeKind === 'own'
      ? { type: 'agent', agentId: currentUser.id }
      : (subjectUserId ? { type: 'agent', agentId: subjectUserId } : null);

  // ======================================================================
  // Comparison — same resolvedScope as Setup, its own two independently editable periods (A =
  // current, B = previous). Defaults: A mirrors Setup's period, B is the same-length period right
  // before A — recomputed only until the viewer actually edits either Comparison date field.
  // ======================================================================
  const [reportMode, setReportMode] = useState<ReportMode>('comparison');
  const [customCurrentRange, setCustomCurrentRange] = useState<DateRange>({ start: '', end: '' });
  const [customPreviousRange, setCustomPreviousRange] = useState<DateRange>({ start: '', end: '' });
  const comparisonPeriodTouched = useRef(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingReportForComparisonId, setGeneratingReportForComparisonId] = useState<string | null>(null);

  useEffect(() => {
    if (comparisonPeriodTouched.current) return;
    if (!periodStart || !periodEnd || periodStart > periodEnd) return;
    setCustomCurrentRange({ start: periodStart, end: periodEnd });
    const lengthDays = daysBetweenIso(periodStart, periodEnd) + 1;
    const prevEnd = addDaysIso(periodStart, -1);
    const prevStart = addDaysIso(prevEnd, -(lengthDays - 1));
    setCustomPreviousRange({ start: prevStart, end: prevEnd });
  }, [periodStart, periodEnd]);

  const isSinglePeriod = reportMode === 'period_summary';

  const handleGenerate = async () => {
    if (!resolvedScope) return;
    const missingCurrent = !customCurrentRange.start || !customCurrentRange.end;
    const missingPrevious = !isSinglePeriod && (!customPreviousRange.start || !customPreviousRange.end);
    if (missingCurrent || missingPrevious) return;
    setIsGenerating(true);
    try {
      const generated = await onGenerateComparison(
        resolvedScope,
        reportMode,
        'custom',
        { currentRange: customCurrentRange, previousRange: isSinglePeriod ? undefined : customPreviousRange }
      );
      if (generated) setSelectedComparisonId(generated.id);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerateReport = async (comparison: ClientComparisonRecord) => {
    setGeneratingReportForComparisonId(comparison.id);
    try {
      await onGenerateReport(comparison.id, comparison.period_current);
    } finally {
      setGeneratingReportForComparisonId(null);
    }
  };

  // What's visible in this hub: my own client-scoped comparisons, my own aggregate, and — for
  // team leads — any direct report's aggregate; leadership sees any selectable active agent's
  // aggregate. Purely a display filter; the RLS policies behind
  // onGenerateComparison/the reports and client_comparisons fetches are the actual access
  // control, this just keeps the list relevant instead of showing every row the fetch returned.
  const myClientIds = useMemo(() => new Set(myClients.map((c) => c.id)), [myClients]);
  const selectableAgentIds = useMemo(() => new Set(selectableAgents.map((u) => u.id)), [selectableAgents]);

  const visibleComparisons = useMemo(
    () =>
      clientComparisons
        .filter(
          (c) =>
            (c.client_id && myClientIds.has(c.client_id)) ||
            (c.agent_id && (c.agent_id === currentUser.id || selectableAgentIds.has(c.agent_id)))
        )
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    [clientComparisons, myClientIds, selectableAgentIds, currentUser.id]
  );

  // UX-flow change: lets "Generate AI Summary" work before any comparison row exists yet, same as
  // ClientDashboard.tsx's own DirectAiSummaryPanel — binds reportingEngine.ts's shared
  // ensureComparisonForSummary to whichever scope is currently selected (client or agent), looking
  // it up in visibleComparisons first (already scoped to what this viewer is allowed to see) before
  // falling through to onGenerateComparison.
  const ensureComparisonForSummary = async (mode: ReportMode): Promise<ClientComparisonRecord | null> => {
    const comparison = resolvedScope
      ? await resolveOrGenerateComparison({
          scope: resolvedScope,
          mode,
          granularity: 'custom',
          customCurrentRange,
          customPreviousRange,
          comparisons: visibleComparisons,
          onGenerateComparison,
        })
      : null;
    if (comparison) setSelectedComparisonId(comparison.id);
    return comparison;
  };

  // Draft section's sole AI action — reuses the exact same ensure/generate path as the
  // Comparison section's own button, then formats the result into plain draft text.
  const requestDraftAiSummary = async (): Promise<{ ok: true; text: string } | { ok: false; message: string }> => {
    if (!onGenerateAiSummary) return { ok: false, message: 'AI Summary is not available.' };
    const comparison = await ensureComparisonForSummary(reportMode);
    if (!comparison) return { ok: false, message: 'Could not generate a comparison for this scope/period yet.' };
    const result = await onGenerateAiSummary(buildCampaignSummaryPayload(comparison, viewerServiceFilter));
    if (!result.ok) return { ok: false, message: result.message };
    const sections = [result.result.summary, ...result.result.by_service.map((entry) => entry.text)];
    return { ok: true, text: sections.join('\n\n') };
  };

  const visibleReports = useMemo(
    () =>
      reports
        .filter((r) => r.generated_by === currentUser.id || visibleComparisons.some((c) => c.id === r.comparison_id))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    [reports, visibleComparisons, currentUser.id]
  );

  const filteredReports = useMemo(() => {
    const query = reportSearch.trim().toLowerCase();
    return visibleReports.filter((report) => {
      if (reportListFilter === 'active' && report.archived_at) return false;
      if (reportListFilter === 'archived' && !report.archived_at) return false;
      if (reportStatusFilter !== 'all' && report.status !== reportStatusFilter) return false;
      if (!query) return true;
      const author = users.find((user) => user.id === report.generated_by)?.name || '';
      const client = clients.find((item) => item.id === report.client_id)?.name || '';
      const subject = users.find((user) => user.id === report.subject_user_id)?.name || '';
      return [report.period, report.type, report.status || '', report.scope_type || '', author, client, subject]
        .some((value) => value.toLowerCase().includes(query));
    });
  }, [visibleReports, reportSearch, reportStatusFilter, reportListFilter, users, clients]);
  const selectedComparison = visibleComparisons.find((comparison) => comparison.id === selectedComparisonId)
    || visibleComparisons[0]
    || null;

  // Platform-connections gating (plan item 3): media_buying/social_media only — seo is computed
  // from internal tasks, never gated. Looked up only when the resolved scope is a single client
  // (an agent/all-my-clients aggregate pools many clients, so there's no single connection status
  // to check — those rows show their numbers unchanged, same as before this change).
  const unconnectedServices = useMemo(() => {
    if (!selectedComparison?.client_id) return [];
    const statusFor = (platformName: string) =>
      platformConnections.find((row) => row.client_id === selectedComparison.client_id && row.platform_name === platformName)?.status;
    const result: Array<'media_buying' | 'social_media'> = [];
    if (statusFor('media_buying') !== 'connected') result.push('media_buying');
    if (statusFor('social_media') !== 'connected') result.push('social_media');
    return result;
  }, [selectedComparison, platformConnections]);

  // Anomaly detection (Module 9): a client's own rolling baseline, not the single-period delta
  // ComparisonCard's narrative already shows — computed here (not in App.tsx) since it's pure
  // derived display, same as the narrative itself. Keyed by client_id so both the panel below and
  // each ComparisonCard's badge (only on that client's latest row) can look it up directly.
  const anomaliesByClientId = useMemo(() => {
    const map = new Map<string, ClientAnomalyResult>();
    myClients.forEach((client) => {
      const result = detectClientAnomalies(client.id, clientComparisons);
      if (result && result.flags.length > 0) map.set(client.id, result);
    });
    return map;
  }, [myClients, clientComparisons]);

  const flaggedClients = useMemo(
    () => myClients.filter((c) => anomaliesByClientId.has(c.id)),
    [myClients, anomaliesByClientId]
  );

  return (
    <div className="reports-hub space-y-6">
      <div
        className="p-5 rounded-2xl border relative overflow-hidden backdrop-blur-md"
        style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-medium)' }}
      >
        <div className="flex items-center gap-3.5">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center shadow-lg shrink-0"
            style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-medium)' }}
          >
            <BarChart3 className="w-6 h-6 text-purple-300" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Reports & Comparisons</h2>
          </div>
        </div>
      </div>

      {flaggedClients.length > 0 && (
        <div className="p-4 rounded-xl border border-red-800/40 bg-red-950/20 space-y-3">
          <h3 className="text-sm font-bold text-red-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            <span>Anomalies — {flaggedClients.length} client{flaggedClients.length === 1 ? '' : 's'} below baseline</span>
          </h3>
          <div className="space-y-2">
            {flaggedClients.map((client) => {
              const result = anomaliesByClientId.get(client.id)!;
              return (
                <div key={client.id} className="p-3 rounded-lg bg-stone-900/60 border border-red-900/30">
                  <p className="text-xs font-bold text-white mb-1">{client.name}</p>
                  {result.flags.map((flag, i) => (
                    <p key={i} className="text-[11px] text-stone-300">
                      <span className="text-red-300 font-semibold">
                        {flag.service.replace('_', ' ')} — {flag.metricLabel}:
                      </span>{' '}
                      {flag.pctBelowBaseline}% below baseline
                      {flag.confidence === 'low' ? ' (low confidence)' : ''}
                    </p>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 1) Setup: scope + period, shared by Sources/Draft and Comparison below. */}
      <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Users className="w-4 h-4 text-purple-400" />
          <span>Setup</span>
        </h3>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setScopeKind('own')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              scopeKind === 'own' ? 'reports-filled-action filled-purple-action bg-purple-600 text-white shadow' : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
            }`}
          >
            All My Clients ({myClients.length})
          </button>
          <button
            onClick={() => setScopeKind('client')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              scopeKind === 'client' ? 'reports-filled-action filled-purple-action bg-purple-600 text-white shadow' : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
            }`}
          >
            Specific Client
          </button>
          {canSelectSpecificAgent && (
            <button
              onClick={() => setScopeKind('employee')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                scopeKind === 'employee' ? 'reports-filled-action filled-purple-action bg-purple-600 text-white shadow' : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
              }`}
            >
              Specific Agent
            </button>
          )}
        </div>

        {scopeKind === 'client' && (
          <div className="space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={clientSearchQuery}
                onChange={(e) => setClientSearchQuery(e.target.value)}
                placeholder="Search name or phone..."
                className="w-full pl-9 pr-3 py-2 rounded-xl text-xs bg-[#100c1c] border border-purple-900/50 text-white placeholder-stone-500 focus:outline-none focus:border-purple-400"
              />
            </div>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full px-3 py-2 rounded-xl text-xs bg-[#100c1c] border border-purple-900/50 text-white focus:outline-none focus:border-purple-400"
            >
              <option value="">-- Select a client --</option>
              {searchedClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {scopeKind === 'employee' && (
          <select
            value={subjectUserId}
            onChange={(e) => setSubjectUserId(e.target.value)}
            className="w-full px-3 py-2 rounded-xl text-xs bg-[#100c1c] border border-purple-900/50 text-white focus:outline-none focus:border-purple-400"
          >
            <option value="">-- Select an agent --</option>
            {selectableAgents.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
          <input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
        </div>
      </div>

      {/* 2) Sources + Draft + Save/Approve/PDF/Archive + Version history/Source ledger — all
          already one cohesive block inside ReportDraftWorkspace. */}
      <ReportDraftWorkspace
        currentUser={currentUser} users={users} clients={myClients} employees={selectableAgents} reports={reports}
        dailyLogs={dailyLogs} extraNotes={extraNotes} tasks={tasks} taskAssignees={taskAssignees}
        scopeKind={scopeKind} onScopeKindChange={setScopeKind}
        clientId={clientId} onClientIdChange={setClientId}
        subjectUserId={subjectUserId} onSubjectUserIdChange={setSubjectUserId}
        employeeScopeMode={employeeScopeMode} onEmployeeScopeModeChange={setEmployeeScopeMode}
        selectedClientIds={selectedClientIds} onSelectedClientIdsChange={setSelectedClientIds}
        periodStart={periodStart} onPeriodStartChange={setPeriodStart}
        periodEnd={periodEnd} onPeriodEndChange={setPeriodEnd}
        openReportId={workspaceReportId} onOpenReportHandled={() => setWorkspaceReportId(null)}
        onReportChanged={handleWorkspaceReportChanged} onReportDeleted={handleWorkspaceReportDeleted}
        onRequestAiSummary={onGenerateAiSummary ? requestDraftAiSummary : undefined}
      />

      {/* Merged daily-activity feed (manager/leadership audience only), part of Sources. */}
      {canSeeDailyActivityReport && (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-amber-400" />
              <span>Daily Activity Log ({filteredDailyLogs.length})</span>
            </h3>
            {clientsWithLogs.length > 0 && (
              <select
                value={dailyLogClientFilter}
                onChange={(e) => setDailyLogClientFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] bg-stone-900 border border-stone-800 text-white outline-none focus:border-purple-400"
              >
                <option value="all" className="bg-stone-900">All Clients</option>
                {clientsWithLogs.map((c) => (
                  <option key={c.id} value={c.id} className="bg-stone-900">
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {dailyLogActionError && (
            <p className="text-xs text-[var(--roas-bad)] font-semibold">{dailyLogActionError}</p>
          )}

          {filteredDailyLogs.length === 0 ? (
            <p className="text-xs text-stone-500 py-4 text-center">No daily activity logged yet for this scope.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
              {filteredDailyLogs.map((log) => {
                const logUser = users.find((u) => u.id === log.user_id);
                const logClient = log.client_id ? clients.find((c) => c.id === log.client_id) : null;
                const isFutureLog = log.date > todayStr;
                const canEditThisLog = canEditOwnDailyLog(log, currentUser.id);
                return (
                  <div
                    key={log.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedDailyLog(log)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedDailyLog(log); } }}
                    className="p-3 rounded-xl border border-purple-900/30 bg-[#161224]/80 text-xs cursor-pointer hover:border-purple-500/50 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-400"
                    aria-label={`Open activity details for ${logUser?.name || 'employee'} on ${log.date}`}
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white">{logUser?.name || 'Employee'}</span>
                        <span className="text-stone-500 text-[11px]">({logUser?.team || logUser?.role})</span>
                        {logClient && (
                          <span className="text-[10px] font-bold text-purple-300 bg-purple-950/50 px-2 py-0.5 rounded-full border border-purple-800/60">
                            {logClient.name}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {isFutureLog && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase bg-sky-900/60 text-sky-300 border border-sky-700/50">
                            Future
                          </span>
                        )}
                        <span className="text-[11px] font-mono text-stone-500">{log.date}</span>
                        {canEditThisLog && (
                          <>
                            <button
                              onClick={(event) => { event.stopPropagation(); setEditingDailyLog(log); }}
                              className="p-1 rounded bg-stone-900 text-stone-400 hover:text-white"
                              title="Edit this log"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                            <button
                              onClick={(event) => { event.stopPropagation(); void handleDeleteDailyLogClick(log); }}
                              className="p-1 rounded bg-stone-900 text-stone-400 hover:text-red-400"
                              title="Delete this log"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <p className="text-stone-300 mt-1.5 whitespace-pre-wrap break-words">{log.summary_text}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 3) Comparison — same resolvedScope as Setup, its own two editable periods A/B. */}
      <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-purple-400" />
          <span>Comparison</span>
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setReportMode('comparison')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              reportMode === 'comparison' ? 'reports-filled-action filled-purple-action bg-purple-600 text-white shadow' : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
            }`}
          >
            Comparison Report
          </button>
          <button
            onClick={() => setReportMode('period_summary')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              reportMode === 'period_summary' ? 'reports-filled-action filled-purple-action bg-purple-600 text-white shadow' : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
            }`}
          >
            Period Report
          </button>
        </div>

        <div className={`grid grid-cols-1 ${isSinglePeriod ? '' : 'sm:grid-cols-2'} gap-3`}>
          <div className="space-y-1.5">
            <p className="text-[11px] text-stone-400">Period A (current)</p>
            <div className="grid grid-cols-2 gap-2">
              <input type="date" value={customCurrentRange.start} onChange={(event) => { comparisonPeriodTouched.current = true; setCustomCurrentRange((current) => ({ ...current, start: event.target.value })); }} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
              <input type="date" value={customCurrentRange.end} onChange={(event) => { comparisonPeriodTouched.current = true; setCustomCurrentRange((current) => ({ ...current, end: event.target.value })); }} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
            </div>
          </div>
          {!isSinglePeriod && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-stone-400">Period B (previous)</p>
              <div className="grid grid-cols-2 gap-2">
                <input type="date" value={customPreviousRange.start} onChange={(event) => { comparisonPeriodTouched.current = true; setCustomPreviousRange((current) => ({ ...current, start: event.target.value })); }} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
                <input type="date" value={customPreviousRange.end} onChange={(event) => { comparisonPeriodTouched.current = true; setCustomPreviousRange((current) => ({ ...current, end: event.target.value })); }} className="px-3 py-2 rounded-lg text-xs bg-[#100c1c] border border-purple-900/50 text-white" />
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          disabled={!resolvedScope || isGenerating}
          onClick={handleGenerate}
          className="filled-purple-action px-3 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-50"
        >
          {isGenerating ? 'Calculating…' : 'Calculate comparison'}
        </button>

        {visibleComparisons.length === 0 ? (
          <p className="text-xs text-stone-500 py-4 text-center">No comparisons generated yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
              <select value={selectedComparison?.id || ''} onChange={(event) => setSelectedComparisonId(event.target.value)} className="flex-1 px-3 py-2 rounded-xl text-xs bg-[#100c1c] border border-purple-900/50 text-white">
                {visibleComparisons.map((comparison) => <option key={comparison.id} value={comparison.id}>{describeComparisonScope(comparison, clients, users)} · {comparison.period_current}{comparison.period_previous ? ` vs ${comparison.period_previous}` : ''}</option>)}
              </select>
              <button
                type="button"
                disabled={!selectedComparison || generatingReportForComparisonId === selectedComparison.id}
                onClick={() => selectedComparison && void handleGenerateReport(selectedComparison)}
                className="filled-purple-action px-3 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-50"
              >
                {selectedComparison && generatingReportForComparisonId === selectedComparison.id ? 'Saving report…' : 'Save selected as report'}
              </button>
            </div>
            {selectedComparison && (() => {
              const anomalyResult = selectedComparison.client_id ? anomaliesByClientId.get(selectedComparison.client_id) : undefined;
              const anomalyFlags = anomalyResult?.latestComparisonId === selectedComparison.id ? anomalyResult.flags : undefined;
              return (
              <ComparisonCard
                comparison={selectedComparison}
                subtitle={describeComparisonScope(selectedComparison, clients, users)}
                viewerServiceFilter={viewerServiceFilter}
                anomalyFlags={anomalyFlags}
                unconnectedServices={unconnectedServices}
                onGenerateAiSummary={onGenerateAiSummary}
              />
              );
            })()}
          </div>
        )}
      </div>

      {/* 7) Saved + Archived reports list. */}
      <div className="space-y-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <FileText className="w-4 h-4 text-purple-400" />
          <span>Reports ({filteredReports.length})</span>
        </h3>
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={reportSearch} onChange={(event) => setReportSearch(event.target.value)} placeholder="Search period, scope, author, client, or employee…" className="w-full pl-9 pr-3 py-2 rounded-xl text-xs bg-[#100c1c] border border-purple-900/50 text-white placeholder-stone-500" />
          </div>
          <select value={reportListFilter} onChange={(event) => setReportListFilter(event.target.value as 'all' | 'active' | 'archived')} className="px-3 py-2 rounded-xl text-xs bg-[#100c1c] border border-purple-900/50 text-white">
            <option value="all">All (saved + archived)</option><option value="active">Saved only</option><option value="archived">Archived only</option>
          </select>
          <select value={reportStatusFilter} onChange={(event) => setReportStatusFilter(event.target.value as 'all' | 'draft' | 'final')} className="px-3 py-2 rounded-xl text-xs bg-[#100c1c] border border-purple-900/50 text-white">
            <option value="all">All statuses</option><option value="draft">Draft</option><option value="final">Final</option>
          </select>
        </div>
        <FiledReportsList reports={filteredReports} comparisons={clientComparisons} clients={clients} users={users} showScope archiveMode="all" onSelectReport={openFiledReport} />
      </div>

      {editingDailyLog && (
        <DailyLogEditModal
          log={editingDailyLog}
          clients={clients}
          tasks={tasks}
          onSave={handleSaveEditedDailyLog}
          onClose={() => setEditingDailyLog(null)}
        />
      )}

      {selectedDailyLog && (() => {
        const logUser = users.find((user) => user.id === selectedDailyLog.user_id);
        const logClient = selectedDailyLog.client_id ? clients.find((client) => client.id === selectedDailyLog.client_id) : null;
        const linkedIds = new Set(selectedDailyLog.linked_task_ids || []);
        const linkedTasks = tasks.filter((task) => linkedIds.has(task.id));
        const missingTaskCount = linkedIds.size - linkedTasks.length;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm" onClick={() => setSelectedDailyLog(null)}>
            <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-purple-900/50 bg-[#161224] p-5 space-y-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-white">Daily activity details</h3>
                  <p className="text-[11px] text-stone-400">Saved daily_logs record · {selectedDailyLog.date}</p>
                </div>
                <button type="button" onClick={() => setSelectedDailyLog(null)} className="p-1.5 rounded-lg text-stone-400 hover:text-white" aria-label="Close activity details"><X className="w-4 h-4" /></button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                <div className="rounded-lg bg-stone-950/50 p-2"><span className="text-stone-500 block">Employee</span><span className="text-white">{logUser?.name || 'Unknown employee'}</span></div>
                <div className="rounded-lg bg-stone-950/50 p-2"><span className="text-stone-500 block">Client</span><span className="text-white">{logClient?.name || 'No client linked'}</span></div>
                <div className="rounded-lg bg-stone-950/50 p-2"><span className="text-stone-500 block">Created</span><span className="text-white">{selectedDailyLog.created_at ? new Date(selectedDailyLog.created_at).toLocaleString() : 'Not available'}</span></div>
              </div>
              <div className="rounded-xl border border-stone-800 p-3">
                <p className="text-[11px] font-bold text-stone-400 uppercase mb-2">Activity summary</p>
                <p className="text-sm text-stone-200 whitespace-pre-wrap break-words">{selectedDailyLog.summary_text}</p>
              </div>
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-white">Explicitly linked tasks ({linkedIds.size})</h4>
                {linkedIds.size === 0 ? <p className="text-[11px] text-stone-500">This activity did not save any task links. No relationship is inferred from matching text or dates.</p> : linkedTasks.length === 0 ? <p className="text-[11px] text-amber-300">The saved task references are not available in your current authorized task data.</p> : linkedTasks.map((task) => (
                  <div key={task.id} className="rounded-xl border border-stone-800 bg-stone-950/30 p-3 text-[11px]">
                    <div className="flex items-center justify-between gap-2"><span className="font-bold text-white">{task.title}</span><span className="uppercase text-purple-300">{task.status.replace('_', ' ')}</span></div>
                    <p className="text-stone-400 mt-1">Due {task.due_date || 'not set'} · {task.priority} priority{task.completed_at ? ` · completed ${new Date(task.completed_at).toLocaleString()}` : ''}</p>
                    {task.done_link && <a href={task.done_link} target="_blank" rel="noreferrer" className="text-purple-300 hover:text-purple-200 mt-1 inline-block">Open submitted work</a>}
                  </div>
                ))}
                {missingTaskCount > 0 && linkedTasks.length > 0 && <p className="text-[11px] text-amber-300">{missingTaskCount} saved task reference(s) are outside the currently visible task set.</p>}
              </div>
            </div>
          </div>
        );
      })()}

      {selectedLegacyReport && (() => {
        const comparison = clientComparisons.find((item) => item.id === selectedLegacyReport.comparison_id) || null;
        const author = users.find((user) => user.id === selectedLegacyReport.generated_by);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm" onClick={() => setSelectedLegacyReport(null)}>
            <div className="w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-2xl border border-purple-900/50 bg-[#161224] p-5 space-y-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-start justify-between gap-3">
                <div><h3 className="text-sm font-bold text-white">Filed legacy report</h3><p className="text-[11px] text-stone-400">{selectedLegacyReport.period} · {selectedLegacyReport.type} · {selectedLegacyReport.status || 'legacy'} · filed by {author?.name || 'Unknown'}</p></div>
                <button type="button" onClick={() => setSelectedLegacyReport(null)} className="p-1.5 rounded-lg text-stone-400 hover:text-white" aria-label="Close report"><X className="w-4 h-4" /></button>
              </div>
              {comparison ? <ComparisonCard comparison={comparison} subtitle={describeComparisonScope(comparison, clients, users)} viewerServiceFilter={viewerServiceFilter} /> : <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-4 text-xs text-amber-200">This legacy report has no accessible saved comparison/content reference. The record is preserved, but no content is fabricated from current mutable data.</div>}
              <p className="text-[11px] text-stone-500">Legacy reports predate immutable report versions and source ledgers. They remain read-only and are not auto-classified as test data.</p>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
