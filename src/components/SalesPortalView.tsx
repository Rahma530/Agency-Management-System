import React, { useState, useMemo } from 'react';
import {
  UserCheck,
  Plus,
  Building2,
  Calendar,
  DollarSign,
  Layers,
  ShieldCheck,
  Search,
  CheckCircle2,
  Clock,
  Sparkles,
  Eye,
} from 'lucide-react';
import {
  ClientRecord,
  ClientStatus,
  UserRecord,
  BriefRecord,
  CampaignRecord,
  TaskRecord,
  DailyLogRecord,
  ExtraNoteRecord,
  AssignmentRecord,
  ClientContractRecord,
  ServiceType,
  BriefFieldDef,
  BriefFieldSchemaRow,
} from '../types/database';
import { ClientDashboard } from './ClientDashboard';
import { CLIENT_STATUS_META } from '../lib/clientStatus';
import { matchesClientQuery } from '../lib/clientSearch';

interface SalesPortalViewProps {
  currentUser: UserRecord;
  clients: ClientRecord[];
  users: UserRecord[];
  briefs?: BriefRecord[];
  campaigns?: CampaignRecord[];
  tasks?: TaskRecord[];
  dailyLogs?: DailyLogRecord[];
  extraNotes?: ExtraNoteRecord[];
  assignments?: AssignmentRecord[];
  onOpenRegisterModal: () => void;
  onUpdateClientStatus?: (
    clientId: string,
    newStatus: ClientStatus,
    options?: { churn_reason?: string; renewal_date?: string }
  ) => Promise<void>;
  clientContracts?: ClientContractRecord[];
  onUploadClientContract?: (clientId: string, file: File) => Promise<void>;
  onDeleteClientContract?: (contractId: string) => Promise<void>;
  briefFieldSchemas: Record<ServiceType, BriefFieldDef[]>;
  briefFieldSchemaRows: BriefFieldSchemaRow[];
}

