import React, { useMemo, useState } from 'react';
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
import { PeriodSelector } from './reporting/PeriodSelector';
import {
  ComparisonCard,
  FiledReportsList,
  DirectAiSummaryPanel,
  describeComparisonScope,
  CampaignSummaryPayload,
  CampaignSummaryGenerationResult,
} from './reporting/ComparisonDisplay';
import { DailyLogEditModal } from './DailyLogEditModal';
import { ReportDraftWorkspace } from './reporting/ReportDraftWorkspace';

type ReportsHubScope = 'client' | 'own' | 'agent';

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
  onGenerateComparison: (
    scope: ReportScope,
    mode: ReportMode,
    granularity: ComparisonGranularity | 'custom',
    custom?: { currentRange: DateRange; previousRange?: DateRange }
  ) => Promise<ClientComparisonRecord | null>;
  onGenerateReport: (comparisonId: string, period: string) => Promise<void>;
  // Phase 4 (AI Orchestrator): same optional-prop convention as ComparisonCard's own
  // onGenerateAiSummary — reuses this hub's existing nav-level access gate exactly (whoever can
  // reach ReportsHub at all already sees canGenerateReport below unconditionally, so the AI button
  // gets no separate check either).
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
    if (report.scope_type === 'client' || report.scope_type === 'employee') {
      setWorkspaceReportId(report.id);
      setSelectedLegacyReport(null);
      return;
    }
    setSelectedLegacyReport(report);
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

  const [scope, setScope] = useState<ReportsHubScope>('own');
  const [selectedClientId, setSelectedClientId] = useState('');
  const [clientSearchQuery, setClientSearchQuery] = useState('');

  // Module 14: narrows the "Specific Client" select's options only — myClients itself (used for
  // the "All My Clients" count and the anomalies panel below) stays unfiltered.
  const searchedClients = useMemo(
    () => myClients.filter((c) => matchesClientQuery(c, clientSearchQuery)),
    [myClients, clientSearchQuery]
  );
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [reportMode, setReportMode] = useState<ReportMode>('comparison');
  const [granularity, setGranularity] = useState<ComparisonGranularity | 'custom'>('monthly');
  const [customCurrentRange, setCustomCurrentRange] = useState<DateRange>({ start: '', end: '' });
  const [customPreviousRange, setCustomPreviousRange] = useState<DateRange>({ start: '', end: '' });
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingReportForComparisonId, setGeneratingReportForComparisonId] = useState<string | null>(null);

  const isSinglePeriod = reportMode === 'period_summary';

  const resolvedScope: ReportScope | null =
    scope === 'client'
      ? selectedClientId
        ? { type: 'client', clientId: selectedClientId }
        : null
      : scope === 'own'
      ? { type: 'agent', agentId: currentUser.id }
      : selectedAgentId
      ? { type: 'agent', agentId: selectedAgentId }
      : null;

  const handleGenerate = async () => {
    if (!resolvedScope) return;
    if (granularity === 'custom') {
      const missingCurrent = !customCurrentRange.start || !customCurrentRange.end;
      const missingPrevious = !isSinglePeriod && (!customPreviousRange.start || !customPreviousRange.end);
      if (missingCurrent || missingPrevious) return;
    }
    setIsGenerating(true);
    try {
      await onGenerateComparison(
        resolvedScope,
        reportMode,
        granularity,
        granularity === 'custom'
          ? { currentRange: customCurrentRange, previousRange: isSinglePeriod ? undefined : customPreviousRange }
          : undefined
      );
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
  // falling through to onGenerateComparison. Returns null with no side effect when no scope is
  // selected yet, same as PeriodSelector's own canGenerate={!!resolvedScope} silently disabling the
  // plain generate button in that case.
  const ensureComparisonForSummary = (mode: ReportMode): Promise<ClientComparisonRecord | null> =>
    resolvedScope
      ? resolveOrGenerateComparison({
          scope: resolvedScope,
          mode,
          granularity,
          customCurrentRange,
          customPreviousRange,
          comparisons: visibleComparisons,
          onGenerateComparison,
        })
      : Promise.resolve(null);

  const visibleReports = useMemo(
    () =>
      reports
        .filter((r) => r.generated_by === currentUser.id || visibleComparisons.some((c) => c.id === r.comparison_id))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    [reports, visibleComparisons, currentUser.id]
  );

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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] text-stone-300">
        <div className="rounded-xl border border-stone-800 bg-stone-950/30 p-3"><strong className="text-white block mb-1">1. Calculate</strong>Select scope, report type, and period below. Generate calculates deterministic metrics and persists the comparison row.</div>
        <div className="rounded-xl border border-stone-800 bg-stone-950/30 p-3"><strong className="text-white block mb-1">2. AI review</strong>AI Summary uses that selected, saved comparison. Workspace rewrites remain proposals until explicitly applied as a version.</div>
        <div className="rounded-xl border border-stone-800 bg-stone-950/30 p-3"><strong className="text-white block mb-1">3. File & reopen</strong>Save versioned drafts in the Workspace. Filed Reports reopens the persisted content, history, and evidence available for each record.</div>
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

      <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Users className="w-4 h-4 text-purple-400" />
          <span>Scope</span>
        </h3>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setScope('own')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              scope === 'own' ? 'reports-filled-action filled-purple-action bg-purple-600 text-white shadow' : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
            }`}
          >
            All My Clients ({myClients.length})
          </button>
          <button
            onClick={() => setScope('client')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              scope === 'client' ? 'reports-filled-action filled-purple-action bg-purple-600 text-white shadow' : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
            }`}
          >
            Specific Client
          </button>
          {canSelectSpecificAgent && (
            <button
              onClick={() => setScope('agent')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                scope === 'agent' ? 'reports-filled-action filled-purple-action bg-purple-600 text-white shadow' : 'bg-stone-900/60 text-stone-400 hover:text-white border border-stone-800'
              }`}
            >
              Specific Agent
            </button>
          )}
        </div>

        {scope === 'client' && (
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
              value={selectedClientId}
              onChange={(e) => setSelectedClientId(e.target.value)}
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

        {scope === 'agent' && (
          <select
            value={selectedAgentId}
            onChange={(e) => setSelectedAgentId(e.target.value)}
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
      </div>

      <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-purple-400" />
          <span>Report Type</span>
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
        <p className="text-[11px] text-stone-400">
          {isSinglePeriod
            ? 'Totals for one period, no comparison.'
            : 'Current vs. prior period, with deltas and a recommendation.'}
        </p>
      </div>

      <PeriodSelector
        granularity={granularity}
        onGranularityChange={setGranularity}
        customCurrentRange={customCurrentRange}
        onCustomCurrentRangeChange={setCustomCurrentRange}
        customPreviousRange={customPreviousRange}
        onCustomPreviousRangeChange={setCustomPreviousRange}
        canGenerate={!!resolvedScope}
        isGenerating={isGenerating}
        onGenerate={handleGenerate}
        disabledReason="Select a scope first."
        singlePeriod={isSinglePeriod}
      />

      {!!resolvedScope && onGenerateAiSummary && (
        <DirectAiSummaryPanel
          mode={reportMode}
          onEnsureComparison={() => ensureComparisonForSummary(reportMode)}
          onGenerateAiSummary={onGenerateAiSummary}
          viewerServiceFilter={viewerServiceFilter}
        />
      )}

      <div className="space-y-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-emerald-400" />
          <span>Comparisons ({visibleComparisons.length})</span>
        </h3>

        {visibleComparisons.length === 0 ? (
          <p className="text-xs text-stone-500 py-4 text-center">No comparisons generated yet.</p>
        ) : (
          visibleComparisons.map((cmp) => {
            const anomalyResult = cmp.client_id ? anomaliesByClientId.get(cmp.client_id) : undefined;
            const anomalyFlags = anomalyResult?.latestComparisonId === cmp.id ? anomalyResult.flags : undefined;
            return (
              <ComparisonCard
                key={cmp.id}
                comparison={cmp}
                subtitle={describeComparisonScope(cmp, clients, users)}
                canGenerateReport
                isGeneratingReport={generatingReportForComparisonId === cmp.id}
                onGenerateReport={() => handleGenerateReport(cmp)}
                onGenerateAiSummary={onGenerateAiSummary}
                viewerServiceFilter={viewerServiceFilter}
                anomalyFlags={anomalyFlags}
              />
            );
          })
        )}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <FileText className="w-4 h-4 text-purple-400" />
          <span>Filed Reports ({visibleReports.length})</span>
        </h3>
        <FiledReportsList reports={visibleReports} comparisons={clientComparisons} clients={clients} users={users} showScope onSelectReport={openFiledReport} />
      </div>

      <ReportDraftWorkspace
        currentUser={currentUser}
        users={users}
        clients={myClients}
        employees={selectableAgents}
        reports={reports}
        dailyLogs={dailyLogs}
        extraNotes={extraNotes}
        tasks={tasks}
        taskAssignees={taskAssignees}
        openReportId={workspaceReportId}
        onOpenReportHandled={() => setWorkspaceReportId(null)}
        onReportChanged={onReportChanged}
        onReportDeleted={onReportDeleted}
      />

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
