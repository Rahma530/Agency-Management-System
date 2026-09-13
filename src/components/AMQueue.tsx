import React, { useState, useMemo } from 'react';
import {
  Inbox,
  UserCheck,
  ChevronRight,
  FileText,
  Building2,
  Calendar,
  DollarSign,
  Layers,
  Sparkles,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Clock,
  Shield,
  Send,
  Info,
  ExternalLink,
  Eye,
  Gauge,
  Search,
} from 'lucide-react';
import {
  ClientRecord,
  ClientStatus,
  UserRecord,
  BriefRecord,
  BriefRevisionRecord,
  ServiceType,
  UserRole,
  CampaignRecord,
  TaskRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  AssignmentRecord,
  TaskStatus,
  ReportRecord,
  ClientComparisonRecord,
  SocialInsightRecord,
  ClientPortalUserRecord,
  MeetingRecord,
  PlatformConnectionRecord,
  PlatformConnectionStatus,
  PlatformCategory,
  ClientContractRecord,
  BriefFieldDef,
  BriefFieldSchemaRow,
} from '../types/database';
import { AppModuleId } from '../data/roles';
import { getUserCapacityData, getCapacityIndicator } from '../lib/capacity';
import { isActiveEmployee, canSeeContractValue } from '../lib/permissions';
import { matchesClientQuery } from '../lib/clientSearch';
import { ClientDashboard } from './ClientDashboard';
import { ComparisonGranularity, DateRange, ReportMode, ReportScope } from '../lib/reportingEngine';