export const SalesPortalView: React.FC<SalesPortalViewProps> = ({
  currentUser,
  clients,
  users,
  briefs = [],
  campaigns = [],
  tasks = [],
  dailyLogs = [],
  extraNotes = [],
  assignments = [],
  onOpenRegisterModal,
  onUpdateClientStatus,
  clientContracts = [],
  onUploadClientContract,
  onDeleteClientContract,
  briefFieldSchemas,
  briefFieldSchemaRows,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [dashboardClientId, setDashboardClientId] = useState<string | null>(null);

  // Strict: Only clients personally submitted by this sales user
  const personalClients = useMemo(() => {
    return clients.filter((c) => c.sales_owner_id === currentUser.id);
  }, [clients, currentUser.id]);

  const filteredClients = useMemo(() => {
    if (!searchQuery.trim()) return personalClients;
    const q = searchQuery.toLowerCase().trim();
    // Module 14: name-or-phone via the shared predicate, industry/id kept as this screen's own
    // pre-existing extra match dimensions.
    return personalClients.filter(
      (c) =>
        matchesClientQuery(c, searchQuery) ||
        (c.industry && c.industry.toLowerCase().includes(q)) ||
        c.id.toLowerCase().includes(q)
    );
  }, [personalClients, searchQuery]);

  const totalContractValue = useMemo(() => {
    return personalClients.reduce((sum, c) => sum + (c.contract_value || 0), 0);
  }, [personalClients]);

  const activeDashboardClient = useMemo(
    () => clients.find((c) => c.id === dashboardClientId) || null,
    [clients, dashboardClientId]
  );

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div
        className="rounded-2xl p-6 relative overflow-hidden border"
        style={{
          background: 'var(--gradient-card)',
          borderColor: 'var(--border-medium)',
        }}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 bg-amber-500/20 text-amber-300 border border-amber-500/30">
                <UserCheck className="w-3.5 h-3.5" />
                <span>Sales Portal</span>
              </span>
              <span className="text-[11px] px-2.5 py-0.5 font-medium rounded-full bg-purple-900/30 text-purple-300 border border-purple-700/30">
                RLS Active: Personal Submissions
              </span>
            </div>

            <h2 className="text-xl md:text-2xl font-bold text-white">
              Client Acquisition & Onboarding Intake
            </h2>
            <p className="text-xs text-stone-300 max-w-xl">
              Register closed client contracts and route them directly to Account Management for intake.
            </p>
          </div>

          <button
            id="btn-sales-register-client"
            onClick={onOpenRegisterModal}
            className="px-4 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 shadow-lg active:scale-98 shrink-0 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 text-black"
          >
            <Plus className="w-4 h-4" />
            <span>Register New Client</span>
          </button>
        </div>
      </div>

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl space-y-1.5 bg-[#161224]/80 border border-purple-900/30">
          <div className="flex items-center justify-between text-xs text-stone-400">
            <span>Registered Clients</span>
            <Building2 className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white">
            {personalClients.length}
          </div>
          <span className="text-[11px] text-stone-400 block">Referred to Account Management</span>
        </div>

        <div className="p-4 rounded-xl space-y-1.5 bg-[#161224]/80 border border-purple-900/30">
          <div className="flex items-center justify-between text-xs text-stone-400">
            <span>Total Contract Value</span>
            <DollarSign className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400">
            {totalContractValue.toLocaleString()} SAR
          </div>
          <span className="text-[11px] text-stone-400 block">Cumulative monthly volume</span>
        </div>

        <div className="p-4 rounded-xl space-y-1.5 bg-[#161224]/80 border border-purple-900/30">
          <div className="flex items-center justify-between text-xs text-stone-400">
            <span>Handoff Workflow</span>
            <Clock className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-sm font-bold text-purple-200 mt-1 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-purple-400" />
            <span>Auto-Routed to AM</span>
          </div>
          <span className="text-[11px] text-stone-400 block">Registered clients go straight to the AM Team Lead</span>
        </div>
      </div>

      {/* Lightweight Client List */}
      <div
        className="rounded-2xl border overflow-hidden"
        style={{
          background: 'var(--gradient-card)',
          borderColor: 'var(--border-medium)',
        }}
      >
        <div className="p-4 border-b border-purple-900/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Building2 className="w-4 h-4 text-amber-400" />
              <span>Personally Acquired Clients</span>
            </h3>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, phone, industry, or ID..."
              className="w-full pl-9 pr-3 py-1.5 rounded-xl text-xs bg-black/30 border border-purple-900/40 text-white outline-none focus:border-purple-400"
            />
          </div>
        </div>

        {filteredClients.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-xs text-stone-400">
              {searchQuery
                ? 'No clients match your query.'
                : 'No clients registered yet. Click "Register New Client" to start.'}
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
                  <th className="py-3 px-4">Contract Value</th>
                  <th className="py-3 px-4">Start Date</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-purple-900/20 text-xs">
                {filteredClients.map((client) => {
                  return (
                    <tr
                      key={client.id}
                      onClick={() => setDashboardClientId(client.id)}
                      className="hover:bg-purple-950/30 transition-colors cursor-pointer group"
                    >
                      <td className="py-3.5 px-4 font-bold text-white">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-amber-400/10 text-amber-400 border border-amber-400/20 flex items-center justify-center font-bold text-xs">
                            {client.name.charAt(0)}
                          </div>
                          <div>
                            <span className="group-hover:text-purple-300 transition-colors block">
                              {client.name}
                            </span>
                            <span className="text-[10px] font-mono text-stone-500 font-normal">
                              {client.id}
                            </span>
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-stone-300">
                        {client.industry || 'General Business'}
                      </td>

                      <td className="py-3.5 px-4">
                        {client.services && client.services.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {client.services.map((s) => (
                              <span
                                key={s}
                                className="text-[9px] px-1.5 py-0.2 rounded bg-purple-950 text-purple-300 border border-purple-800/40 uppercase"
                              >
                                {s.replace('_', ' ')}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-stone-500">Custom Plan</span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 font-mono font-bold text-emerald-400">
                        {client.contract_value ? `${client.contract_value.toLocaleString()} SAR` : 'Custom'}
                      </td>

                      <td className="py-3.5 px-4 text-stone-400 font-mono">
                        {client.start_date || 'Immediate'}
                      </td>

                      <td className="py-3.5 px-4">
                        <span
                          className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold border inline-flex items-center gap-1"
                          style={{
                            background: (CLIENT_STATUS_META[client.status] || CLIENT_STATUS_META.onboarding).bg,
                            color: (CLIENT_STATUS_META[client.status] || CLIENT_STATUS_META.onboarding).color,
                            borderColor: (CLIENT_STATUS_META[client.status] || CLIENT_STATUS_META.onboarding).border,
                          }}
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          <span>{(CLIENT_STATUS_META[client.status] || CLIENT_STATUS_META.onboarding).label}</span>
                        </span>
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
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

      {/* DEDICATED CLIENT DASHBOARD MODAL */}
      {activeDashboardClient && (
        <ClientDashboard
          client={activeDashboardClient}
          users={users}
          currentUser={currentUser}
          briefs={briefs}
          campaigns={campaigns}
          tasks={tasks}
          dailyLogs={dailyLogs}
          extraNotes={extraNotes}
          assignments={assignments}
          onUpdateClientStatus={onUpdateClientStatus}
          clientContracts={clientContracts}
          onUploadClientContract={onUploadClientContract}
          onDeleteClientContract={onDeleteClientContract}
          briefFieldSchemas={briefFieldSchemas}
          briefFieldSchemaRows={briefFieldSchemaRows}
          onClose={() => setDashboardClientId(null)}
        />
      )}
    </div>
  );
};
