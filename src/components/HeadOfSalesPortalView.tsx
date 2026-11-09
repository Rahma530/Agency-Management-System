import React, { useState, useMemo } from 'react';
import { Building2, Search, DollarSign, AlertTriangle, CheckCircle2, Eye, Users, Plus, UploadCloud } from 'lucide-react';
import { ClientRecord } from '../types/database';
import { CLIENT_STATUS_META, isCurrentlyActiveClient, isRenewalApproaching } from '../lib/clientStatus';
import { matchesClientQuery } from '../lib/clientSearch';

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
interface HeadOfSalesPortalViewProps {
  clients: ClientRecord[];
  onOpenClientDashboard: (clientId: string) => void;
  onOpenRegisterModal?: () => void;
  onOpenBulkUploadModal?: () => void;
}

export const HeadOfSalesPortalView: React.FC<HeadOfSalesPortalViewProps> = ({
  clients,
  onOpenClientDashboard,
  onOpenRegisterModal,
  onOpenBulkUploadModal,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredClients = useMemo(() => {
    if (!searchQuery.trim()) return clients;
    const q = searchQuery.toLowerCase().trim();
    return clients.filter(
      (c) => matchesClientQuery(c, searchQuery) || (c.industry && c.industry.toLowerCase().includes(q))
    );
  }, [clients, searchQuery]);

  const activeCount = useMemo(() => clients.filter(isCurrentlyActiveClient).length, [clients]);
  const renewalSoonCount = useMemo(() => clients.filter((c) => isRenewalApproaching(c)).length, [clients]);

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

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl space-y-1.5 bg-[#161224]/80 border border-purple-900/30">
          <div className="flex items-center justify-between text-xs text-stone-400">
            <span>Total Clients</span>
            <Users className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white">{clients.length}</div>
        </div>

        <div className="p-4 rounded-xl space-y-1.5 bg-[#161224]/80 border border-purple-900/30">
          <div className="flex items-center justify-between text-xs text-stone-400">
            <span>Currently Active</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400">{activeCount}</div>
        </div>

        <div className="p-4 rounded-xl space-y-1.5 bg-[#161224]/80 border border-purple-900/30">
          <div className="flex items-center justify-between text-xs text-stone-400">
            <span>Renewal Due Soon (≤7 days)</span>
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-400">{renewalSoonCount}</div>
        </div>
      </div>

      {/* Client List */}
      <div
        className="rounded-2xl border overflow-hidden"
        style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-medium)' }}
      >
        <div className="p-4 border-b border-purple-900/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Building2 className="w-4 h-4 text-amber-400" />
              <span>All Clients</span>
            </h3>
          </div>

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
        </div>

        {filteredClients.length === 0 ? (
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
                {filteredClients.map((client) => {
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
