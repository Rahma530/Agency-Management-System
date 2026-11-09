import React, { useState, useMemo, useRef } from 'react';
import {
  Building2,
  Search,
  DollarSign,
  AlertTriangle,
  CheckCircle2,
  Eye,
  Users,
  Plus,
  UploadCloud,
} from 'lucide-react';
import { ClientRecord, ClientStatus, UserRecord } from '../types/database';
import { CLIENT_STATUS_META, isCurrentlyActiveClient, isRenewalApproaching } from '../lib/clientStatus';
import { matchesClientQuery } from '../lib/clientSearch';
import { CLIENT_COMPANY_OPTIONS, ClientCompanyId } from '../lib/clientCompany';
import { isActiveEmployee } from '../lib/permissions';
import { ClientKanbanColumn } from './ClientKanbanColumn';

// Head of Sales: agency-wide, read-mostly client status overview (owner's explicit request,
// 2026-11-09) — every client in the agency (NOT owner-scoped like SalesPortalView.tsx's
// sales_owner_id filter), with status/renewal-soon/contract value visible here, and a click-
// through to the same full ClientDashboard every other "open a client" screen uses (rendered by
// App.tsx, same minimal-callback-prop pattern as MyWorkHub's onOpenClientDashboard) — scoped down
// to Overview & Contract / Assigned Team / Service Briefs (view-only, same as every non-AM role
// with hasBriefViewAccess) by ClientDashboard's own role gates.
//
// Register New Client / Bulk Upload (added 2026-11-09, same follow-up request): same two actions
// SalesPortalView.tsx offers, same handlers (App.tsx's handleRegisterClient/handleBulkAddClient
// already fall into the sales-shaped branch — sales_owner_id = self, status starts at
// 'onboarding' — for any role that is neither AM nor management, which head_of_sales is), gated
// the same way AMQueue.tsx's own copy of these two buttons already is: only rendered when the
// caller actually passed a handler (App.tsx only does when canRegisterClients is true).
//
// Filters / List-Board toggle / clickable stat cards (added 2026-11-09, owner request: "same
// Filters and Options as AMQueue's Client Portfolio, and Cards should be clickable"): deliberately
// ported from AMQueue.tsx's Client Portfolio section rather than reinvented, same options arrays
// (STATUS_FILTER_OPTIONS/COMPANY_FILTER_OPTIONS), same click-to-filter-and-scroll stat-card
// convention, and the same ClientKanbanColumn/ClientKanbanCard components for Board view — but
// with canDrag always false. Head of Sales has no reordering/merge concept (sort_order is an
// AM-owned, owner-scoped convenience for working queues; this screen is a read-mostly overview),
// so the whole @dnd-kit drag machinery (DndContext, sensors, reorder handlers) is intentionally
// left out — ClientKanbanCard's onClick→onOpenDashboard fires unconditionally regardless of
// canDrag, and useDraggable/useDroppable both no-op safely outside a DndContext (dnd-kit's
// useContext default is a real object, not undefined — confirmed by reading
// node_modules/@dnd-kit/core's defaultInternalContext), so the column/card pair works standalone.
interface HeadOfSalesPortalViewProps {
  clients: ClientRecord[];
  users: UserRecord[];
  onOpenClientDashboard: (clientId: string) => void;
  onOpenRegisterModal?: () => void;
  onOpenBulkUploadModal?: () => void;
}

const STATUS_FILTER_OPTIONS: { key: ClientStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'renewal', label: 'Renewal' },
  { key: 'closed', label: 'Closed' },
];

const COMPANY_FILTER_OPTIONS: { key: ClientCompanyId | 'all' | 'unassigned'; label: string }[] = [
  { key: 'all', label: 'All Companies' },
  ...CLIENT_COMPANY_OPTIONS.map((opt) => ({ key: opt.value as ClientCompanyId | 'all' | 'unassigned', label: opt.label })),
  { key: 'unassigned', label: 'Unassigned' },
];

const CLIENT_STATUS_VALUES: ClientStatus[] = ['onboarding', 'active', 'renewal', 'paused', 'closed'];

