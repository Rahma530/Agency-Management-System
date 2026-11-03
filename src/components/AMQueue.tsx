import React, { useState, useMemo, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Inbox,
  UserCheck,
  ChevronRight,
  ChevronDown,
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
  UploadCloud,
  PlusCircle,
  Merge,
} from 'lucide-react';
import {
  ClientRecord,
  ClientLifecyclePeriodRecord,
  ClientAccessFields,
  ClientStatus,
  UserRecord,
  BriefRecord,
  BriefRevisionRecord,
  ServiceType,
  UserRole,
  CampaignRecord,
  TaskRecord,
  TaskAssigneeRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  AssignmentRecord,
  TaskStatus,
  ReportRecord,
  ClientComparisonRecord,
  SocialInsightRecord,
  SeoInsightRecord,
  ClientPortalUserRecord,
  MeetingRecord,
  PlatformConnectionRecord,
  PlatformConnectionStatus,
  PlatformCategory,
  ClientContractRecord,
  BriefFieldDef,
  BriefFieldSchemaRow,
  BriefAttachmentRecord,
  ClientAccessAttachmentRecord,
} from '../types/database';
import { AppModuleId } from '../data/roles';
import { getUserCapacityData, getCapacityIndicator } from '../lib/capacity';
import { isActiveEmployee, canSeeContractValue, canAccessClientOnboarding, canMergeClients } from '../lib/permissions';
import { matchesClientQuery } from '../lib/clientSearch';
import { getClientServices, SERVICE_LABELS, SERVICE_BADGE_COLORS } from '../lib/clientServices';
import { CLIENT_STATUS_META, compareClientsForPortfolio, isExternalClient } from '../lib/clientStatus';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import { GripVertical } from 'lucide-react';
import { ClientDashboard } from './ClientDashboard';
import { ClientKanbanColumn } from './ClientKanbanColumn';
import { MergeClientsModal } from './MergeClientsModal';
import { ComparisonGranularity, DateRange, ReportMode, ReportScope } from '../lib/reportingEngine';
import { CampaignSummaryPayload, CampaignSummaryGenerationResult, UnifiedReportGenerationResult } from './reporting/ComparisonDisplay';

interface AMQueueProps {
  clients: ClientRecord[];
  clientLifecyclePeriodsByClientId: Record<string, ClientLifecyclePeriodRecord[]>;
  users: UserRecord[];
  briefs: BriefRecord[];
  briefRevisions?: BriefRevisionRecord[];
  campaigns?: CampaignRecord[];
  tasks?: TaskRecord[];
  // Needed by getUserCapacityData's own UNION formula — see src/lib/capacity.ts.
  taskAssignees?: TaskAssigneeRecord[];
  dailyLogs?: DailyLogRecord[];
  extraNotes?: ExtraNoteRecord[];
  assignments?: AssignmentRecord[];
  onRefreshAssignments: () => Promise<void>;
  reports?: ReportRecord[];
  clientComparisons?: ClientComparisonRecord[];
  socialInsights?: SocialInsightRecord[];
  seoInsights?: SeoInsightRecord[];
  clientPortalUsers?: ClientPortalUserRecord[];
  currentUser?: UserRecord;
  currentUserId?: string;
  onAssignAMAgent: (clientId: string, agentId: string) => Promise<void>;
  onAssignAMTeamLead?: (clientId: string, leadId: string) => Promise<void>;
  onAssignServiceAgent: (
    clientId: string,
    serviceType: ServiceType,
    agentId: string,
    reasonNotes?: string
  ) => Promise<void>;
  onSaveBrief: (briefData: {
    client_id: string;
    service_type: ServiceType;
    fields: Record<string, any>;
    version: number;
    submitted_by: string;
    custom_field_defs: BriefFieldDef[];
  }) => Promise<void>;
  onSubmitBrief?: (briefId: string) => Promise<void>;
  briefFieldSchemas: Record<ServiceType, BriefFieldDef[]>;
  briefFieldSchemaRows: BriefFieldSchemaRow[];
  onCreateBriefFieldSchema?: (row: Omit<BriefFieldSchemaRow, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onUpdateBriefFieldSchema?: (id: string, updates: Partial<BriefFieldSchemaRow>) => Promise<void>;
  onDeleteBriefFieldSchema?: (id: string) => Promise<void>;
  onDeleteClient?: (clientId: string) => Promise<void>;
  onForceDeleteClient?: (clientId: string) => Promise<void>;
  onOpenRegisterModal?: () => void;
  onOpenBulkUploadModal?: () => void;
  onUpdateTaskStatus?: (taskId: string, newStatus: TaskStatus) => Promise<void>;
  onUpdateClientStatus?: (
    clientId: string,
    newStatus: ClientStatus,
    options?: { churn_reason?: string; churned_at?: string; renewal_date?: string }
  ) => Promise<void>;
  onConfirmClientRenewal?: (clientId: string) => Promise<void>;
  // Manual drag-and-drop reorder of the Client Portfolio table (2026-11-02). Receives the full
  // set of {id, sort_order} pairs that actually changed after a drag (not the whole list) — see
  // handleReorderClients below for why the drag handle only shows with no filter/search active.
  onReorderClients?: (updates: { id: string; sort_order: number }[]) => Promise<void>;
  onReopenClient?: (clientId: string, reopenDate: string) => Promise<void>;
  onMarkClientViewed?: (clientId: string) => Promise<void> | void;
  onNavigateToModule?: (module: AppModuleId, prefillAssigneeName?: string) => void;
  onGenerateComparison?: (
    scope: ReportScope,
    mode: ReportMode,
    granularity: ComparisonGranularity | 'custom',
    custom?: { currentRange: DateRange; previousRange?: DateRange }
  ) => Promise<ClientComparisonRecord | null>;
  onGenerateReport?: (comparisonId: string, period: string) => Promise<void>;
  onGenerateAiSummary?: (payload: CampaignSummaryPayload) => Promise<CampaignSummaryGenerationResult>;
  onGenerateUnifiedReport?: (payload: CampaignSummaryPayload) => Promise<UnifiedReportGenerationResult>;
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
  onUpdateClientDates: (
    clientId: string,
    updates: { start_date: string | null; renewal_date: string | null }
  ) => Promise<void>;
  onUpdateClientDetails: (clientId: string, patch: Record<string, unknown>) => Promise<void>;
  onUpdateClientAccess?: (clientId: string, updates: Partial<ClientAccessFields>) => Promise<void>;
  onFetchClientAccess?: (clientId: string) => Promise<ClientAccessFields | null>;
  briefAttachments?: BriefAttachmentRecord[];
  onUploadBriefAttachment?: (briefId: string, file: File) => Promise<void>;
  onDeleteBriefAttachment?: (attachmentId: string) => Promise<void>;
  onFetchClientAccessAttachments?: (clientId: string) => Promise<ClientAccessAttachmentRecord[]>;
  onUploadClientAccessAttachment?: (
    clientId: string,
    file: File,
    label: string | null
  ) => Promise<ClientAccessAttachmentRecord>;
  onDeleteClientAccessAttachment?: (clientId: string, attachmentId: string, storagePath: string) => Promise<void>;
  // Client merge (merge_clients()/merge_clients_preview() RPCs) — executive/head_of_technical
  // only, gated below via canMergeClients(currentRole). Both optional: absent
  // entirely, the Client Portfolio table's checkbox column and "Merge selected" button, and
  // ClientDashboard's own single-client entry point below, simply never render.
  onPreviewMergeClients?: (keepId: string, duplicateId: string) => Promise<Record<string, { moved?: number; deleted_duplicates?: number; count?: number }>>;
  onMergeClients?: (
    keepId: string,
    duplicateIds: string[]
  ) => Promise<{ succeeded: string[]; failed: { id: string; error: string } | null }>;
}

// Manual drag-and-drop reorder for the Client Portfolio table (2026-11-02). A row is both the
// drag source AND the drop target — dropping a dragged row onto another row moves it to that
// row's position (handleClientDragEnd does the actual reindexing). Kept as its own component
// because a hook like useDraggable/useDroppable can't be called a variable number of times
// inside a .map() loop in the parent (same reasoning as KanbanColumn.tsx's own comment) — each
// row needs its own hook call, which means its own component instance. The drag handle is its
// own leading <td>, rendered only while canReorder is true, so the rest of the row keeps working
// exactly as before (its own onClick still opens the Client Dashboard) when a filter/search is
// active and reordering is disabled.
const SortableClientRow: React.FC<{
  clientId: string;
  canReorder: boolean;
  onRowClick: () => void;
  className?: string;
  children: React.ReactNode;
}> = ({ clientId, canReorder, onRowClick, className, children }) => {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: clientId,
    disabled: !canReorder,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: clientId, disabled: !canReorder });

  return (
    <tr
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      onClick={onRowClick}
      className={className}
      style={{
        transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
        opacity: isDragging ? 0.4 : 1,
        background: isOver ? 'rgba(168, 85, 247, 0.12)' : undefined,
      }}
    >
      {canReorder && (
        <td
          className="py-3.5 px-2 w-6 text-stone-500 hover:text-stone-300 cursor-grab active:cursor-grabbing"
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} />
        </td>
      )}
      {children}
    </tr>
  );
};