interface AMQueueProps {
  clients: ClientRecord[];
  users: UserRecord[];
  briefs: BriefRecord[];
  briefRevisions?: BriefRevisionRecord[];
  campaigns?: CampaignRecord[];
  tasks?: TaskRecord[];
  dailyLogs?: DailyLogRecord[];
  extraNotes?: ExtraNoteRecord[];
  assignments?: AssignmentRecord[];
  reports?: ReportRecord[];
  clientComparisons?: ClientComparisonRecord[];
  socialInsights?: SocialInsightRecord[];
  clientPortalUsers?: ClientPortalUserRecord[];
  currentUser?: UserRecord;
  currentUserId?: string;
  onAssignAMAgent: (clientId: string, agentId: string) => Promise<void>;
  onSaveBrief: (briefData: {
    client_id: string;
    service_type: ServiceType;
    fields: Record<string, any>;
    version: number;
    submitted_by: string;
    custom_field_defs: BriefFieldDef[];
  }) => Promise<void>;
  briefFieldSchemas: Record<ServiceType, BriefFieldDef[]>;
  briefFieldSchemaRows: BriefFieldSchemaRow[];
  onCreateBriefFieldSchema?: (row: Omit<BriefFieldSchemaRow, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onUpdateBriefFieldSchema?: (id: string, updates: Partial<BriefFieldSchemaRow>) => Promise<void>;
  onDeleteBriefFieldSchema?: (id: string) => Promise<void>;
  onDeleteClient?: (clientId: string) => Promise<void>;
  onUpdateTaskStatus?: (taskId: string, newStatus: TaskStatus) => Promise<void>;
  onUpdateClientStatus?: (
    clientId: string,
    newStatus: ClientStatus,
    options?: { churn_reason?: string; renewal_date?: string }
  ) => Promise<void>;
  onMarkClientViewed?: (clientId: string) => Promise<void> | void;
  onNavigateToModule?: (module: AppModuleId, prefillAssigneeName?: string) => void;
  onGenerateComparison?: (
    scope: ReportScope,
    mode: ReportMode,
    granularity: ComparisonGranularity | 'custom',
    custom?: { currentRange: DateRange; previousRange?: DateRange }
  ) => Promise<void>;
  onGenerateReport?: (comparisonId: string, period: string) => Promise<void>;
  onGenerateMonthlyReportDraft?: (clientId: string) => Promise<void>;
  onApproveReport?: (reportId: string) => Promise<void>;
  onCreatePortalLogin?: (clientId: string, email: string) => Promise<void>;
  meetings?: MeetingRecord[];
  onUploadMeetingRecording?: (clientId: string, meetingDate: string, file: File) => Promise<void>;
  onSaveMeetingNotes?: (
    meetingId: string,
    updates: { transcript_text?: string; ai_summary_text?: string }
  ) => Promise<void>;
  platformConnections?: PlatformConnectionRecord[];
  onSetPlatformConnectionStatus?: (
    clientId: string,
    platformName: string,
    platformCategory: PlatformCategory,
    status: PlatformConnectionStatus,
    notes: string
  ) => Promise<void>;
  clientContracts?: ClientContractRecord[];
  onUploadClientContract?: (clientId: string, file: File) => Promise<void>;
  onDeleteClientContract?: (contractId: string) => Promise<void>;
  onUpdatePaymentTracking?: (
    clientId: string,
    updates: { due_value?: number | null; remaining_value?: number | null; contract_duration_months?: number | null }
  ) => Promise<void>;
}

export const AMQueue: React.FC<AMQueueProps> = ({
  clients,
  users,
  briefs,
  briefRevisions = [],
  campaigns = [],
  tasks = [],
  dailyLogs = [],
  extraNotes = [],
  assignments = [],
  reports = [],
  clientComparisons = [],
  socialInsights = [],
  clientPortalUsers = [],
  currentUser,
  currentUserId,
  onAssignAMAgent,
  onSaveBrief,
  briefFieldSchemas,
  briefFieldSchemaRows,
  onCreateBriefFieldSchema,
  onUpdateBriefFieldSchema,
  onDeleteBriefFieldSchema,
  onDeleteClient,
  onUpdateTaskStatus,
  onUpdateClientStatus,
  onMarkClientViewed,
  onNavigateToModule,
  onGenerateComparison,
  onGenerateReport,
  onGenerateMonthlyReportDraft,
  onApproveReport,
  onCreatePortalLogin,
  meetings = [],
  onUploadMeetingRecording,
  onSaveMeetingNotes,
  platformConnections = [],
  onSetPlatformConnectionStatus,
  clientContracts = [],
  onUploadClientContract,
  onDeleteClientContract,
  onUpdatePaymentTracking,
}) => {
  const resolvedUser = currentUser || users.find((u) => u.id === currentUserId) || users[0];
  const effectiveUserId = resolvedUser?.id || currentUserId || '';
  const currentRole = resolvedUser?.role || 'am_agent';
  const isAMTeamLead = currentRole === 'am_team_lead';
  const isAMAgent = currentRole === 'am_agent';
  const isExecutive = currentRole === 'executive' || currentRole === 'head_of_technical';

  // Role Security Check
  if (!isAMTeamLead && !isAMAgent && !isExecutive) {
    return (
      <div className="p-8 rounded-2xl bg-red-950/30 border border-red-800/40 text-center space-y-3">
        <Shield className="w-10 h-10 text-red-400 mx-auto" />
        <h3 className="text-base font-bold text-white">Access Restricted</h3>
        <p className="text-xs text-stone-300 max-w-md mx-auto">
          Client Onboarding & Reception is accessible exclusively to Account Management and Executive leadership.
        </p>
      </div>
    );
  }

  // Strict Client Filtering:
  // - Module 13: every ClientRecord is created at 'onboarding' already (that creation IS the
  //   Sales -> AM Team Lead handoff) — there's no more pre-handoff 'lead' stage to filter out.
  // - AM Agent: ONLY view clients assigned specifically to that AM Agent.
  // - AM Team Leader: View all clients managed by the AM team (assigned + unassigned), unfiltered by am_team_lead_id.
  const visibleClients = useMemo(() => {
    if (isAMAgent) {
      return clients.filter((c) => c.am_agent_id === effectiveUserId);
    }
    return clients;
  }, [clients, isAMAgent, effectiveUserId]);

  // Module 12 Phase 8: clients due for renewal, within the same am_team_lead/am_agent scope
  // as visibleClients above (full portfolio vs. own-assigned-only).
  const renewalClients = useMemo(
    () => visibleClients.filter((c) => c.status === 'renewal'),
    [visibleClients]
  );

  const [dashboardClientId, setDashboardClientId] = useState<string | null>(null);
  const [assigningAgentId, setAssigningAgentId] = useState<Record<string, string>>({});
  const [isAssigning, setIsAssigning] = useState<string | null>(null);
  const [assignMessage, setAssignMessage] = useState<{ id: string; text: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Module 14: search narrows only the rendered list below — the stats bar and Renewal Queue
  // above stay scoped to the full visibleClients portfolio, same precedent as SalesPortalView's
  // stat cards staying on personalClients while only its table rows use filteredClients.
  const displayedClients = useMemo(
    () => visibleClients.filter((c) => matchesClientQuery(c, searchQuery)),
    [visibleClients, searchQuery]
  );

  const amAgents = users.filter((u) => u.role === 'am_agent' && isActiveEmployee(u));
  const salesUsers = users.filter((u) => u.role === 'sales' && isActiveEmployee(u));

  const activeDashboardClient = useMemo(
    () => clients.find((c) => c.id === dashboardClientId) || null,
    [clients, dashboardClientId]
  );

  const handleAssign = async (clientId: string) => {
    if (!isAMTeamLead && !isExecutive) return;
    const agentId = assigningAgentId[clientId];
    if (!agentId) return;

    setIsAssigning(clientId);
    try {
      await onAssignAMAgent(clientId, agentId);
      const agentName = users.find((u) => u.id === agentId)?.name || 'Agent';
      setAssignMessage({ id: clientId, text: `Successfully assigned to ${agentName}` });
      setTimeout(() => setAssignMessage(null), 3000);
    } catch (err: any) {
      console.error(err);
    } finally {
      setIsAssigning(null);
    }
  };

  const getClientBriefs = (clientId: string) => briefs.filter((b) => b.client_id === clientId);

  const getClientLifecycleStatus = (client: ClientRecord) => {
    if (!client.am_agent_id) {
      return {
        key: 'awaiting_am_assignment',
        label: 'Awaiting AM',
        color: 'var(--roas-mid)',
        bg: 'rgba(245, 226, 154, 0.15)',
        border: 'rgba(245, 226, 154, 0.3)',
      };
    }

    const services = client.services || [];
    const clientBriefs = getClientBriefs(client.id);
    const hasAllBriefs =
      services.length > 0 &&
      services.every((s) => clientBriefs.some((b) => b.service_type === s && b.version > 0));

    if (hasAllBriefs) {
      return {
        key: 'brief_submitted',
        label: 'Briefs Completed',
        color: 'var(--roas-good)',
        bg: 'rgba(169, 245, 193, 0.15)',
        border: 'rgba(169, 245, 193, 0.3)',
      };
    }

    return {
      key: 'brief_in_progress',
      label: 'Onboarding in Progress',
      color: 'var(--purple-light)',
      bg: 'rgba(123, 47, 247, 0.2)',
      border: 'rgba(123, 47, 247, 0.35)',
    };
  };

  return (
    <div className="space-y-6">
      {/* Module Header */}
      <div
        className="p-5 rounded-2xl border relative overflow-hidden backdrop-blur-md flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        style={{
          background: 'var(--gradient-card)',
          borderColor: 'var(--border-medium)',
        }}
      >
        <div className="flex items-center gap-3.5">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 shadow-lg"
            style={{
              background: 'rgba(123, 47, 247, 0.25)',
              border: '1px solid var(--border-soft)',
              color: 'var(--purple-light)',
            }}
          >
            <Inbox className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white">
                {isAMTeamLead ? 'Client Onboarding & Reception' : 'My Assigned Clients'}
              </h2>
              <span
                className="text-[10px] px-2.5 py-0.5 rounded-full font-bold border"
                style={{
                  background: isAMTeamLead ? 'rgba(123, 47, 247, 0.2)' : 'rgba(168, 155, 184, 0.15)',
                  color: isAMTeamLead ? 'var(--purple-light)' : 'var(--lilac)',
                  borderColor: 'var(--border-soft)',
                }}
              >
                {isAMTeamLead ? 'AM Team Lead' : 'AM Specialist'}
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              {isAMTeamLead
                ? 'Manage newly acquired clients, distribute account assignments, and monitor service onboarding.'
                : 'Manage your portfolio of assigned clients and coordinate service deliverables.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-center">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-purple-950/40 border border-purple-800/40 text-xs text-purple-200">
            <Info className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span>{isAMTeamLead ? 'Full Assignment Control' : 'Assigned Client Scope'}</span>
          </div>
          {isAMTeamLead && onNavigateToModule && (
            <button
              onClick={() => onNavigateToModule('capacity')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-purple-200 bg-purple-900/30 hover:bg-purple-800/50 hover:text-white border border-purple-700/40 transition-all"
            >
              <Gauge className="w-3.5 h-3.5" />
              <span>View Team Capacity</span>
            </button>
          )}
        </div>
      </div>

      {/* Overview Stats Bar */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div
          className="p-4 rounded-xl flex items-center justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-soft)' }}
        >
          <div>
            <p className="text-xs font-semibold text-stone-400">Total In Onboarding</p>
            <p className="text-2xl font-bold text-white mt-1">
              {visibleClients.filter((c) => c.status === 'onboarding').length}
            </p>
          </div>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-purple-900/30 text-purple-300 border border-purple-800/30">
            <Inbox className="w-4 h-4" />
          </div>
        </div>

        <div
          className="p-4 rounded-xl flex items-center justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-soft)' }}
        >
          <div>
            <p className="text-xs font-semibold text-stone-400">
              {isAMTeamLead ? 'Awaiting Assignment' : 'Pending Briefs'}
            </p>
            <p className="text-2xl font-bold mt-1 text-amber-300">
              {isAMTeamLead
                ? visibleClients.filter((c) => !c.am_agent_id).length
                : visibleClients.filter((c) => {
                    const brfs = getClientBriefs(c.id);
                    return (c.services || []).some((s) => !brfs.some((b) => b.service_type === s));
                  }).length}
            </p>
          </div>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-amber-950/30 text-amber-300 border border-amber-800/30">
            <Clock className="w-4 h-4" />
          </div>
        </div>

        <div
          className="p-4 rounded-xl flex items-center justify-between"
          style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-soft)' }}
        >
          <div>
            <p className="text-xs font-semibold text-stone-400">Documented Briefs</p>
            <p className="text-2xl font-bold mt-1 text-emerald-400">
              {briefs.filter((b) => visibleClients.some((c) => c.id === b.client_id)).length}
            </p>
          </div>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-emerald-950/30 text-emerald-300 border border-emerald-800/30">
            <FileText className="w-4 h-4" />
          </div>
        </div>
      </div>

      {/* Module 12 Phase 8: Renewal Queue — clients in 'renewal' status, with quick access to
          the existing renewal-confirmation action in ClientDashboard's Client Lifecycle card. */}
      {renewalClients.length > 0 && (
        <div
          className="rounded-2xl border overflow-hidden"
          style={{ background: 'var(--gradient-card)', borderColor: 'rgba(245, 226, 154, 0.3)' }}
        >
          <div className="p-4 border-b border-amber-800/30 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-amber-300" />
              <h3 className="text-sm font-bold text-white">Renewal Queue</h3>
            </div>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-bold bg-amber-950/60 text-amber-300 border border-amber-800/40">
              {renewalClients.length} pending
            </span>
          </div>
          <div className="divide-y divide-amber-900/20">
            {renewalClients.map((c) => (
              <div key={c.id} className="p-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white truncate">{c.name}</p>
                  <p className="text-[11px] text-stone-400">
                    Renewal Date: <strong className="text-amber-300">{c.renewal_date || 'Not set'}</strong>
                    {canSeeContractValue(currentRole, c.sales_owner_id === effectiveUserId) && c.contract_value
                      ? ` • ${c.contract_value.toLocaleString()} SAR/mo`
                      : ''}
                  </p>
                </div>
                <button
                  onClick={() => setDashboardClientId(c.id)}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-amber-200 bg-amber-900/30 hover:bg-amber-800/50 hover:text-white border border-amber-700/40 transition-all shrink-0 flex items-center gap-1.5"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>View Dashboard</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lightweight Client List */}
      <div
        className="rounded-2xl border overflow-hidden"
        style={{
          background: 'var(--gradient-card)',
          borderColor: 'var(--border-medium)',
        }}
      >
        <div className="p-4 border-b border-purple-900/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-bold text-white">Client Portfolio</h3>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative w-full sm:w-64">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search name or phone..."
                className="w-full pl-9 pr-3 py-1.5 rounded-xl text-xs bg-black/30 border border-purple-900/40 text-white outline-none focus:border-purple-400"
              />
            </div>
            <span className="text-xs text-stone-400 whitespace-nowrap">
              Showing <strong className="text-white">{displayedClients.length}</strong> clients
            </span>
          </div>
        </div>

        {displayedClients.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-xs text-stone-400">
              {searchQuery
                ? 'No clients match your search.'
                : isAMAgent
                ? 'No clients currently assigned to your account. Your Team Leader will assign new clients upon intake.'
                : 'No clients found in the onboarding queue.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-purple-900/30 text-[11px] font-semibold text-stone-400 uppercase tracking-wider bg-black/20">
                  <th className="py-3 px-4">Client Name</th>
                  <th className="py-3 px-4">Industry</th>
                  <th className="py-3 px-4">Services</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Assigned AM</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-purple-900/20 text-xs">
                {displayedClients.map((client) => {
                  const assignedAgent = amAgents.find((u) => u.id === client.am_agent_id);
                  const lifecycle = getClientLifecycleStatus(client);
                  const services = client.services || [];

                  return (
                    <tr
                      key={client.id}
                      onClick={() => setDashboardClientId(client.id)}
                      className="hover:bg-purple-950/30 transition-colors cursor-pointer group"
                    >
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-purple-900/30 border border-purple-700/30 flex items-center justify-center font-bold text-purple-300">
                            {client.name.charAt(0)}
                          </div>
                          <div>
                            <span className="font-bold text-white group-hover:text-purple-300 transition-colors inline-flex items-center gap-1.5">
                              {client.name}
                              {isAMTeamLead &&
                                client.am_team_lead_id === resolvedUser?.id &&
                                !client.am_team_lead_viewed_at && (
                                  <span className="px-1.5 py-0.2 rounded-full text-[9px] font-bold uppercase bg-purple-600 text-white">
                                    New
                                  </span>
                                )}
                            </span>
                            <span className="text-[10px] text-stone-400 block font-mono">
                              {client.id}
                            </span>
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-stone-300">
                        {client.industry || 'General Business'}
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="space-y-1">
                          {services.length === 0 && (
                            <span className="text-white font-medium block">Custom Plan</span>
                          )}
                          <div className="flex flex-wrap gap-1">
                            {services.map((s) => (
                              <span
                                key={s}
                                className="px-1.5 py-0.2 rounded text-[9px] font-bold uppercase tracking-wider"
                                style={{
                                  background:
                                    s === 'media_buying'
                                      ? 'rgba(14, 165, 233, 0.2)'
                                      : s === 'seo'
                                      ? 'rgba(16, 185, 129, 0.2)'
                                      : 'rgba(236, 72, 153, 0.2)',
                                  color:
                                    s === 'media_buying'
                                      ? '#38bdf8'
                                      : s === 'seo'
                                      ? '#34d399'
                                      : '#f472b6',
                                }}
                              >
                                {s.replace('_', ' ')}
                              </span>
                            ))}
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <span
                          className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold inline-block"
                          style={{
                            background: lifecycle.bg,
                            color: lifecycle.color,
                            border: `1px solid ${lifecycle.border}`,
                          }}
                        >
                          {lifecycle.label}
                        </span>
                      </td>

                      <td className="py-3.5 px-4" onClick={(e) => isAMTeamLead && e.stopPropagation()}>
                        {isAMTeamLead ? (
                          <div className="flex items-center gap-1.5">
                            <select
                              value={assigningAgentId[client.id] || client.am_agent_id || ''}
                              onChange={(e) =>
                                setAssigningAgentId({
                                  ...assigningAgentId,
                                  [client.id]: e.target.value,
                                })
                              }
                              className="px-2 py-1 rounded-lg text-xs bg-[#120d1e] border border-purple-900/40 text-white focus:outline-none focus:border-purple-400"
                            >
                              <option value="">-- Assign AM --</option>
                              {amAgents.map((ag) => {
                                const capacityData = getUserCapacityData(ag, clients);
                                return (
                                  <option key={ag.id} value={ag.id}>
                                    {ag.name} {getCapacityIndicator(capacityData)}
                                  </option>
                                );
                              })}
                            </select>
                            {assigningAgentId[client.id] &&
                              assigningAgentId[client.id] !== client.am_agent_id && (
                                <button
                                  onClick={() => handleAssign(client.id)}
                                  disabled={isAssigning === client.id}
                                  className="px-2 py-1 rounded text-[11px] font-bold bg-purple-600 hover:bg-purple-500 text-white"
                                >
                                  Save
                                </button>
                              )}
                          </div>
                        ) : (
                          <span className={assignedAgent ? 'text-purple-300 font-medium' : 'text-amber-400'}>
                            {assignedAgent ? assignedAgent.name : 'Unassigned'}
                          </span>
                        )}
                        {assignMessage && assignMessage.id === client.id && (
                          <span className="text-[10px] text-emerald-400 block mt-0.5">
                            {assignMessage.text}
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDashboardClientId(client.id);
                          }}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all inline-flex items-center gap-1.5"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>View Dashboard</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* DEDICATED CLIENT DASHBOARD MODAL */}
      {activeDashboardClient && (
        <ClientDashboard
          client={activeDashboardClient}
          users={users}
          currentUser={resolvedUser}
          briefs={briefs}
          briefRevisions={briefRevisions}
          campaigns={campaigns}
          tasks={tasks}
          dailyLogs={dailyLogs}
          extraNotes={extraNotes}
          assignments={assignments}
          reports={reports}
          clientComparisons={clientComparisons}
          socialInsights={socialInsights}
          clientPortalUser={clientPortalUsers.find((cpu) => cpu.client_id === activeDashboardClient.id) || null}
          onClose={() => setDashboardClientId(null)}
          onSaveBrief={onSaveBrief}
          briefFieldSchemas={briefFieldSchemas}
          briefFieldSchemaRows={briefFieldSchemaRows}
          onCreateBriefFieldSchema={onCreateBriefFieldSchema}
          onUpdateBriefFieldSchema={onUpdateBriefFieldSchema}
          onDeleteBriefFieldSchema={onDeleteBriefFieldSchema}
          onDeleteClient={onDeleteClient}
          onAssignAMAgent={onAssignAMAgent}
          onUpdateTaskStatus={onUpdateTaskStatus}
          onUpdateClientStatus={onUpdateClientStatus}
          onMarkClientViewed={onMarkClientViewed}
          onGenerateComparison={onGenerateComparison}
          onGenerateReport={onGenerateReport}
          onGenerateMonthlyReportDraft={onGenerateMonthlyReportDraft}
          onApproveReport={onApproveReport}
          meetings={meetings}
          onUploadMeetingRecording={onUploadMeetingRecording}
          onSaveMeetingNotes={onSaveMeetingNotes}
          platformConnections={platformConnections}
          onSetPlatformConnectionStatus={onSetPlatformConnectionStatus}
          onCreatePortalLogin={onCreatePortalLogin}
          clientContracts={clientContracts}
          onUploadClientContract={onUploadClientContract}
          onDeleteClientContract={onDeleteClientContract}
          onUpdatePaymentTracking={onUpdatePaymentTracking}
        />
      )}
    </div>
  );
};