export const HeadOfSalesPortalView: React.FC<HeadOfSalesPortalViewProps> = ({
  clients,
  users,
  onOpenClientDashboard,
  onOpenRegisterModal,
  onOpenBulkUploadModal,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [portfolioViewMode, setPortfolioViewMode] = useState<'list' | 'board'>('list');
  const [statusFilter, setStatusFilter] = useState<ClientStatus | 'all'>('all');
  const [companyFilter, setCompanyFilter] = useState<ClientCompanyId | 'all' | 'unassigned'>('all');
  const [showActiveOnly, setShowActiveOnly] = useState(false);
  const [showRenewalSoonOnly, setShowRenewalSoonOnly] = useState(false);

  // Scroll target for every stat-card click, same reasoning as AMQueue's scrollToClientPortfolio
  // — a filter that only changes a table the person has scrolled away from is easy to miss.
  const clientPortfolioRef = useRef<HTMLDivElement | null>(null);
  const scrollToClientPortfolio = () => {
    clientPortfolioRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const amAgents = useMemo(() => users.filter((u) => u.role === 'am_agent' && isActiveEmployee(u)), [users]);
  const amTeamLeaders = useMemo(() => users.filter((u) => u.role === 'am_team_lead' && isActiveEmployee(u)), [users]);

  const displayedClients = useMemo(
    () =>
      clients
        .filter((c) => matchesClientQuery(c, searchQuery) || (c.industry && c.industry.toLowerCase().includes(searchQuery.toLowerCase().trim())))
        .filter((c) => statusFilter === 'all' || c.status === statusFilter)
        .filter((c) => {
          if (companyFilter === 'all') return true;
          if (companyFilter === 'unassigned') return !c.company;
          return c.company === companyFilter;
        })
        .filter((c) => !showActiveOnly || isCurrentlyActiveClient(c))
        .filter((c) => !showRenewalSoonOnly || isRenewalApproaching(c)),
    [clients, searchQuery, statusFilter, companyFilter, showActiveOnly, showRenewalSoonOnly]
  );

  const activeCount = useMemo(() => clients.filter(isCurrentlyActiveClient).length, [clients]);
  const renewalSoonCount = useMemo(() => clients.filter((c) => isRenewalApproaching(c)).length, [clients]);
  const isShowingAllClients = statusFilter === 'all' && companyFilter === 'all' && !showActiveOnly && !showRenewalSoonOnly;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div
        className="rounded-2xl p-6 relative overflow-hidden border"
        style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-medium)' }}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div className="space-y-1.5">
            <h2 className="text-xl md:text-2xl font-bold text-white">Client Status Overview</h2>
            <p className="text-xs text-stone-400">
              Every client in the agency, at a glance — status, upcoming renewals, and contract value.
            </p>
          </div>

          {(onOpenRegisterModal || onOpenBulkUploadModal) && (
            <div className="flex items-center gap-2 shrink-0">
              {onOpenRegisterModal && (
                <button
                  onClick={onOpenRegisterModal}
                  className="px-4 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 shadow-lg active:scale-98 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 text-black"
                >
                  <Plus className="w-4 h-4" />
                  <span>Register New Client</span>
                </button>
              )}
              {onOpenBulkUploadModal && (
                <button
                  onClick={onOpenBulkUploadModal}
                  className="px-4 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 active:scale-98 text-amber-300 bg-amber-950/40 hover:bg-amber-900/50 border border-amber-700/40"
                >
                  <UploadCloud className="w-4 h-4" />
                  <span>Bulk Upload</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Overview Stat Cards — every card below is clickable: it filters the Client Portfolio
          list to exactly what it's counting and scrolls it into view (same convention as
          AMQueue's Overview Stats Bar). */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          type="button"
          onClick={() => {
            setStatusFilter('all');
            setCompanyFilter('all');
            setShowActiveOnly(false);
            setShowRenewalSoonOnly(false);
            scrollToClientPortfolio();
          }}
          className="p-4 rounded-xl space-y-1.5 text-left transition-all bg-[#161224]/80 border"
          style={{ borderColor: isShowingAllClients ? 'var(--purple-light)' : 'rgba(123, 47, 247, 0.3)' }}
        >
          <div className="flex items-center justify-between text-xs text-stone-400">
            <span>Total Clients</span>
            <Users className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white">{clients.length}</div>
          <p className="text-[10px] text-stone-500">
            {isShowingAllClients ? 'Showing all clients' : 'Click to clear filters'}
          </p>
        </button>

        <button
          type="button"
          onClick={() => {
            setShowActiveOnly((prev) => !prev);
            scrollToClientPortfolio();
          }}
          className="p-4 rounded-xl space-y-1.5 text-left transition-all bg-[#161224]/80 border"
          style={{ borderColor: showActiveOnly ? '#34d399' : 'rgba(123, 47, 247, 0.3)' }}
        >
          <div className="flex items-center justify-between text-xs text-stone-400">
            <span>Currently Active</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400">{activeCount}</div>
          <p className="text-[10px] text-stone-500">
            {showActiveOnly ? 'Showing only these — click to clear' : 'Click to filter the list below'}
          </p>
        </button>

        <button
          type="button"
          onClick={() => {
            setShowRenewalSoonOnly((prev) => !prev);
            scrollToClientPortfolio();
          }}
          className="p-4 rounded-xl space-y-1.5 text-left transition-all bg-[#161224]/80 border"
          style={{ borderColor: showRenewalSoonOnly ? '#fbbf24' : 'rgba(123, 47, 247, 0.3)' }}
        >
          <div className="flex items-center justify-between text-xs text-stone-400">
            <span>Renewal Due Soon (≤7 days)</span>
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-400">{renewalSoonCount}</div>
          <p className="text-[10px] text-stone-500">
            {showRenewalSoonOnly ? 'Showing only these — click to clear' : 'Click to filter the list below'}
          </p>
        </button>
      </div>

      {/* Client List / Board */}
      <div
        ref={clientPortfolioRef}
        className="rounded-2xl border overflow-hidden"
        style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-medium)' }}
      >
        <div className="p-4 border-b border-purple-900/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-bold text-white">All Clients</h3>
            {/* List / Board toggle — same pattern as AMQueue's Client Portfolio. Board groups the
                same clients into columns by status; cards are click-to-open only (no drag). */}
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

          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as ClientStatus | 'all')}
              className="px-3 py-1.5 rounded-xl text-xs bg-[#120d1e] border border-purple-900/40 text-white outline-none focus:border-purple-400"
            >
              {STATUS_FILTER_OPTIONS.map((opt) => {
                const count = opt.key === 'all' ? clients.length : clients.filter((c) => c.status === opt.key).length;
                return (
                  <option key={opt.key} value={opt.key} style={{ background: '#120d1e', color: '#ffffff' }}>
                    {opt.label} ({count})
                  </option>
                );
              })}
            </select>
            <select
              value={companyFilter}
              onChange={(e) => setCompanyFilter(e.target.value as ClientCompanyId | 'all' | 'unassigned')}
              className="px-3 py-1.5 rounded-xl text-xs bg-[#120d1e] border border-purple-900/40 text-white outline-none focus:border-purple-400"
            >
              {COMPANY_FILTER_OPTIONS.map((opt) => {
                const count =
                  opt.key === 'all'
                    ? clients.length
                    : opt.key === 'unassigned'
                      ? clients.filter((c) => !c.company).length
                      : clients.filter((c) => c.company === opt.key).length;
                return (
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
                placeholder="Search name, phone, or industry..."
                className="w-full pl-9 pr-3 py-1.5 rounded-xl text-xs bg-black/30 border border-purple-900/40 text-white outline-none focus:border-purple-400"
              />
            </div>
            <span className="text-xs text-stone-400 whitespace-nowrap">
              Showing <strong className="text-white">{displayedClients.length}</strong> clients
            </span>
          </div>
        </div>

        {portfolioViewMode === 'board' ? (
          displayedClients.length === 0 ? (
            <div className="p-10 text-center space-y-2">
              <p className="text-xs text-stone-400">
                {searchQuery ? 'No clients match your query.' : 'No clients registered yet.'}
              </p>
            </div>
          ) : (
            <div className="p-4 overflow-x-auto">
              <div className="flex gap-3">
                {CLIENT_STATUS_VALUES.map((status) => (
                  <ClientKanbanColumn
                    key={status}
                    status={status}
                    clients={displayedClients.filter((c) => c.status === status)}
                    amAgents={amAgents}
                    amTeamLeaders={amTeamLeaders}
                    canDrag={false}
                    onOpenDashboard={onOpenClientDashboard}
                  />
                ))}
              </div>
            </div>
          )
        ) : displayedClients.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-xs text-stone-400">
              {searchQuery ? 'No clients match your query.' : 'No clients registered yet.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-purple-900/30 text-[11px] font-semibold text-stone-400 uppercase tracking-wider bg-black/20">
                  <th className="py-3 px-4">Client Name</th>
                  <th className="py-3 px-4">Industry</th>
                  <th className="py-3 px-4">Contract Value</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-purple-900/20 text-xs">
                {displayedClients.map((client) => {
                  const statusMeta = CLIENT_STATUS_META[client.status] || CLIENT_STATUS_META.onboarding;
                  const renewalSoon = isRenewalApproaching(client);
                  return (
                    <tr
                      key={client.id}
                      onClick={() => onOpenClientDashboard(client.id)}
                      className="hover:bg-purple-950/30 transition-colors cursor-pointer group"
                    >
                      <td className="py-3.5 px-4 font-bold text-white">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-amber-400/10 text-amber-400 border border-amber-400/20 flex items-center justify-center font-bold text-xs">
                            {client.name.charAt(0)}
                          </div>
                          <span className="group-hover:text-purple-300 transition-colors">{client.name}</span>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-stone-300">{client.industry || 'General Business'}</td>

                      <td className="py-3.5 px-4 font-mono font-bold text-emerald-400">
                        <div className="flex items-center gap-1.5">
                          <DollarSign className="w-3 h-3 shrink-0" />
                          <span>{client.contract_value ? `${client.contract_value.toLocaleString()} SAR` : 'Custom'}</span>
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold border inline-flex items-center gap-1"
                            style={{ background: statusMeta.bg, color: statusMeta.color, borderColor: statusMeta.border }}
                          >
                            <span>{statusMeta.label}</span>
                          </span>
                          {renewalSoon && (
                            <span
                              className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border inline-flex items-center gap-1"
                              style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', borderColor: 'rgba(245, 158, 11, 0.3)' }}
                            >
                              <AlertTriangle className="w-2.5 h-2.5" />
                              <span>Renewal Soon</span>
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenClientDashboard(client.id);
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all inline-flex items-center gap-1.5"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>View Dashboard</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