// Client Portfolio table, Status column, quick-change menu (2026-11-03 — owner's report: opening
// this on a client row near the bottom of the table clipped the dropdown, because it was rendered
// as a plain `absolute` child of its `<td>`, inside the table's own `overflow-x-auto` wrapper
// (needed for horizontal scroll on narrow screens) — setting overflow on one axis forces the other
// to clip too per the CSS spec, so anything near the bottom edge of that scroll container got cut
// off instead of showing below the row, same failure class SearchableMultiSelect.tsx already
// solved. Fix: same pattern — render the open menu through a portal to document.body, positioned
// from the trigger button's live getBoundingClientRect() (flips to open upward when there isn't
// 200px of room below), so it is never clipped by any ancestor's overflow. Kept as its own
// component (not an inline IIFE, which is what this used to be) because each row needs its own
// trigger ref and open/position state — can't usefully share that across a .map().
const ClientStatusQuickMenu: React.FC<{
  client: ClientRecord;
  statusMeta: { label: string; bg: string; color: string; border: string };
  lifecycleLabel?: string;
  lifecycleColor?: string;
  canManage: boolean;
  isUpdating: boolean;
  canConfirmRenewal: boolean;
  onStatusChange: (status: ClientStatus) => void;
  onConfirmRenewal: () => void;
  onOpenDashboard: () => void;
}> = ({
  client,
  statusMeta,
  lifecycleLabel,
  lifecycleColor,
  canManage,
  isUpdating,
  canConfirmRenewal,
  onStatusChange,
  onConfirmRenewal,
  onOpenDashboard,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; openUpward: boolean } | null>(null);

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 4;
    // The menu never has more than 3 action rows (plus the Close/Reopen row) at ~30px each, so
    // ~190px comfortably covers the tallest case (Active: Move to Renewal + Pause + Close).
    const estimatedHeight = 190;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openUpward = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
    setPosition({
      left: rect.left,
      top: openUpward ? rect.top - margin : rect.bottom + margin,
      openUpward,
    });
  };

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePosition();
    const handle = () => updatePosition();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [isOpen]);

  const choose = (fn: () => void) => {
    setIsOpen(false);
    fn();
  };

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={!canManage || isUpdating}
        onClick={() => canManage && setIsOpen((prev) => !prev)}
        className="flex items-center gap-1 disabled:cursor-default group/status"
      >
        <span
          className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold inline-block"
          style={{ background: statusMeta.bg, color: statusMeta.color, border: `1px solid ${statusMeta.border}` }}
        >
          {statusMeta.label}
        </span>
        {canManage && (
          <ChevronDown className="w-3 h-3 text-stone-500 group-hover/status:text-white transition-colors" />
        )}
      </button>

      {/* Onboarding-only context: whether an AM is assigned yet / briefs are in, same info the old
          badge always showed — now scoped to onboarding, since for an already-active/paused/closed
          client this is long settled and not worth repeating (per Rahma's request — the old badge
          showed this everywhere, including for established clients where it no longer applies). */}
      {client.status === 'onboarding' && lifecycleLabel && (
        <span className="block text-[10px] mt-1" style={{ color: lifecycleColor }}>
          {lifecycleLabel}
        </span>
      )}
      {client.status === 'renewal' && (
        <span className="block text-[10px] mt-1" style={{ color: statusMeta.color }}>
          Needs confirmation
        </span>
      )}

      {isOpen && position && createPortal(
        <>
          <div className="fixed inset-0 z-[999]" onClick={() => setIsOpen(false)} />
          <div
            className="fixed z-[1000] w-48 rounded-xl border py-1 shadow-2xl"
            style={{
              background: '#17101f',
              borderColor: 'var(--border-medium)',
              left: position.left,
              top: position.top,
              transform: position.openUpward ? 'translateY(-100%)' : undefined,
            }}
          >
            {client.status === 'onboarding' && (
              <button
                onClick={() => choose(() => onStatusChange('active'))}
                disabled={isUpdating}
                className="w-full text-left px-3 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-900/30 disabled:opacity-50"
              >
                Mark as Active
              </button>
            )}
            {client.status === 'active' && (
              <>
                <button
                  onClick={() => choose(() => onStatusChange('renewal'))}
                  disabled={isUpdating}
                  className="w-full text-left px-3 py-1.5 text-[11px] font-semibold text-amber-300 hover:bg-amber-900/30 disabled:opacity-50"
                >
                  Move to Renewal
                </button>
                <button
                  onClick={() => choose(() => onStatusChange('paused'))}
                  disabled={isUpdating}
                  className="w-full text-left px-3 py-1.5 text-[11px] font-semibold text-lilac hover:bg-stone-800/60 disabled:opacity-50"
                >
                  Pause Client
                </button>
              </>
            )}
            {client.status === 'paused' && (
              <button
                onClick={() => choose(() => onStatusChange('active'))}
                disabled={isUpdating}
                className="w-full text-left px-3 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-900/30 disabled:opacity-50"
              >
                Resume Client
              </button>
            )}
            {client.status === 'renewal' && canConfirmRenewal && (
              <button
                onClick={() => choose(onConfirmRenewal)}
                disabled={isUpdating}
                className="w-full text-left px-3 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-900/30 disabled:opacity-50"
              >
                Confirm Renewal
              </button>
            )}
            {client.status !== 'closed' ? (
              <button
                onClick={() => choose(onOpenDashboard)}
                className="w-full text-left px-3 py-1.5 text-[11px] font-semibold text-red-300 hover:bg-red-950/30 border-t mt-1 pt-1.5"
                style={{ borderColor: 'var(--border-soft)' }}
              >
                Close Client…
              </button>
            ) : (
              <button
                onClick={() => choose(onOpenDashboard)}
                className="w-full text-left px-3 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-900/30"
              >
                Reopen Client…
              </button>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
};

export const AMQueue: React.FC<AMQueueProps> = ({
  clients,
  clientLifecyclePeriodsByClientId,
  users,
  briefs,
  briefRevisions = [],
  campaigns = [],
  tasks = [],
  taskAssignees = [],
  dailyLogs = [],
  extraNotes = [],
  assignments = [],
  onRefreshAssignments,
  reports = [],
  clientComparisons = [],
  socialInsights = [],
  seoInsights = [],
  clientPortalUsers = [],
  currentUser,
  currentUserId,
  onAssignAMAgent,
  onAssignAMTeamLead,
  onAssignServiceAgent,
  onSaveBrief,
  onSubmitBrief,
  briefFieldSchemas,
  briefFieldSchemaRows,
  onCreateBriefFieldSchema,
  onUpdateBriefFieldSchema,
  onDeleteBriefFieldSchema,
  onDeleteClient,
  onForceDeleteClient,
  onOpenRegisterModal,
  onOpenBulkUploadModal,
  onUpdateTaskStatus,
  onUpdateClientStatus,
  onConfirmClientRenewal,
  onReorderClients,
  onReopenClient,
  onMarkClientViewed,
  onNavigateToModule,
  onGenerateComparison,
  onGenerateReport,
  onGenerateAiSummary,
  onGenerateUnifiedReport,
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
  onUpdateClientDates,
  onUpdateClientDetails,
  onUpdateClientAccess,
  onFetchClientAccess,
  briefAttachments = [],
  onUploadBriefAttachment,
  onDeleteBriefAttachment,
  onFetchClientAccessAttachments,
  onUploadClientAccessAttachment,
  onDeleteClientAccessAttachment,
  onPreviewMergeClients,
  onMergeClients,
}) => {
  const resolvedUser = currentUser || users.find((u) => u.id === currentUserId) || users[0];
  const effectiveUserId = resolvedUser?.id || currentUserId || '';
  const currentRole = resolvedUser?.role || 'am_agent';
  const isAMTeamLead = currentRole === 'am_team_lead';
  const isAMAgent = currentRole === 'am_agent';
  // Only referenced by handleAssign's guard below.
  const isExecutive = currentRole === 'executive' || currentRole === 'head_of_technical';

  // Role Security Check — same canAccessClientOnboarding() check that gates the "Client
  // Onboarding" sidebar nav item in App.tsx, so the two can never drift out of sync.
  if (!canAccessClientOnboarding(currentRole)) {
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
    // Inhouse module (2026-11-02): Kesraa/Fast Growth are real client rows, flagged is_inhouse,
    // but aren't paying clients — they don't belong in the Client Portfolio, the stats bar above
    // it, or the Renewal Queue. They'll have their own picker inside the Inhouse module.
    const externalClients = clients.filter(isExternalClient);
    if (isAMAgent) {
      return externalClients.filter((c) => c.am_agent_id === effectiveUserId);
    }
    return externalClients;
  }, [clients, isAMAgent, effectiveUserId]);

  // Module 12 Phase 8: clients due for renewal, within the same am_team_lead/am_agent scope
  // as visibleClients above (full portfolio vs. own-assigned-only).
  const renewalClients = useMemo(
    () => visibleClients.filter((c) => c.status === 'renewal'),
    [visibleClients]
  );

  // A client missing either date can't be reliably tracked for renewal — the automated renewal
  // sweep (App.tsx) and every isRenewalApproaching check already just skip a null renewal_date, so
  // this surfaces the gap instead of leaving it silently invisible.
  const missingDatesClients = useMemo(
    () => visibleClients.filter((c) => !c.start_date || !c.renewal_date),
    [visibleClients]
  );

  const [dashboardClientId, setDashboardClientId] = useState<string | null>(null);
  const [assigningAgentId, setAssigningAgentId] = useState<Record<string, string>>({});
  const [isAssigning, setIsAssigning] = useState<string | null>(null);
  const [assignMessage, setAssignMessage] = useState<{ id: string; text: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showMissingDatesOnly, setShowMissingDatesOnly] = useState(false);
  // The other two Overview Stats Bar cards that aren't a plain status ("Pending Briefs" /
  // "Awaiting Assignment" and "Documented Briefs") follow the exact same click-to-filter pattern
  // as showMissingDatesOnly above — each toggles the Client Portfolio table below to show only
  // the clients that card is counting, instead of just being a static number.
  const [showPendingBriefsOnly, setShowPendingBriefsOnly] = useState(false);
  const [showDocumentedBriefsOnly, setShowDocumentedBriefsOnly] = useState(false);
  // Scroll target for every stats-bar card click, so clicking one doesn't just silently filter a
  // table the user may have scrolled away from — it also brings the filtered list into view.
  const clientPortfolioRef = useRef<HTMLDivElement | null>(null);
  const scrollToClientPortfolio = () => {
    clientPortfolioRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // Status filter pills next to search — defaults to 'all' (every status shown, same as before
  // this feature existed). 'all' is not a real ClientStatus value, just this filter's own default.
  // The "Total In Onboarding" stats card reuses this same state (set to 'onboarding') rather than
  // its own boolean, since it's just another status filter.
  const [statusFilter, setStatusFilter] = useState<ClientStatus | 'all'>('all');
  // Inline quick-status dropdown (Client Portfolio table, Status column) — ClientStatusQuickMenu
  // above owns its own open/closed state per row now (2026-11-03, portal fix); this just tracks
  // which row currently has a status-change request in flight. Same permission rule as
  // ClientDashboard's canManageLifecycle (kept in sync deliberately): AM Team Lead/Executive/Head
  // of Technical can manage any client, an AM Agent only the client assigned to them.
  const [quickStatusUpdatingId, setQuickStatusUpdatingId] = useState<string | null>(null);
  const canShowMergeClients = !!onMergeClients && !!onPreviewMergeClients && canMergeClients(currentRole);
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [mergeModalInitialIds, setMergeModalInitialIds] = useState<string[] | null>(null);

  const getClientBriefs = (clientId: string) => briefs.filter((b) => b.client_id === clientId);

  // Module 14: search narrows only the rendered list below — the stats bar and Renewal Queue
  // above stay scoped to the full visibleClients portfolio, same precedent as SalesPortalView's
  // stat cards staying on personalClients while only its table rows use filteredClients. The
  // missing-dates toggle narrows the same way search does.
  const displayedClients = useMemo(
    () =>
      visibleClients
        .filter((c) => matchesClientQuery(c, searchQuery))
        .filter((c) => !showMissingDatesOnly || !c.start_date || !c.renewal_date)
        .filter((c) => statusFilter === 'all' || c.status === statusFilter)
        // "Pending Briefs" / "Awaiting Assignment" card filter — same underlying condition as that
        // card's own count, just applied as a filter instead of only displayed as a number.
        .filter((c) => {
          if (!showPendingBriefsOnly) return true;
          if (isAMTeamLead) return !c.am_agent_id;
          const brfs = getClientBriefs(c.id);
          return getClientServices(c).some((s) => !brfs.some((b) => b.service_type === s));
        })
        // "Documented Briefs" card filter — clients that have at least one submitted brief.
        .filter((c) => !showDocumentedBriefsOnly || getClientBriefs(c.id).length > 0)
        // Onboarding clients (need attention now) first, closed ones last, unless manually
        // reordered by drag-and-drop — see compareClientsForPortfolio's own comment
        // (lib/clientStatus.ts) for the full ordering.
        .slice()
        .sort(compareClientsForPortfolio),
    [
      visibleClients,
      searchQuery,
      showMissingDatesOnly,
      statusFilter,
      showPendingBriefsOnly,
      showDocumentedBriefsOnly,
      isAMTeamLead,
      briefs,
    ]
  );

  // Manual drag-and-drop reorder (2026-11-02) is only offered on the plain, unfiltered table —
  // search/status-filter/stat-card toggles narrow displayedClients to a SUBSET of
  // visibleClients, and reordering a subset can't unambiguously say where a dragged row should
  // land among the clients currently hidden by that filter. Simplest honest behavior: show the
  // drag handle (and accept drags) only when displayedClients === visibleClients in practice.
  const canReorderClients =
    !searchQuery &&
    !showMissingDatesOnly &&
    statusFilter === 'all' &&
    !showPendingBriefsOnly &&
    !showDocumentedBriefsOnly &&
    !!onReorderClients;

  const reorderSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );
  const [isReordering, setIsReordering] = useState(false);
  const [portfolioViewMode, setPortfolioViewMode] = useState<'list' | 'board'>('list');

  // Shared by the List view's row reorder and the Board view's within-column reorder: moves
  // `fromId` to `toId`'s position inside `list`, reindexes `list` sequentially, and writes only
  // the rows whose sort_order actually changed. See compareClientsForPortfolio's comment for why
  // a full reindex (not just the moved row) keeps future comparisons unambiguous.
  const reorderClientList = async (list: ClientRecord[], fromId: string, toId: string) => {
    if (!onReorderClients || fromId === toId) return;
    const fromIndex = list.findIndex((c) => c.id === fromId);
    const toIndex = list.findIndex((c) => c.id === toId);
    if (fromIndex === -1 || toIndex === -1) return;

    const reordered = list.slice();
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);

    const updates = reordered
      .map((client, index) => ({ id: client.id, sort_order: index }))
      .filter(({ id, sort_order }) => {
        const current = reordered.find((c) => c.id === id);
        return current?.sort_order !== sort_order;
      });
    if (updates.length === 0) return;

    setIsReordering(true);
    try {
      await onReorderClients(updates);
    } finally {
      setIsReordering(false);
    }
  };

  const handleClientDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    await reorderClientList(displayedClients, String(active.id), String(over.id));
  };

  // Board view (2026-11-02): dragging a card onto another status column's area, or onto a card
  // that already belongs to a different column, changes status — reusing the exact same
  // handlers the quick-status dropdown already uses (handleQuickStatusChange/
  // handleQuickConfirmRenewal), so the set of allowed transitions never drifts out of sync
  // between the two UIs. Closing (needs a required reason + stop date) and reopening (needs a
  // reopen date) can't complete from a drag alone — both open the full Client Dashboard instead,
  // same as the quick-status dropdown's "Close Client…"/"Reopen Client…" items; the card stays
  // in its current column until that form is actually submitted there.
  const CLIENT_STATUS_VALUES: ClientStatus[] = ['onboarding', 'active', 'renewal', 'paused', 'closed'];

  const handleClientStatusDrop = (client: ClientRecord, targetStatus: ClientStatus) => {
    if (client.status === targetStatus || !canManageClientStatus(client)) return;
    if (targetStatus === 'closed' || client.status === 'closed') {
      setDashboardClientId(client.id);
      return;
    }
    if (client.status === 'renewal' && targetStatus === 'active') {
      void handleQuickConfirmRenewal(client.id);
      return;
    }
    const allowed =
      (client.status === 'onboarding' && targetStatus === 'active') ||
      (client.status === 'active' && (targetStatus === 'renewal' || targetStatus === 'paused')) ||
      (client.status === 'paused' && targetStatus === 'active');
    if (!allowed) return; // Not an offered transition — same set the quick-status menu offers.
    void handleQuickStatusChange(client.id, targetStatus);
  };

  const handleBoardDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const client = displayedClients.find((c) => c.id === active.id);
    if (!client) return;
    const overId = String(over.id);

    if ((CLIENT_STATUS_VALUES as string[]).includes(overId)) {
      handleClientStatusDrop(client, overId as ClientStatus);
      return;
    }
    const targetClient = displayedClients.find((c) => c.id === overId);
    if (!targetClient) return;
    if (targetClient.status !== client.status) {
      handleClientStatusDrop(client, targetClient.status);
    } else {
      void reorderClientList(
        displayedClients.filter((c) => c.status === client.status),
        client.id,
        targetClient.id
      );
    }
  };

  const STATUS_FILTER_OPTIONS: { key: ClientStatus | 'all'; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'onboarding', label: 'Onboarding' },
    { key: 'active', label: 'Active' },
    { key: 'paused', label: 'Paused' },
    { key: 'renewal', label: 'Renewal' },
    { key: 'closed', label: 'Closed' },
  ];

  const amAgents = users.filter((u) => u.role === 'am_agent' && isActiveEmployee(u));
  const amTeamLeaders = users.filter((u) => u.role === 'am_team_lead' && isActiveEmployee(u));
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

  // Same rule as ClientDashboard.tsx's canManageLifecycle — kept in sync deliberately: AM Team
  // Lead/Executive/Head of Technical can change any client's status; an AM Agent only the client
  // currently assigned to them.
  const canManageClientStatus = (client: ClientRecord) =>
    currentRole === 'am_team_lead' ||
    currentRole === 'executive' ||
    currentRole === 'head_of_technical' ||
    (currentRole === 'am_agent' && client.am_agent_id === effectiveUserId);

  // Quick, single-click transitions only (no extra required fields) — Active/Paused/Renewal.
  // Closing (needs a required reason + stop date) and Reopening (needs a reopen date) stay behind
  // the full Client Dashboard form below, same validation ClientDashboard.tsx already enforces —
  // deliberately not duplicated here.
  const handleQuickStatusChange = async (clientId: string, newStatus: ClientStatus) => {
    if (!onUpdateClientStatus) return;
    setQuickStatusUpdatingId(clientId);
    try {
      await onUpdateClientStatus(clientId, newStatus);
    } catch (err) {
      console.error(err);
    } finally {
      setQuickStatusUpdatingId(null);
    }
  };

  const handleQuickConfirmRenewal = async (clientId: string) => {
    if (!onConfirmClientRenewal) return;
    setQuickStatusUpdatingId(clientId);
    try {
      await onConfirmClientRenewal(clientId);
    } catch (err) {
      console.error(err);
    } finally {
      setQuickStatusUpdatingId(null);
    }
  };

  const getClientLifecycleStatus = (client: ClientRecord) => {
    if (!client.am_agent_id) {
      return {
        key: 'awaiting_am_assignment',
        label: 'Awaiting AM',
        color: 'var(--roas-mid)',
        bg: 'var(--lifecycle-pending-tint)',
        border: 'var(--lifecycle-pending-border)',
      };
    }

    const services = getClientServices(client);
    const clientBriefs = getClientBriefs(client.id);
    const hasAllBriefs =
      services.length > 0 &&
      services.every((s) => clientBriefs.some((b) => b.service_type === s && b.version > 0));

    if (hasAllBriefs) {
      return {
        key: 'brief_submitted',
        label: 'Briefs Completed',
        color: 'var(--roas-good)',
        bg: 'var(--lifecycle-ready-tint)',
        border: 'var(--lifecycle-ready-border)',
      };
    }

    return {
      key: 'brief_in_progress',
      label: 'Onboarding in Progress',
      color: 'var(--purple-light)',
      bg: 'var(--lifecycle-onboarding-tint)',
      border: 'var(--lifecycle-onboarding-border)',
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
              background: 'var(--nav-badge-purple-tint)',
              border: '1px solid var(--border-soft)',
              color: 'var(--purple-light)',
            }}
          >
            <Inbox className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold" style={{ color: 'var(--ink)' }}>
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
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-purple-950/40 border border-purple-800/40 text-xs" style={{ color: 'var(--pill-accent-ink)' }}>
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
          {onOpenRegisterModal && (
            <button
              onClick={onOpenRegisterModal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-white bg-purple-700/60 hover:bg-purple-600/70 transition-all"
              style={{ border: '1px solid var(--border-strong)' }}
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>Register Client</span>
            </button>
          )}
          {onOpenBulkUploadModal && (
            <button
              onClick={onOpenBulkUploadModal}
              className="brand-gold-action flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-amber-200 bg-amber-950/40 hover:bg-amber-900/60 hover:text-white border border-amber-700/40 transition-all"
            >
              <UploadCloud className="w-3.5 h-3.5" />
              <span>Bulk Upload</span>
            </button>
          )}
        </div>
      </div>

      {/* Overview Stats Bar — every card below is clickable: it filters the Client Portfolio
          table to exactly what it's counting and scrolls it into view, instead of being a plain
          number. "Total In Onboarding" reuses the statusFilter dropdown's own state; the other
          two new toggles follow the same click-to-filter pattern "Clients with Missing Dates"
          already used before this change. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() => {
            setStatusFilter((prev) => (prev === 'onboarding' ? 'all' : 'onboarding'));
            scrollToClientPortfolio();
          }}
          className="p-4 rounded-xl flex items-center justify-between text-left transition-all"
          data-accent="neutral"
          style={{
            background: 'var(--gradient-card)',
            border: statusFilter === 'onboarding' ? '1px solid var(--purple-light)' : '1px solid var(--border-soft)',
          }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--ink-soft)' }}>Total In Onboarding</p>
            <p className="text-2xl font-bold mt-1 stat-number" style={{ color: 'var(--ink)' }}>
              {visibleClients.filter((c) => c.status === 'onboarding').length}
            </p>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
              {statusFilter === 'onboarding' ? 'Showing only these — click to clear' : 'Click to filter the list below'}
            </p>
          </div>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-purple-900/30 text-purple-300 border border-purple-800/30">
            <Inbox className="w-4 h-4" />
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setShowPendingBriefsOnly((prev) => !prev);
            scrollToClientPortfolio();
          }}
          className="p-4 rounded-xl flex items-center justify-between text-left transition-all"
          data-accent="warning"
          style={{
            background: 'var(--gradient-card)',
            border: showPendingBriefsOnly ? '1px solid var(--stat-warning-alt)' : '1px solid var(--border-soft)',
          }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--ink-soft)' }}>
              {isAMTeamLead ? 'Awaiting Assignment' : 'Pending Briefs'}
            </p>
            <p className="text-2xl font-bold mt-1 stat-number" style={{ color: 'var(--stat-warning-alt)' }}>
              {isAMTeamLead
                ? visibleClients.filter((c) => !c.am_agent_id).length
                : visibleClients.filter((c) => {
                    const brfs = getClientBriefs(c.id);
                    return getClientServices(c).some((s) => !brfs.some((b) => b.service_type === s));
                  }).length}
            </p>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
              {showPendingBriefsOnly ? 'Showing only these — click to clear' : 'Click to filter the list below'}
            </p>
          </div>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-amber-950/30 text-amber-300 border border-amber-800/30">
            <Clock className="w-4 h-4" />
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setShowDocumentedBriefsOnly((prev) => !prev);
            scrollToClientPortfolio();
          }}
          className="p-4 rounded-xl flex items-center justify-between text-left transition-all"
          data-accent="success"
          style={{
            background: 'var(--gradient-card)',
            border: showDocumentedBriefsOnly ? '1px solid var(--stat-success)' : '1px solid var(--border-soft)',
          }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--ink-soft)' }}>Documented Briefs</p>
            <p className="text-2xl font-bold mt-1 stat-number" style={{ color: 'var(--stat-success)' }}>
              {/* Count of CLIENTS with >=1 submitted brief — not raw brief rows — so this number
                  matches exactly what clicking the card filters the table below to. A client can
                  have several briefs (one per service), so the two counts aren't the same thing. */}
              {visibleClients.filter((c) => getClientBriefs(c.id).length > 0).length}
            </p>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
              {showDocumentedBriefsOnly ? 'Showing only these — click to clear' : 'Click to filter the list below'}
            </p>
          </div>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-emerald-950/30 text-emerald-300 border border-emerald-800/30">
            <FileText className="w-4 h-4" />
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setShowMissingDatesOnly((prev) => !prev);
            scrollToClientPortfolio();
          }}
          className="p-4 rounded-xl flex items-center justify-between text-left transition-all"
          data-accent="warning"
          style={{
            background: 'var(--gradient-card)',
            border: showMissingDatesOnly ? '1px solid var(--stat-warning-alt)' : '1px solid var(--border-soft)',
          }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--ink-soft)' }}>Clients with Missing Dates</p>
            <p className="text-2xl font-bold mt-1 stat-number" style={{ color: 'var(--stat-warning-alt)' }}>
              {missingDatesClients.length}
            </p>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
              {showMissingDatesOnly ? 'Showing only these — click to clear' : 'Click to filter the list below'}
            </p>
          </div>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-amber-950/30 text-amber-300 border border-amber-800/30">
            <Calendar className="w-4 h-4" />
          </div>
        </button>
      </div>

      {/* Module 12 Phase 8: Renewal Queue — clients in 'renewal' status, with quick access to
          the existing renewal-confirmation action in ClientDashboard's Client Lifecycle card. */}
      {renewalClients.length > 0 && (
        <div
          className="rounded-2xl border overflow-hidden"
          data-accent="warning"
          style={{ background: 'var(--gradient-card)', borderColor: 'rgba(245, 226, 154, 0.3)' }}
        >
          <div className="p-4 border-b border-amber-800/30 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-amber-300" />
              <h3 className="text-sm font-bold" style={{ color: 'var(--ink)' }}>Renewal Queue</h3>
            </div>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-bold bg-amber-950/60 text-amber-300 border border-amber-800/40">
              {renewalClients.length} pending
            </span>
          </div>
          <div className="divide-y divide-amber-900/20">
            {renewalClients.map((c) => (
              <div key={c.id} className="p-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold truncate" style={{ color: 'var(--ink)' }}>{c.name}</p>
                  <p className="text-[11px] text-stone-400">
                    Renewal Date: <strong className="text-amber-300">{c.renewal_date || 'Not set'}</strong>
                    {canSeeContractValue(currentRole, c.sales_owner_id === effectiveUserId) && c.contract_value
                      ? ` • ${c.contract_value.toLocaleString()} SAR/mo`
                      : ''}
                  </p>
                </div>
                <button
                  onClick={() => setDashboardClientId(c.id)}
                  className="primary-action px-3 py-1.5 rounded-lg text-[11px] font-bold text-amber-200 bg-amber-900/30 hover:bg-amber-800/50 hover:text-white border border-amber-700/40 transition-all shrink-0 flex items-center gap-1.5"
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
        ref={clientPortfolioRef}
        className="rounded-2xl border overflow-hidden"
        style={{
          background: 'var(--gradient-card)',
          borderColor: 'var(--border-medium)',
        }}
      >
        <div className="p-4 border-b border-purple-900/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-bold" style={{ color: 'var(--ink)' }}>Client Portfolio</h3>
            {/* List / Board toggle (2026-11-02) — Board groups the same clients into columns by
                status (like ClickUp), on top of the List view's own drag-and-drop reorder. */}
            <div className="flex items-center rounded-lg border border-purple-900/40 overflow-hidden text-[11px] font-semibold">
              <button
                type="button"
                onClick={() => setPortfolioViewMode('list')}
                className="px-2.5 py-1 transition-colors"
                style={{
                  background: portfolioViewMode === 'list' ? 'var(--purple-light)' : 'transparent',
                  color: portfolioViewMode === 'list' ? 'var(--ink-inverse, #fff)' : 'var(--ink-soft)',
                }}
              >
                List
              </button>
              <button
                type="button"
                onClick={() => setPortfolioViewMode('board')}
                className="px-2.5 py-1 transition-colors"
                style={{
                  background: portfolioViewMode === 'board' ? 'var(--purple-light)' : 'transparent',
                  color: portfolioViewMode === 'board' ? 'var(--ink-inverse, #fff)' : 'var(--ink-soft)',
                }}
              >
                Board
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {canShowMergeClients && selectedClientIds.size >= 2 && (
              <button
                onClick={() => setMergeModalInitialIds([...selectedClientIds])}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-purple-700 text-white hover:bg-purple-600 whitespace-nowrap"
              >
                <Merge className="w-3.5 h-3.5" />
                Merge Selected ({selectedClientIds.size})
              </button>
            )}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as ClientStatus | 'all')}
              // Solid dark background (same bg-[#120d1e] the "-- Assign AM --" select below
              // already uses) instead of bg-black/30 — a translucent background lets the page
              // behind it show through and reads as near-white in the closed control and the
              // native options popup, which is what made this filter hard to read.
              className="px-3 py-1.5 rounded-xl text-xs bg-[#120d1e] border border-purple-900/40 text-white outline-none focus:border-purple-400"
            >
              {STATUS_FILTER_OPTIONS.map((opt) => {
                const count =
                  opt.key === 'all'
                    ? visibleClients.length
                    : visibleClients.filter((c) => c.status === opt.key).length;
                return (
                  // Explicit inline colors on <option> too — the options popup is rendered by
                  // the OS/browser, not this app's CSS, and some browsers ignore a parent
                  // <select>'s background for that popup unless each <option> also sets one.
                  <option key={opt.key} value={opt.key} style={{ background: '#120d1e', color: '#ffffff' }}>
                    {opt.label} ({count})
                  </option>
                );
              })}
            </select>
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
              Showing <strong style={{ color: 'var(--ink)' }}>{displayedClients.length}</strong> clients
            </span>
          </div>
        </div>

        {portfolioViewMode === 'board' ? (
          displayedClients.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <p className="text-xs text-stone-400">
                {searchQuery ? 'No clients match your search.' : 'No clients found in the onboarding queue.'}
              </p>
            </div>
          ) : (
            <div className="p-4 overflow-x-auto">
              <DndContext sensors={reorderSensors} onDragEnd={handleBoardDragEnd}>
                <div className="flex gap-3">
                  {CLIENT_STATUS_VALUES.map((status) => (
                    <ClientKanbanColumn
                      key={status}
                      status={status}
                      clients={displayedClients.filter((c) => c.status === status)}
                      amAgents={amAgents}
                      amTeamLeaders={amTeamLeaders}
                      canDrag={canReorderClients}
                      onOpenDashboard={setDashboardClientId}
                    />
                  ))}
                </div>
              </DndContext>
            </div>
          )
        ) : displayedClients.length === 0 ? (
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
            <DndContext sensors={reorderSensors} onDragEnd={handleClientDragEnd}>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-purple-900/30 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ink-soft)', background: 'var(--canvas)' }}>
                  {canReorderClients && <th className="py-3 px-2 w-6"></th>}
                  {canShowMergeClients && <th className="py-3 px-4 w-8"></th>}
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
                  // am_agent_id can point to either a regular AM Agent OR an AM Team Lead — the
                  // "-- Assign AM --" dropdown below explicitly allows assigning a team lead
                  // (amTeamLeaders.map(...) alongside amAgents.map(...)). Looking only in
                  // amAgents here was wrongly showing "Unassigned" for a client assigned to a
                  // team lead even though it IS assigned — just not to a plain agent.
                  const assignedAgent =
                    amAgents.find((u) => u.id === client.am_agent_id) ||
                    amTeamLeaders.find((u) => u.id === client.am_agent_id);
                  const lifecycle = getClientLifecycleStatus(client);
                  const services = getClientServices(client);

                  return (
                    <SortableClientRow
                      key={client.id}
                      clientId={client.id}
                      canReorder={canReorderClients}
                      onRowClick={() => setDashboardClientId(client.id)}
                      className="client-portfolio-row hover:bg-purple-950/30 transition-colors cursor-pointer group"
                    >
                      {canShowMergeClients && (
                        <td className="py-3.5 px-4" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${client.name}`}
                            checked={selectedClientIds.has(client.id)}
                            onChange={(e) => {
                              setSelectedClientIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(client.id);
                                else next.delete(client.id);
                                return next;
                              });
                            }}
                          />
                        </td>
                      )}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className="client-initial-avatar w-8 h-8 rounded-lg bg-purple-900/30 border border-purple-700/30 flex items-center justify-center font-bold text-purple-300">
                            {client.name.charAt(0)}
                          </div>
                          <div>
                            <span className="client-portfolio-name font-bold group-hover:text-purple-300 transition-colors inline-flex items-center gap-1.5" style={{ color: 'var(--ink)' }}>
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
                            <span className="font-medium block" style={{ color: 'var(--ink)' }}>Custom Plan</span>
                          )}
                          <div className="flex flex-wrap gap-1">
                            {services.map((s) => (
                              <span
                                key={s}
                                className="chip-service px-1.5 py-0.2 text-[9px] font-bold uppercase tracking-wider"
                                style={{
                                  background: SERVICE_BADGE_COLORS[s]?.bg ?? 'var(--pink-bg)',
                                  color: SERVICE_BADGE_COLORS[s]?.text ?? 'var(--pink)',
                                }}
                              >
                                {SERVICE_LABELS[s]}
                              </span>
                            ))}
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4" onClick={(e) => e.stopPropagation()}>
                        <ClientStatusQuickMenu
                          client={client}
                          statusMeta={CLIENT_STATUS_META[client.status] || CLIENT_STATUS_META.onboarding}
                          lifecycleLabel={lifecycle.label}
                          lifecycleColor={lifecycle.color}
                          canManage={canManageClientStatus(client) && !!onUpdateClientStatus}
                          isUpdating={quickStatusUpdatingId === client.id}
                          canConfirmRenewal={!!onConfirmClientRenewal}
                          onStatusChange={(status) => handleQuickStatusChange(client.id, status)}
                          onConfirmRenewal={() => handleQuickConfirmRenewal(client.id)}
                          onOpenDashboard={() => setDashboardClientId(client.id)}
                        />
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
                              {amTeamLeaders.map((lead) => {
                                const capacityData = getUserCapacityData(lead, clients, tasks, taskAssignees, assignments);
                                return (
                                  <option key={lead.id} value={lead.id}>
                                    {lead.name} (Team Leader) {getCapacityIndicator(capacityData)}
                                  </option>
                                );
                              })}
                              {amAgents.map((ag) => {
                                const capacityData = getUserCapacityData(ag, clients, tasks, taskAssignees, assignments);
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
                          className="primary-action px-3 py-1.5 rounded-lg text-xs font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all inline-flex items-center gap-1.5"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>View Dashboard</span>
                        </button>
                      </td>
                    </SortableClientRow>
                  );
                })}
              </tbody>
            </table>
            </DndContext>
          </div>
        )}
      </div>

      {/* DEDICATED CLIENT DASHBOARD MODAL */}
      {activeDashboardClient && (
        <ClientDashboard
          client={activeDashboardClient}
          lifecyclePeriods={clientLifecyclePeriodsByClientId[activeDashboardClient.id] || []}
          users={users}
          currentUser={resolvedUser}
          briefs={briefs}
          briefRevisions={briefRevisions}
          campaigns={campaigns}
          tasks={tasks}
          dailyLogs={dailyLogs}
          extraNotes={extraNotes}
          assignments={assignments}
          onRefreshAssignments={onRefreshAssignments}
          reports={reports}
          clientComparisons={clientComparisons}
          socialInsights={socialInsights}
          seoInsights={seoInsights}
          clientPortalUser={clientPortalUsers.find((cpu) => cpu.client_id === activeDashboardClient.id) || null}
          onClose={() => setDashboardClientId(null)}
          onSaveBrief={onSaveBrief}
          onSubmitBrief={onSubmitBrief}
          briefFieldSchemas={briefFieldSchemas}
          briefFieldSchemaRows={briefFieldSchemaRows}
          onCreateBriefFieldSchema={onCreateBriefFieldSchema}
          onUpdateBriefFieldSchema={onUpdateBriefFieldSchema}
          onDeleteBriefFieldSchema={onDeleteBriefFieldSchema}
          onDeleteClient={onDeleteClient}
          onForceDeleteClient={onForceDeleteClient}
          onAssignAMAgent={onAssignAMAgent}
          onAssignAMTeamLead={onAssignAMTeamLead}
          onAssignServiceAgent={onAssignServiceAgent}
          onUpdateTaskStatus={onUpdateTaskStatus}
          onUpdateClientStatus={onUpdateClientStatus}
          onConfirmClientRenewal={onConfirmClientRenewal}
          onReopenClient={onReopenClient}
          onMarkClientViewed={onMarkClientViewed}
          onGenerateComparison={onGenerateComparison}
          onGenerateReport={onGenerateReport}
          onGenerateAiSummary={onGenerateAiSummary}
          onGenerateUnifiedReport={onGenerateUnifiedReport}
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
          onUpdateClientDates={onUpdateClientDates}
          onUpdateClientDetails={onUpdateClientDetails}
          onUpdateClientAccess={onUpdateClientAccess}
          onFetchClientAccess={onFetchClientAccess}
          briefAttachments={briefAttachments}
          onUploadBriefAttachment={onUploadBriefAttachment}
          onDeleteBriefAttachment={onDeleteBriefAttachment}
          onFetchClientAccessAttachments={onFetchClientAccessAttachments}
          onUploadClientAccessAttachment={onUploadClientAccessAttachment}
          onDeleteClientAccessAttachment={onDeleteClientAccessAttachment}
          allClients={clients}
          onPreviewMergeClients={onPreviewMergeClients}
          onMergeClients={onMergeClients}
        />
      )}

      {mergeModalInitialIds && onPreviewMergeClients && onMergeClients && (
        <MergeClientsModal
          initialCandidateIds={mergeModalInitialIds}
          clients={clients}
          users={users}
          onPreviewMerge={onPreviewMergeClients}
          onMergeClients={onMergeClients}
          onClose={() => {
            setMergeModalInitialIds(null);
            setSelectedClientIds(new Set());
          }}
        />
      )}
    </div>
  );
};
