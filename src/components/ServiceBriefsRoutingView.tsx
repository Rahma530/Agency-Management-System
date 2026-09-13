import React, { useState, useMemo } from 'react';
import {
  FileText,
  UserCheck,
  Calendar,
  CheckCircle2,
  Clock,
  AlertCircle,
  Shield,
  Send,
  Globe,
  Share2,
  Target,
  Search,
  Layers,
  ArrowRight,
  ExternalLink,
  ChevronRight,
  Sparkles,
  Info,
  Eye,
  Gauge,
  ClipboardCheck,
} from 'lucide-react';
import {
  ClientRecord,
  UserRecord,
  BriefRecord,
  BriefRevisionRecord,
  AssignmentRecord,
  CampaignRecord,
  TaskRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  ServiceType,
  UserRole,
  ReportRecord,
  ClientComparisonRecord,
  SocialInsightRecord,
  ClientPortalUserRecord,
  PlatformConnectionRecord,
  PlatformConnectionStatus,
  PlatformCategory,
} from '../types/database';
import { AppModuleId } from '../data/roles';
import { getUserCapacityData, getCapacityIndicator } from '../lib/capacity';
import { CLIENT_STATUS_META } from '../lib/clientStatus';
import { matchesClientQuery } from '../lib/clientSearch';
import { ClientDashboard } from './ClientDashboard';
import { BriefRepositoryView } from './BriefRepositoryView';
import { DynamicBriefForm } from './DynamicBriefForm';
import { BriefFieldSchemaEditor } from './BriefFieldSchemaEditor';
import { ComparisonGranularity, DateRange, ReportMode, ReportScope } from '../lib/reportingEngine';
import { canSeeContractValue, isActiveEmployee, canEditBriefFieldSchema } from '../lib/permissions';
import { reviewBrief, briefCompletenessScore } from '../lib/briefReview';
import { BriefFieldDef, BriefFieldSchemaRow } from '../types/database';

interface ServiceBriefsRoutingViewProps {
  currentUser: UserRecord;
  clients: ClientRecord[];
  briefs: BriefRecord[];
  briefRevisions?: BriefRevisionRecord[];
  assignments: AssignmentRecord[];
  users: UserRecord[];
  campaigns?: CampaignRecord[];
  tasks?: TaskRecord[];
  dailyLogs?: DailyLogRecord[];
  extraNotes?: ExtraNoteRecord[];
  reports?: ReportRecord[];
  clientComparisons?: ClientComparisonRecord[];
  socialInsights?: SocialInsightRecord[];
  clientPortalUsers?: ClientPortalUserRecord[];
  onAssignServiceAgent: (
    clientId: string,
    serviceType: ServiceType,
    agentId: string,
    reasonNotes?: string
  ) => Promise<void>;
  onMarkBriefViewed?: (briefId: string) => Promise<void> | void;
  onMarkAssignmentViewed?: (assignmentId: string) => Promise<void> | void;
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
  platformConnections?: PlatformConnectionRecord[];
  onSetPlatformConnectionStatus?: (
    clientId: string,
    platformName: string,
    platformCategory: PlatformCategory,
    status: PlatformConnectionStatus,
    notes: string
  ) => Promise<void>;
  onSaveBrief?: (briefData: {
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
}

// AM roles (am_team_lead, am_agent) don't work a single service — they need visibility into
// every service brief for the clients they manage, since AM owns the overall client relationship.
// This is a genuine read-only aggregated Brief Repository (BriefRepositoryView below) rather than
// a mode of the single-service workflow further down this file; "Open Full Dashboard" per client
// is the escape hatch into ClientDashboard's editable Briefs tab when that's actually needed.
const AMServiceBriefsPanel: React.FC<{
  currentUser: UserRecord;
  clients: ClientRecord[];
  briefs: BriefRecord[];
  briefRevisions: BriefRevisionRecord[];
  assignments: AssignmentRecord[];
  users: UserRecord[];
  campaigns: CampaignRecord[];
  tasks: TaskRecord[];
  dailyLogs: DailyLogRecord[];
  extraNotes: ExtraNoteRecord[];
  reports: ReportRecord[];
  clientComparisons: ClientComparisonRecord[];
  socialInsights: SocialInsightRecord[];
  clientPortalUsers: ClientPortalUserRecord[];
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
  platformConnections: PlatformConnectionRecord[];
  onSetPlatformConnectionStatus?: (
    clientId: string,
    platformName: string,
    platformCategory: PlatformCategory,
    status: PlatformConnectionStatus,
    notes: string
  ) => Promise<void>;
  onSaveBrief?: (briefData: {
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
}> = ({
  currentUser,
  clients,
  briefs,
  briefRevisions,
  assignments,
  users,
  campaigns,
  tasks,
  dailyLogs,
  extraNotes,
  reports,
  clientComparisons,
  socialInsights,
  clientPortalUsers,
  onGenerateComparison,
  onGenerateReport,
  onGenerateMonthlyReportDraft,
  onApproveReport,
  onCreatePortalLogin,
  platformConnections,
  onSetPlatformConnectionStatus,
  onSaveBrief,
  briefFieldSchemas,
  briefFieldSchemaRows,
  onCreateBriefFieldSchema,
  onUpdateBriefFieldSchema,
  onDeleteBriefFieldSchema,
  onDeleteClient,
}) => {
  const isTeamLead = currentUser.role === 'am_team_lead';

  // AM visibility: team lead sees every client; agent sees only clients personally assigned to them
  // (same rule as AMQueue.tsx's visibleClients — kept consistent rather than reinvented here).
  const authorizedClients = useMemo(
    () => (isTeamLead ? clients : clients.filter((c) => c.am_agent_id === currentUser.id)),
    [clients, isTeamLead, currentUser.id]
  );

  const [dashboardClientId, setDashboardClientId] = useState<string | null>(null);

  const clientServices = (client: ClientRecord): ServiceType[] => client.services || [];

  const clientBriefsDocumented = (client: ClientRecord) => {
    const services = clientServices(client);
    const documented = services.filter((s) => briefs.some((b) => b.client_id === client.id && b.service_type === s && b.version > 0));
    return { documented: documented.length, total: services.length };
  };

  const totalBriefsDocumented = briefs.filter((b) => authorizedClients.some((c) => c.id === b.client_id) && b.version > 0).length;
  const clientsMissingBriefs = authorizedClients.filter((c) => {
    const { documented, total } = clientBriefsDocumented(c);
    return total > 0 && documented < total;
  }).length;

  const activeDashboardClient = clients.find((c) => c.id === dashboardClientId) || null;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div
        className="p-5 rounded-2xl border relative overflow-hidden backdrop-blur-md flex flex-col md:flex-row md:items-center justify-between gap-4"
        style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-medium)' }}
      >
        <div className="flex items-center gap-3.5">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 shadow-lg"
            style={{ background: 'rgba(123, 47, 247, 0.25)', border: '1px solid var(--border-soft)', color: 'var(--purple-light)' }}
          >
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white">Service Briefs — Cross-Team Overview</h2>
              <span
                className="text-[10px] px-2.5 py-0.5 rounded-full font-bold border"
                style={{ background: 'rgba(123, 47, 247, 0.2)', color: 'var(--purple-light)', borderColor: 'var(--border-soft)' }}
              >
                {isTeamLead ? 'AM Team Lead' : 'AM Specialist'}
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              {isTeamLead
                ? 'Review every service brief across all clients managed by Account Management.'
                : 'Review every service brief — SEO, Social Media, Media Buying — for your assigned client portfolio.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-purple-950/40 border border-purple-800/40 text-xs text-purple-200 self-start md:self-center">
          <Info className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <span>Read-only across all services — assignment stays with each service team lead</span>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}>
          <div className="text-[11px] text-stone-400 font-semibold">{isTeamLead ? 'Total Clients' : 'My Assigned Clients'}</div>
          <div className="text-2xl font-bold text-white mt-1 font-mono">{authorizedClients.length}</div>
        </div>
        <div className="p-4 rounded-xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}>
          <div className="text-[11px] text-stone-400 font-semibold">Briefs Documented</div>
          <div className="text-2xl font-bold text-emerald-400 mt-1 font-mono">{totalBriefsDocumented}</div>
        </div>
        <div className="p-4 rounded-xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}>
          <div className="text-[11px] text-stone-400 font-semibold">Clients Missing a Brief</div>
          <div className="text-2xl font-bold text-amber-300 mt-1 font-mono">{clientsMissingBriefs}</div>
        </div>
      </div>

      {/* Brief Repository — genuine read-only, grouped-by-client, all services on one page */}
      {authorizedClients.length === 0 ? (
        <div className="p-8 text-center rounded-2xl border" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-medium)' }}>
          <p className="text-xs text-stone-400">
            {isTeamLead ? 'No clients found.' : 'No clients currently assigned to your account.'}
          </p>
        </div>
      ) : (
        <BriefRepositoryView
          clients={authorizedClients}
          briefs={briefs}
          briefRevisions={briefRevisions}
          users={users}
          briefFieldSchemas={briefFieldSchemas}
          onOpenFullDashboard={(clientId) => setDashboardClientId(clientId)}
        />
      )}

      {/* DEDICATED CLIENT DASHBOARD MODAL, opened straight to the Briefs tab */}
      {activeDashboardClient && (
        <ClientDashboard
          client={activeDashboardClient}
          users={users}
          currentUser={currentUser}
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
          initialTab="briefs"
          onClose={() => setDashboardClientId(null)}
          onSaveBrief={onSaveBrief}
          briefFieldSchemas={briefFieldSchemas}
          briefFieldSchemaRows={briefFieldSchemaRows}
          onCreateBriefFieldSchema={onCreateBriefFieldSchema}
          onUpdateBriefFieldSchema={onUpdateBriefFieldSchema}
          onDeleteBriefFieldSchema={onDeleteBriefFieldSchema}
          onDeleteClient={onDeleteClient}
          onGenerateComparison={onGenerateComparison}
          onGenerateReport={onGenerateReport}
          onGenerateMonthlyReportDraft={onGenerateMonthlyReportDraft}
          onApproveReport={onApproveReport}
          onCreatePortalLogin={onCreatePortalLogin}
          platformConnections={platformConnections}
          onSetPlatformConnectionStatus={onSetPlatformConnectionStatus}
        />
      )}
    </div>
  );
};

export const ServiceBriefsRoutingView: React.FC<ServiceBriefsRoutingViewProps> = ({
  currentUser,
  clients,
  briefs,
  briefRevisions = [],
  assignments,
  users,
  campaigns = [],
  tasks = [],
  dailyLogs = [],
  extraNotes = [],
  reports = [],
  clientComparisons = [],
  socialInsights = [],
  clientPortalUsers = [],
  onAssignServiceAgent,
  onMarkBriefViewed,
  onMarkAssignmentViewed,
  onNavigateToModule,
  onGenerateComparison,
  onGenerateReport,
  onGenerateMonthlyReportDraft,
  onApproveReport,
  onCreatePortalLogin,
  platformConnections = [],
  onSetPlatformConnectionStatus,
  onSaveBrief,
  briefFieldSchemas,
  briefFieldSchemaRows,
  onCreateBriefFieldSchema,
  onUpdateBriefFieldSchema,
  onDeleteBriefFieldSchema,
  onDeleteClient,
}) => {
  // AM roles get a dedicated cross-service overview instead of the single-service specialist
  // workflow below (they manage the overall client relationship, not one department's queue).
  if (currentUser.role === 'am_team_lead' || currentUser.role === 'am_agent') {
    return (
      <AMServiceBriefsPanel
        currentUser={currentUser}
        clients={clients}
        briefs={briefs}
        briefRevisions={briefRevisions}
        assignments={assignments}
        users={users}
        campaigns={campaigns}
        tasks={tasks}
        dailyLogs={dailyLogs}
        extraNotes={extraNotes}
        reports={reports}
        clientComparisons={clientComparisons}
        socialInsights={socialInsights}
        clientPortalUsers={clientPortalUsers}
        onGenerateComparison={onGenerateComparison}
        onGenerateReport={onGenerateReport}
        onGenerateMonthlyReportDraft={onGenerateMonthlyReportDraft}
        onApproveReport={onApproveReport}
        onCreatePortalLogin={onCreatePortalLogin}
        platformConnections={platformConnections}
        onSetPlatformConnectionStatus={onSetPlatformConnectionStatus}
        onSaveBrief={onSaveBrief}
        briefFieldSchemas={briefFieldSchemas}
        briefFieldSchemaRows={briefFieldSchemaRows}
        onCreateBriefFieldSchema={onCreateBriefFieldSchema}
        onUpdateBriefFieldSchema={onUpdateBriefFieldSchema}
        onDeleteBriefFieldSchema={onDeleteBriefFieldSchema}
        onDeleteClient={onDeleteClient}
      />
    );
  }

  // Determine service and role context
  const getServiceContext = (role: UserRole) => {
    if (role === 'seo_team_lead' || role === 'seo_agent') {
      return {
        serviceType: 'seo' as ServiceType,
        isTeamLead: role === 'seo_team_lead',
        agentRole: 'seo_agent' as UserRole,
        serviceNameEn: 'Search Engine Optimization (SEO)',
        departmentName: 'SEO & Organic Growth Department',
        leadRoleTitle: 'SEO Team Leader',
        agentRoleTitle: 'SEO Specialist',
        accentColor: '#10b981',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeText: '#34d399',
        icon: <Globe className="w-5 h-5 text-emerald-400" />,
      };
    }
    if (role === 'media_buying_team_lead' || role === 'media_buying_agent') {
      return {
        serviceType: 'media_buying' as ServiceType,
        isTeamLead: role === 'media_buying_team_lead',
        agentRole: 'media_buying_agent' as UserRole,
        serviceNameEn: 'Paid Advertising (Media Buying)',
        departmentName: 'Digital Media Buying Department',
        leadRoleTitle: 'Media Buying Team Leader',
        agentRoleTitle: 'Media Buying Specialist',
        accentColor: '#0ea5e9',
        badgeBg: 'rgba(14, 165, 233, 0.15)',
        badgeText: '#38bdf8',
        icon: <Target className="w-5 h-5 text-sky-400" />,
      };
    }
    if (role === 'social_media_team_lead' || role === 'social_media_agent') {
      return {
        serviceType: 'social_media' as ServiceType,
        isTeamLead: role === 'social_media_team_lead',
        agentRole: 'social_media_agent' as UserRole,
        serviceNameEn: 'Social Media Management',
        departmentName: 'Social Media & Community Department',
        leadRoleTitle: 'Social Media Team Leader',
        agentRoleTitle: 'Social Media Specialist',
        accentColor: '#ec4899',
        badgeBg: 'rgba(236, 72, 153, 0.15)',
        badgeText: '#f472b6',
        icon: <Share2 className="w-5 h-5 text-pink-400" />,
      };
    }
    return null;
  };

  const context = getServiceContext(currentUser.role);

  if (!context) {
    return (
      <div className="p-8 rounded-2xl bg-red-950/30 border border-red-800/40 text-center space-y-3">
        <AlertCircle className="w-10 h-10 text-red-400 mx-auto" />
        <h3 className="text-base font-bold text-white">Access Restricted</h3>
        <p className="text-xs text-stone-300">
          This portal is reserved for operational service teams (SEO, Social Media, Media Buying).
        </p>
      </div>
    );
  }

  const {
    serviceType,
    isTeamLead,
    agentRole,
    serviceNameEn,
    departmentName,
    leadRoleTitle,
    agentRoleTitle,
    icon,
  } = context;

  // Filter clients based on role and assignment rules:
  // - Team Leader: All clients whose package includes this service
  // - Service Agent: ONLY clients where assignment.agent_id === currentUser.id, in ANY
  //   service — being formally assigned to a client for one service is enough to unlock
  //   that client here too, since once inside ClientDashboard the agent can see that
  //   client's briefs across every service, not only serviceType (see ClientDashboard's
  //   clientBriefs, which is never filtered by service_type). This queue itself still
  //   only lists clients subscribed to serviceType, via the hasService check below.
  const authorizedClients = clients.filter((c) => {
    const hasService = (c.services || []).includes(serviceType);
    if (!hasService) return false;

    if (isTeamLead) {
      return true;
    } else {
      const myAssignment = assignments.find(
        (a) => a.client_id === c.id && a.agent_id === currentUser.id
      );
      return !!myAssignment;
    }
  });

  const [selectedClientId, setSelectedClientId] = useState<string | null>(
    authorizedClients[0]?.id || null
  );
  const [dashboardClientId, setDashboardClientId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending_assignment' | 'assigned'>('all');

  // Assignment state for Team Leader
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [assignmentNotes, setAssignmentNotes] = useState<string>('');
  const [isSubmittingAssignment, setIsSubmittingAssignment] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isSchemaEditorOpen, setIsSchemaEditorOpen] = useState(false);

  const eligibleAgents = users.filter((u) => u.role === agentRole && isActiveEmployee(u));

  const selectedClient =
    authorizedClients.find((c) => c.id === selectedClientId) || authorizedClients[0] || null;

  const serviceBrief = briefs.find(
    (b) => b.client_id === selectedClient?.id && b.service_type === serviceType
  );

  // Clear the "New" indicator on the currently-open brief once the relevant Team Lead sees it.
  React.useEffect(() => {
    if (isTeamLead && onMarkBriefViewed && serviceBrief && !serviceBrief.team_lead_viewed_at) {
      onMarkBriefViewed(serviceBrief.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeamLead, serviceBrief?.id, serviceBrief?.team_lead_viewed_at]);

  const currentAssignment = assignments.find(
    (a) => a.client_id === selectedClient?.id && a.service_type === serviceType
  );
  const assignedAgent = users.find((u) => u.id === currentAssignment?.agent_id);

  const getLifecycleStatus = (client: ClientRecord) => {
    const brf = briefs.find((b) => b.client_id === client.id && b.service_type === serviceType);
    const asg = assignments.find((a) => a.client_id === client.id && a.service_type === serviceType);

    if (!brf || brf.version === 0) {
      return {
        key: 'brief_in_progress',
        label: 'Brief in Progress',
        color: 'var(--roas-mid)',
        bg: 'rgba(245, 226, 154, 0.15)',
        border: 'rgba(245, 226, 154, 0.3)',
      };
    }
    if (!asg || !asg.agent_id) {
      return {
        key: 'awaiting_service_team_review',
        label: 'Awaiting Specialist Assignment',
        color: '#38bdf8',
        bg: 'rgba(14, 165, 233, 0.15)',
        border: 'rgba(14, 165, 233, 0.3)',
      };
    }
    return {
      key: 'ready_for_execution',
      label: `Assigned: ${users.find((u) => u.id === asg.agent_id)?.name || 'Specialist'}`,
      color: 'var(--roas-good)',
      bg: 'rgba(169, 245, 193, 0.15)',
      border: 'rgba(169, 245, 193, 0.3)',
    };
  };

  const displayedClients = authorizedClients.filter((c) => {
    // Module 14: name-or-phone via the shared predicate, industry kept as this screen's own
    // pre-existing extra match dimension.
    const matchesSearch =
      matchesClientQuery(c, searchQuery) || (c.industry || '').toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;

    if (statusFilter === 'all') return true;
    const asg = assignments.find((a) => a.client_id === c.id && a.service_type === serviceType);
    if (statusFilter === 'pending_assignment') return !asg || !asg.agent_id;
    if (statusFilter === 'assigned') return !!asg && !!asg.agent_id;
    return true;
  });

  const handleAssignAgent = async () => {
    if (!selectedClient || !selectedAgentId) return;
    setIsSubmittingAssignment(true);
    setSuccessMsg(null);
    try {
      await onAssignServiceAgent(selectedClient.id, serviceType, selectedAgentId, assignmentNotes);
      const agentObj = eligibleAgents.find((u) => u.id === selectedAgentId);
      setSuccessMsg(`Successfully assigned to ${agentObj?.name || 'Specialist'}`);
      setAssignmentNotes('');
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: any) {
      console.error('Assignment error:', err);
    } finally {
      setIsSubmittingAssignment(false);
    }
  };

  // Broadened per the final brief-editing decision: a department team lead can edit their own
  // service's brief for any of their clients; an agent only for a client they're formally
  // assigned to for this service (mirrors briefs_update_rls's agent branch, which requires
  // agent_assigned()) — matches currentAssignment computed above.
  const canEditThisBrief = isTeamLead || currentAssignment?.agent_id === currentUser.id;

  const renderBriefContent = (brief: BriefRecord | undefined) => {
    if (!selectedClient) return null;
    return (
      <DynamicBriefForm
        clientId={selectedClient.id}
        clientName={selectedClient.name}
        serviceType={serviceType}
        fieldDefs={briefFieldSchemas[serviceType] || []}
        existingBrief={brief}
        allBriefs={briefs}
        revisions={briefRevisions.filter((r) => r.client_id === selectedClient.id && r.service_type === serviceType)}
        onSaveBrief={onSaveBrief || (async () => {})}
        currentUserId={currentUser.id}
        canEdit={canEditThisBrief && typeof onSaveBrief === 'function'}
      />
    );
  };

  const activeDashboardClient = clients.find((c) => c.id === dashboardClientId) || null;

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div
        className="p-5 rounded-2xl border relative overflow-hidden backdrop-blur-md flex flex-col md:flex-row md:items-center justify-between gap-4"
        style={{
          background: 'var(--gradient-card)',
          borderColor: 'var(--border-medium)',
        }}
      >
        <div className="flex items-center gap-3.5">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 shadow-lg"
            style={{
              background: context.badgeBg,
              border: `1px solid ${context.accentColor}40`,
            }}
          >
            {icon}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white">{departmentName}</h2>
              <span
                className="text-[10px] px-2.5 py-0.5 rounded-full font-bold border"
                style={{
                  background: context.badgeBg,
                  color: context.badgeText,
                  borderColor: `${context.accentColor}40`,
                }}
              >
                {isTeamLead ? leadRoleTitle : agentRoleTitle}
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              {isTeamLead
                ? 'Review onboarding briefs, manage service assignments, and oversee delivery.'
                : 'Directly access briefs and deliverables assigned to your specialist queue.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start md:self-center">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-purple-950/40 border border-purple-800/40 text-xs text-purple-200">
            <Info className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span>Multi-Service Workflow: {serviceNameEn}</span>
          </div>
          {isTeamLead && onNavigateToModule && (
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

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div
          className="p-4 rounded-xl border"
          style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}
        >
          <div className="text-[11px] text-stone-400 font-semibold">
            {isTeamLead ? 'Total Service Clients' : 'My Assigned Clients'}
          </div>
          <div className="text-2xl font-bold text-white mt-1 font-mono">
            {authorizedClients.length}
          </div>
          <div className="text-[10px] text-stone-400 mt-0.5">Contracted for {serviceType.toUpperCase()}</div>
        </div>

        <div
          className="p-4 rounded-xl border"
          style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}
        >
          <div className="text-[11px] text-stone-400 font-semibold">Awaiting Specialist Assignment</div>
          <div className="text-2xl font-bold text-amber-300 mt-1 font-mono">
            {
              authorizedClients.filter(
                (c) =>
                  !assignments.some(
                    (a) => a.client_id === c.id && a.service_type === serviceType && a.agent_id
                  )
              ).length
            }
          </div>
          <div className="text-[10px] text-stone-400 mt-0.5">Pending team lead delegation</div>
        </div>

        <div
          className="p-4 rounded-xl border"
          style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}
        >
          <div className="text-[11px] text-stone-400 font-semibold">Active & Brief Documented</div>
          <div className="text-2xl font-bold text-emerald-400 mt-1 font-mono">
            {
              authorizedClients.filter((c) => {
                const asg = assignments.find((a) => a.client_id === c.id && a.service_type === serviceType);
                const brf = briefs.find((b) => b.client_id === c.id && b.service_type === serviceType);
                return asg?.agent_id && brf && brf.version > 0;
              }).length
            }
          </div>
          <div className="text-[10px] text-stone-400 mt-0.5">Ready for live execution</div>
        </div>
      </div>

      {/* Main Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* RIGHT/LEFT: Client Work Queue */}
        <div className="lg:col-span-5 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-1">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <FileText className="w-4 h-4 text-purple-400" />
              <span>{isTeamLead ? 'Incoming Service Clients' : 'My Service Queue'}</span>
            </h3>

            {isTeamLead && (
              <div className="flex items-center gap-1 bg-stone-900/60 p-1 rounded-xl border border-stone-800 text-[11px]">
                <button
                  onClick={() => setStatusFilter('all')}
                  className={`px-2.5 py-0.5 rounded font-medium transition-all ${
                    statusFilter === 'all' ? 'bg-purple-600 text-white shadow' : 'text-stone-400 hover:text-white'
                  }`}
                >
                  All ({authorizedClients.length})
                </button>
                <button
                  onClick={() => setStatusFilter('pending_assignment')}
                  className={`px-2.5 py-0.5 rounded font-medium transition-all ${
                    statusFilter === 'pending_assignment'
                      ? 'bg-amber-600 text-white shadow'
                      : 'text-stone-400 hover:text-white'
                  }`}
                >
                  Pending
                </button>
                <button
                  onClick={() => setStatusFilter('assigned')}
                  className={`px-2.5 py-0.5 rounded font-medium transition-all ${
                    statusFilter === 'assigned'
                      ? 'bg-emerald-600 text-white shadow'
                      : 'text-stone-400 hover:text-white'
                  }`}
                >
                  Assigned
                </button>
              </div>
            )}
          </div>

          <div className="relative">
            <Search className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search name, phone, or industry..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-xs rounded-xl bg-stone-900/80 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-400"
            />
          </div>

          <div className="space-y-2.5">
            {displayedClients.length === 0 ? (
              <div className="p-8 text-center rounded-xl bg-stone-900/40 border border-stone-800 space-y-1">
                <p className="text-xs text-stone-400">No matching clients found for this service.</p>
              </div>
            ) : (
              displayedClients.map((client) => {
                const isSelected = client.id === selectedClient?.id;
                const status = getLifecycleStatus(client);
                const asg = assignments.find((a) => a.client_id === client.id && a.service_type === serviceType);
                const assignedPerson = users.find((u) => u.id === asg?.agent_id);
                const clientBrief = briefs.find((b) => b.client_id === client.id && b.service_type === serviceType);
                const isNewBrief = isTeamLead && !!clientBrief && !clientBrief.team_lead_viewed_at;
                // Module 12 Phase 5: "New" badge for the agent's own freshly (re)assigned client.
                const isNewAssignment = !isTeamLead && !!asg && asg.agent_id === currentUser.id && !asg.viewed_at;
                const briefIssueCount = clientBrief ? reviewBrief(clientBrief, briefs, briefFieldSchemas[serviceType] || []).length : 0;

                return (
                  <div
                    key={client.id}
                    onClick={() => setSelectedClientId(client.id)}
                    className={`p-3.5 rounded-xl cursor-pointer transition-all border ${
                      isSelected
                        ? 'ring-2 ring-purple-500 shadow-xl bg-purple-950/30'
                        : 'bg-[#15131a]/80 hover:border-purple-500/40'
                    }`}
                    style={{
                      borderColor: isSelected ? 'var(--purple)' : 'var(--border-soft)',
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5">
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 font-bold text-xs"
                          style={{
                            background: asg?.agent_id ? 'rgba(169, 245, 193, 0.15)' : 'rgba(245, 226, 154, 0.15)',
                            color: asg?.agent_id ? 'var(--roas-good)' : 'var(--roas-mid)',
                          }}
                        >
                          {client.name.charAt(0)}
                        </div>
                        <div>
                          <h4 className="font-bold text-xs text-white inline-flex items-center gap-1.5">
                            {client.name}
                            {(isNewBrief || isNewAssignment) && (
                              <span className="px-1.5 py-0.2 rounded-full text-[9px] font-bold uppercase bg-purple-600 text-white">
                                New
                              </span>
                            )}
                            {clientBrief && (
                              <span
                                className="px-1.5 py-0.2 rounded-full text-[9px] font-bold"
                                style={
                                  briefIssueCount > 0
                                    ? { background: 'rgba(245, 226, 154, 0.15)', color: 'var(--roas-mid)' }
                                    : { background: 'rgba(169, 245, 193, 0.15)', color: 'var(--roas-good)' }
                                }
                                title={briefIssueCount > 0 ? `${briefIssueCount} review issue(s)` : 'No review issues'}
                              >
                                {briefCompletenessScore(clientBrief, briefFieldSchemas[serviceType] || [])}%
                              </span>
                            )}
                          </h4>
                          <span className="text-[11px] text-stone-400">
                            {client.industry || 'General'}
                            {canSeeContractValue(currentUser.role, client.sales_owner_id === currentUser.id) &&
                              ` • ${client.contract_value?.toLocaleString()} SAR`}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1">
                        <span
                          className="text-[9px] px-2 py-0.5 rounded-full font-semibold"
                          style={{
                            background: CLIENT_STATUS_META[client.status].bg,
                            color: CLIENT_STATUS_META[client.status].color,
                            border: `1px solid ${CLIENT_STATUS_META[client.status].border}`,
                          }}
                        >
                          {CLIENT_STATUS_META[client.status].label}
                        </span>
                        <span
                          className="text-[9px] px-2 py-0.5 rounded-full font-semibold"
                          style={{
                            background: status.bg,
                            color: status.color,
                            border: `1px solid ${status.border}`,
                          }}
                        >
                          {status.label}
                        </span>
                      </div>
                    </div>

                    <div className="mt-2.5 pt-2 flex items-center justify-between border-t border-stone-800/60 text-[11px]">
                      <span className="text-stone-400">
                        Specialist: <strong className={assignedPerson ? 'text-emerald-300' : 'text-amber-300'}>{assignedPerson?.name || 'Unassigned'}</strong>
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDashboardClientId(client.id);
                        }}
                        className="text-purple-300 hover:text-white font-medium flex items-center gap-1"
                      >
                        <span>Dashboard</span>
                        <Eye className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Selected Client Details & Brief */}
        <div className="lg:col-span-7 space-y-4">
          {selectedClient ? (
            <div className="space-y-4">
              <div
                className="p-4 rounded-xl border shadow-xl bg-[#161224]/80 border-purple-900/30"
              >
                <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-stone-800">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-white">{selectedClient.name}</h3>
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-bold"
                        style={{
                          background: CLIENT_STATUS_META[selectedClient.status].bg,
                          color: CLIENT_STATUS_META[selectedClient.status].color,
                        }}
                      >
                        {CLIENT_STATUS_META[selectedClient.status].label}
                      </span>
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-bold"
                        style={{
                          background: getLifecycleStatus(selectedClient).bg,
                          color: getLifecycleStatus(selectedClient).color,
                        }}
                      >
                        {getLifecycleStatus(selectedClient).label}
                      </span>
                    </div>
                    <p className="text-xs text-stone-400 mt-0.5">{selectedClient.industry || 'General'}</p>
                  </div>

                  <button
                    onClick={() => setDashboardClientId(selectedClient.id)}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all inline-flex items-center gap-1.5"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>View Client Dashboard</span>
                  </button>
                </div>

                {/* Assignment Control */}
                {isTeamLead && (
                  <div className="mt-3 pt-3 border-t border-stone-800 space-y-2.5">
                    <label className="text-xs font-bold text-white flex items-center gap-1.5">
                      <UserCheck className="w-3.5 h-3.5 text-purple-400" />
                      <span>Assign {serviceNameEn} Specialist</span>
                    </label>

                    <div className="flex items-center gap-2">
                      <select
                        value={selectedAgentId || currentAssignment?.agent_id || ''}
                        onChange={(e) => setSelectedAgentId(e.target.value)}
                        className="flex-1 px-3 py-1.5 rounded-lg text-xs bg-[#100c1c] border border-purple-900/40 text-white focus:outline-none"
                      >
                        <option value="" disabled>Select {serviceNameEn} Specialist...</option>
                        {eligibleAgents.map((ag) => {
                          const capacityData = getUserCapacityData(ag, clients, tasks);
                          return (
                            <option key={ag.id} value={ag.id}>
                              {ag.name} ({ag.email}) {getCapacityIndicator(capacityData)}
                            </option>
                          );
                        })}
                      </select>

                      <button
                        onClick={handleAssignAgent}
                        disabled={
                          isSubmittingAssignment ||
                          !selectedAgentId ||
                          selectedAgentId === currentAssignment?.agent_id
                        }
                        className="py-1.5 px-3 rounded-lg text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-40"
                      >
                        {isSubmittingAssignment ? 'Assigning...' : 'Assign'}
                      </button>
                    </div>

                    {successMsg && (
                      <p className="text-xs text-emerald-400 flex items-center gap-1 font-semibold">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{successMsg}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Service Brief Presentation */}
              <div className="p-4 rounded-xl border shadow-xl bg-[#161224]/80 border-purple-900/30 space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-stone-800">
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    {icon}
                    <span>{serviceNameEn} Brief Details</span>
                  </h4>
                  <div className="flex items-center gap-2">
                    {canEditBriefFieldSchema(currentUser.role, serviceType) && (
                      <button
                        onClick={() => setIsSchemaEditorOpen(true)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all"
                      >
                        <ClipboardCheck className="w-3.5 h-3.5" />
                        Manage Questions
                      </button>
                    )}
                    <span className="text-xs text-stone-400">
                      Version: v{serviceBrief?.version || 1}
                    </span>
                  </div>
                </div>
                {renderBriefContent(serviceBrief)}
              </div>
            </div>
          ) : (
            <div className="p-12 text-center rounded-xl bg-stone-900/40 border border-stone-800 space-y-2">
              <FileText className="w-10 h-10 text-stone-500 mx-auto" />
              <h4 className="text-sm font-bold text-white">Select a client from the queue</h4>
              <p className="text-xs text-stone-400">Select a client to view and delegate this service brief.</p>
            </div>
          )}
        </div>
      </div>

      {/* DEDICATED CLIENT DASHBOARD MODAL */}
      {activeDashboardClient && (
        <ClientDashboard
          client={activeDashboardClient}
          users={users}
          currentUser={currentUser}
          briefs={briefs}
          briefRevisions={briefRevisions}
          campaigns={campaigns}
          tasks={tasks}
          dailyLogs={dailyLogs}
          extraNotes={extraNotes}
          assignments={assignments}
          onMarkAssignmentViewed={onMarkAssignmentViewed}
          onClose={() => setDashboardClientId(null)}
          onSaveBrief={onSaveBrief}
          briefFieldSchemas={briefFieldSchemas}
          briefFieldSchemaRows={briefFieldSchemaRows}
          onCreateBriefFieldSchema={onCreateBriefFieldSchema}
          onUpdateBriefFieldSchema={onUpdateBriefFieldSchema}
          onDeleteBriefFieldSchema={onDeleteBriefFieldSchema}
          onDeleteClient={onDeleteClient}
        />
      )}

      {isSchemaEditorOpen && (
        <BriefFieldSchemaEditor
          serviceType={serviceType}
          rows={briefFieldSchemaRows.filter((r) => r.service_type === serviceType)}
          onCreate={onCreateBriefFieldSchema}
          onUpdate={onUpdateBriefFieldSchema}
          onDelete={onDeleteBriefFieldSchema}
          onClose={() => setIsSchemaEditorOpen(false)}
        />
      )}
    </div>
  );
};
