// AM Renewal page (reworked 2026-11-19 — see PR #327 and this follow-up).
//
// Purpose (owner's own words): track which clients each AM personally brought in and renewed —
// NOT clients Sales registered, even if assigned to the same AM. A client only counts here when
// it carries am_renewal_registered_by (set exclusively by this page's own "New Client" event,
// never inferred from role/sales_owner_id — see 20270115000000_am_renewal_scope.sql).
//
// Visibility: an am_agent sees only clients they personally registered here. An am_team_lead sees
// their own plus every client registered here by an agent who reports to them (users.manager_id).
// executive/head_of_technical see everyone, with an "Agent" filter to narrow by one AM.
//
// Structure: a single "Register Event" button opens one of three flows (owner's own naming):
//   Event 1 — Renewal: search ANY of the AM's own clients (not just what's currently listed —
//     a renewal can be early or late) and log a payment against the client's current cycle.
//   Event 2 — New Client: the ordinary, full client-registration form, tagged so the result shows
//     up here from now on.
//   Event 3 — Upsell: search a client and add a service to their package, optionally raising
//     renewal_value — not a payment, so it never touches client_renewal_payments.
// Two tabs replace the old fixed "due within a week" window: "Due This Month" (renewal_date
// falls in the current calendar month, no payment logged yet for the open cycle) and "Already
// Renewed" (at least one payment logged for the open cycle, full or partial — owner's own rule).

import React, { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Search, Upload, Users as UsersIcon } from 'lucide-react';
import {
  ClientRecord,
  ClientRenewalPaymentRecord,
  RenewalEmployeeTargetRecord,
  RenewalPaymentChannel,
  ServiceType,
  UserRecord,
} from '../types/database';
import { getClientServices, getClientCustomServices, SERVICE_LABELS, CLIENT_SERVICE_OPTIONS } from '../lib/clientServices';
import { splitClientServices } from '../lib/clientServices';

const PAYMENT_CHANNEL_LABELS: Record<RenewalPaymentChannel, string> = {
  mahdy: 'Mahdy',
  masry: 'Masry',
  tabby: 'Tabby',
  tamara: 'Tamara',
  kesra: 'Kesra',
};

const DURATION_OPTIONS: { value: 1 | 3 | 6 | 12; label: string }[] = [
  { value: 1, label: '1 month' },
  { value: 3, label: '3 months' },
  { value: 6, label: '6 months' },
  { value: 12, label: '1 year' },
];

const CORE_SERVICE_FILTERS: ServiceType[] = ['seo', 'social_media', 'media_buying', 'interface', 'creation'];

interface ClientRenewalsPageProps {
  clients: ClientRecord[];
  clientRenewalPayments: ClientRenewalPaymentRecord[];
  renewalEmployeeTargets: RenewalEmployeeTargetRecord[];
  users: UserRecord[];
  currentUser: UserRecord;
  canManageTargets: boolean;
  onRecordRenewalPayment: (
    clientId: string,
    input: {
      renewalValue: number;
      amountPaid: number;
      paymentChannel: RenewalPaymentChannel;
      renewalDurationMonths: 1 | 3 | 6 | 12;
      transferScreenshot: File;
      nextRenewalDate: string;
      newContract?: File | null;
    }
  ) => Promise<void>;
  onSetEmployeeTarget: (employeeId: string, month: string, targetValue: number) => Promise<void>;
  onRecordUpsell: (
    clientId: string,
    patch: { services: ServiceType[]; other_services: string[]; renewal_value?: number }
  ) => Promise<void>;
  onOpenNewClientEvent?: () => void;
}

const currentMonthKey = () => new Date().toISOString().slice(0, 7); // "2026-11"
const cycleSequence = (client: ClientRecord) => (client.renewal_history_count ?? 0) + 1;

export const ClientRenewalsPage: React.FC<ClientRenewalsPageProps> = ({
  clients,
  clientRenewalPayments,
  renewalEmployeeTargets,
  users,
  currentUser,
  canManageTargets,
  onRecordRenewalPayment,
  onSetEmployeeTarget,
  onRecordUpsell,
  onOpenNewClientEvent,
}) => {
  const isManagement = currentUser.role === 'executive' || currentUser.role === 'head_of_technical';
  const isTeamLead = currentUser.role === 'am_team_lead';

  const [agentFilter, setAgentFilter] = useState<string>('');
  const [serviceFilter, setServiceFilter] = useState<ServiceType | ''>('');
  const [durationFilter, setDurationFilter] = useState<1 | 3 | 6 | 12 | ''>('');
  const [activeSubTab, setActiveSubTab] = useState<'due' | 'renewed' | 'performance'>('due');
  const [isEventMenuOpen, setIsEventMenuOpen] = useState(false);
  const [renewalSearchOpen, setRenewalSearchOpen] = useState(false);
  const [upsellSearchOpen, setUpsellSearchOpen] = useState(false);
  const [paymentClientId, setPaymentClientId] = useState<string | null>(null);
  const [upsellClientId, setUpsellClientId] = useState<string | null>(null);

  // Agents this viewer may act on behalf of / see: themselves, or (team lead) their direct
  // reports, or (management) everyone.
  const visibleAgentIds = useMemo(() => {
    if (isManagement) return null; // null = no restriction
    if (isTeamLead) {
      const reportIds = users.filter((u) => u.role === 'am_agent' && u.manager_id === currentUser.id).map((u) => u.id);
      return new Set([currentUser.id, ...reportIds]);
    }
    return new Set([currentUser.id]);
  }, [isManagement, isTeamLead, users, currentUser.id]);

  const agentOptions = useMemo(() => {
    if (isManagement) return users.filter((u) => u.role === 'am_agent' || u.role === 'am_team_lead');
    if (isTeamLead) return users.filter((u) => u.role === 'am_agent' && u.manager_id === currentUser.id);
    return [];
  }, [isManagement, isTeamLead, users, currentUser.id]);

  // The AM Renewal client pool: every client this AM is responsible for right now (am_agent_id —
  // same scoping used everywhere else in the app, e.g. AMQueue/MyWorkHub), not only the ones they
  // personally registered through this page's own "New Client" event. am_renewal_registered_by
  // still tags which of those were self-added (shown as a badge below) rather than restricting
  // the list — owner's 2026-11-19 clarification: renewal tracking covers everyone assigned to the
  // AM, including clients Sales originally registered and simply assigned to them.
  const amRenewalClients = useMemo(() => {
    return clients.filter((c) => {
      if (!c.am_agent_id) return false;
      if (visibleAgentIds && !visibleAgentIds.has(c.am_agent_id)) return false;
      if (agentFilter && c.am_agent_id !== agentFilter) return false;
      return true;
    });
  }, [clients, visibleAgentIds, agentFilter]);

  const paidForCycle = (client: ClientRecord) => {
    const seq = cycleSequence(client);
    return clientRenewalPayments
      .filter((p) => p.client_id === client.id && p.renewal_sequence === seq)
      .reduce((sum, p) => sum + p.amount_paid, 0);
  };

  const hasCyclePayment = (client: ClientRecord) => {
    const seq = cycleSequence(client);
    return clientRenewalPayments.some((p) => p.client_id === client.id && p.renewal_sequence === seq);
  };

  const latestDuration = (client: ClientRecord): 1 | 3 | 6 | 12 | null => {
    const payments = clientRenewalPayments
      .filter((p) => p.client_id === client.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return payments[0]?.renewal_duration_months ?? null;
  };

  // Most clients have no client_renewal_payments row yet (renewal_value/duration only get set
  // once a payment is logged through this page), so fall back to the client's existing contract
  // fields — the real figures already on record for them — instead of showing a blank dash for
  // every client who hasn't been through a Renewal event here yet.
  const effectiveRenewalValue = (client: ClientRecord): number | null =>
    client.renewal_value ?? client.contract_value ?? null;

  const effectiveDurationMonths = (client: ClientRecord): number | null =>
    latestDuration(client) ?? client.contract_duration_months ?? null;

  const formatDuration = (months: number | null): string => {
    if (months == null) return '—';
    const standard = DURATION_OPTIONS.find((d) => d.value === months);
    if (standard) return standard.label;
    return months === 1 ? '1 month' : `${months} months`;
  };

  const remainingForCycle = (client: ClientRecord) => {
    const value = effectiveRenewalValue(client);
    if (value == null) return null;
    return Math.max(0, value - paidForCycle(client));
  };

  const matchesServiceFilter = (client: ClientRecord) =>
    !serviceFilter || getClientServices(client).includes(serviceFilter);

  const matchesDurationFilter = (client: ClientRecord) =>
    !durationFilter || effectiveDurationMonths(client) === durationFilter;

  const now = new Date();
  const dueThisMonth = useMemo(() => {
    return amRenewalClients.filter((c) => {
      if (hasCyclePayment(c)) return false;
      if (!c.renewal_date) return false;
      const d = new Date(c.renewal_date);
      if (Number.isNaN(d.getTime())) return false;
      if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) return false;
      return matchesServiceFilter(c) && matchesDurationFilter(c);
    });
  }, [amRenewalClients, clientRenewalPayments, serviceFilter, durationFilter]);

  const alreadyRenewed = useMemo(() => {
    return amRenewalClients.filter((c) => hasCyclePayment(c) && matchesServiceFilter(c) && matchesDurationFilter(c));
  }, [amRenewalClients, clientRenewalPayments, serviceFilter, durationFilter]);

  const rows = activeSubTab === 'due' ? dueThisMonth : alreadyRenewed;

  // Service filter stats: of every AM-Renewal client this viewer can see, how many currently
  // carry the selected service (whether they started with it or an Upsell event added it) —
  // getClientServices already reflects any Upsell merge, so this needs no separate tracking.
  const serviceStats = useMemo(() => {
    if (!serviceFilter) return null;
    const total = amRenewalClients.length;
    const count = amRenewalClients.filter((c) => getClientServices(c).includes(serviceFilter)).length;
    return { count, total, pct: total === 0 ? 0 : Math.round((count / total) * 100) };
  }, [amRenewalClients, serviceFilter]);

  const month = currentMonthKey();
  const employeeStats = useMemo(() => {
    const scopedIds = visibleAgentIds ? Array.from(visibleAgentIds) : agentOptions.map((u) => u.id);
    const achievedByEmployee = new Map<string, number>();
    clientRenewalPayments
      .filter((p) => p.payment_date.slice(0, 7) === month && (!visibleAgentIds || visibleAgentIds.has(p.recorded_by)))
      .forEach((p) => {
        achievedByEmployee.set(p.recorded_by, (achievedByEmployee.get(p.recorded_by) || 0) + p.amount_paid);
      });

    const ids = new Set([
      ...(agentFilter ? [agentFilter] : scopedIds),
      ...renewalEmployeeTargets
        .filter((t) => t.month.slice(0, 7) === month && (!visibleAgentIds || visibleAgentIds.has(t.employee_id)))
        .map((t) => t.employee_id),
    ]);

    return Array.from(ids).map((employeeId) => {
      const user = users.find((u) => u.id === employeeId);
      const target = renewalEmployeeTargets.find((t) => t.employee_id === employeeId && t.month.slice(0, 7) === month);
      return {
        employeeId,
        name: user?.name || employeeId,
        achieved: achievedByEmployee.get(employeeId) || 0,
        target: target?.target_value ?? null,
      };
    });
  }, [clientRenewalPayments, renewalEmployeeTargets, users, month, visibleAgentIds, agentOptions, agentFilter]);

  const paymentClient = paymentClientId ? clients.find((c) => c.id === paymentClientId) : null;
  const upsellClient = upsellClientId ? clients.find((c) => c.id === upsellClientId) : null;

  return (
    <div className="space-y-6">
      {/* Top bar: filters + Register Event */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80">
        <div className="flex flex-wrap items-center gap-2">
          {(isManagement || isTeamLead) && (
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="px-2 py-1.5 rounded-lg text-xs bg-stone-900/60 border border-stone-700/50 text-stone-200"
            >
              <option value="">All Agents</option>
              {agentOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value as ServiceType | '')}
            className="px-2 py-1.5 rounded-lg text-xs bg-stone-900/60 border border-stone-700/50 text-stone-200"
          >
            <option value="">All Services</option>
            {CORE_SERVICE_FILTERS.map((s) => (
              <option key={s} value={s}>
                {SERVICE_LABELS[s]}
              </option>
            ))}
          </select>
          <select
            value={durationFilter}
            onChange={(e) => setDurationFilter((e.target.value ? Number(e.target.value) : '') as 1 | 3 | 6 | 12 | '')}
            className="px-2 py-1.5 rounded-lg text-xs bg-stone-900/60 border border-stone-700/50 text-stone-200"
          >
            <option value="">All Durations</option>
            {DURATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {serviceStats && (
            <span className="text-[11px] text-purple-300">
              {SERVICE_LABELS[serviceFilter as ServiceType]}: {serviceStats.count}/{serviceStats.total} ({serviceStats.pct}%)
            </span>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => setIsEventMenuOpen((v) => !v)}
            className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-purple-700 hover:bg-purple-600 flex items-center gap-1.5"
          >
            Register Event <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {isEventMenuOpen && (
            // Anchored to the right edge of the button (not the left) and capped to the viewport
            // width, so it never runs off-screen when the button sits near the right edge of a
            // narrow or zoomed-in layout — the earlier left-0/w-56 version did exactly that.
            <div className="absolute right-0 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-purple-900/40 bg-[#1a1530] shadow-xl z-20 overflow-hidden">
              <button
                onClick={() => {
                  setIsEventMenuOpen(false);
                  setRenewalSearchOpen(true);
                }}
                className="w-full text-left px-3.5 py-2.5 hover:bg-purple-900/30"
              >
                <span className="block text-xs font-bold text-stone-100">Renewal</span>
                <span className="block text-[11px] text-stone-400">Log a payment for an existing client</span>
              </button>
              <button
                onClick={() => {
                  setIsEventMenuOpen(false);
                  onOpenNewClientEvent?.();
                }}
                className="w-full text-left px-3.5 py-2.5 hover:bg-purple-900/30"
              >
                <span className="block text-xs font-bold text-stone-100">New Client</span>
                <span className="block text-[11px] text-stone-400">Register a client you brought in</span>
              </button>
              <button
                onClick={() => {
                  setIsEventMenuOpen(false);
                  setUpsellSearchOpen(true);
                }}
                className="w-full text-left px-3.5 py-2.5 hover:bg-purple-900/30"
              >
                <span className="block text-xs font-bold text-stone-100">Upsell</span>
                <span className="block text-[11px] text-stone-400">Add a service to a client's package</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setActiveSubTab('due')}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold ${
            activeSubTab === 'due' ? 'bg-purple-700 text-white' : 'bg-stone-900/50 text-stone-400'
          }`}
        >
          Due This Month ({dueThisMonth.length})
        </button>
        <button
          onClick={() => setActiveSubTab('renewed')}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold ${
            activeSubTab === 'renewed' ? 'bg-purple-700 text-white' : 'bg-stone-900/50 text-stone-400'
          }`}
        >
          Already Renewed ({alreadyRenewed.length})
        </button>
        <button
          onClick={() => setActiveSubTab('performance')}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold ${
            activeSubTab === 'performance' ? 'bg-purple-700 text-white' : 'bg-stone-900/50 text-stone-400'
          }`}
        >
          Team Performance
        </button>
      </div>

      {/* Client list — Due This Month / Already Renewed */}
      {activeSubTab !== 'performance' && (
        <div className="rounded-xl border border-purple-900/30 bg-[#161224]/80 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-stone-400 border-b border-purple-900/30">
                <th className="p-3">Client</th>
                <th className="p-3">Renewal Date</th>
                <th className="p-3">Duration</th>
                <th className="p-3">Renewal Value</th>
                <th className="p-3">Paid</th>
                <th className="p-3">Remaining</th>
                <th className="p-3">Team Size</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((client) => {
                const remaining = remainingForCycle(client);
                const hasRemaining = remaining != null && remaining > 0;
                const renewalValue = effectiveRenewalValue(client);
                return (
                  <tr key={client.id} className={`border-b border-purple-900/10 ${hasRemaining ? 'bg-amber-950/20' : ''}`}>
                    <td className="p-3 font-bold text-stone-200">
                      {client.name}
                      {hasRemaining && <AlertTriangle className="inline-block w-3.5 h-3.5 text-amber-400 ml-1.5" />}
                      {client.am_renewal_registered_by && (
                        <span className="ml-1.5 align-middle px-1.5 py-0.5 rounded-full text-[10px] font-normal bg-purple-900/40 text-purple-300">
                          Self-added
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-stone-300 font-mono text-xs">{client.renewal_date || '—'}</td>
                    <td className="p-3 text-stone-300 text-xs">{formatDuration(effectiveDurationMonths(client))}</td>
                    <td className="p-3 text-stone-200 font-mono">
                      {renewalValue != null ? renewalValue.toLocaleString() : '—'}
                    </td>
                    <td className="p-3 text-emerald-400 font-mono">{paidForCycle(client).toLocaleString()}</td>
                    <td className={`p-3 font-mono ${hasRemaining ? 'text-amber-400 font-bold' : 'text-stone-400'}`}>
                      {remaining != null ? remaining.toLocaleString() : '—'}
                    </td>
                    <td className="p-3 text-stone-300">
                      {(() => {
                        const size = getRenewalTeamSizeSafe(client);
                        return size != null ? (
                          <span className="inline-flex items-center gap-1 text-xs">
                            <UsersIcon className="w-3 h-3" /> {size}
                          </span>
                        ) : (
                          '—'
                        );
                      })()}
                    </td>
                    <td className="p-3">
                      <button
                        onClick={() => setPaymentClientId(client.id)}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 whitespace-nowrap"
                      >
                        Record Payment
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-stone-500 text-xs">
                    No clients in this view.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Team Performance — its own tab, not shown alongside the client list */}
      {activeSubTab === 'performance' && (
        <div className="rounded-xl border border-purple-900/30 bg-[#161224]/80 p-4">
          <h3 className="text-sm font-bold text-stone-200 mb-3">Team Performance This Month</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-stone-400 border-b border-purple-900/20">
                <th className="p-2">Employee</th>
                <th className="p-2">Achieved</th>
                <th className="p-2">Target</th>
                {canManageTargets && <th className="p-2">Edit Target</th>}
              </tr>
            </thead>
            <tbody>
              {employeeStats.map((row) => (
                <EmployeeTargetRow
                  key={row.employeeId}
                  row={row}
                  month={month}
                  canManageTargets={canManageTargets}
                  onSetEmployeeTarget={onSetEmployeeTarget}
                />
              ))}
              {employeeStats.length === 0 && (
                <tr>
                  <td colSpan={canManageTargets ? 4 : 3} className="p-4 text-center text-stone-500 text-xs">
                    No data for this month yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {renewalSearchOpen && (
        <ClientSearchModal
          title="Select a client to log a renewal for"
          clients={amRenewalClients}
          onClose={() => setRenewalSearchOpen(false)}
          onSelect={(id) => {
            setRenewalSearchOpen(false);
            setPaymentClientId(id);
          }}
        />
      )}

      {upsellSearchOpen && (
        <ClientSearchModal
          title="Select a client to upsell"
          clients={amRenewalClients}
          onClose={() => setUpsellSearchOpen(false)}
          onSelect={(id) => {
            setUpsellSearchOpen(false);
            setUpsellClientId(id);
          }}
        />
      )}

      {paymentClient && (
        <RecordPaymentModal
          client={paymentClient}
          onClose={() => setPaymentClientId(null)}
          onSubmit={async (input) => {
            await onRecordRenewalPayment(paymentClient.id, input);
            setPaymentClientId(null);
          }}
        />
      )}

      {upsellClient && (
        <UpsellModal
          client={upsellClient}
          onClose={() => setUpsellClientId(null)}
          onSubmit={async (patch) => {
            await onRecordUpsell(upsellClient.id, patch);
            setUpsellClientId(null);
          }}
        />
      )}
    </div>
  );
};

// getRenewalTeamSize lives in its own module (renewalTeamSizes.ts); imported lazily here via a
// thin wrapper purely to keep this file's top import list shorter — no behavior difference.
import { getRenewalTeamSize as getRenewalTeamSizeSafe } from '../lib/renewalTeamSizes';

const ClientSearchModal: React.FC<{
  title: string;
  clients: ClientRecord[];
  onClose: () => void;
  onSelect: (clientId: string) => void;
}> = ({ title, clients, onClose, onSelect }) => {
  const [query, setQuery] = useState('');
  const filtered = clients.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-purple-900/40 bg-[#1a1530] p-5 space-y-3">
        <h3 className="text-sm font-bold text-stone-200">{title}</h3>
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-stone-900/60 border border-stone-700/50">
          <Search className="w-3.5 h-3.5 text-stone-500" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your clients..."
            className="flex-1 bg-transparent text-sm text-stone-200 outline-none"
          />
        </div>
        <div className="max-h-64 overflow-y-auto divide-y divide-stone-800/60">
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className="w-full text-left px-2 py-2 text-sm text-stone-200 hover:bg-purple-900/20 rounded-lg"
            >
              {c.name}
            </button>
          ))}
          {filtered.length === 0 && <p className="text-xs text-stone-500 py-3 text-center">No clients found.</p>}
        </div>
        <div className="flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-stone-300 bg-stone-800/60">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

const EmployeeTargetRow: React.FC<{
  row: { employeeId: string; name: string; achieved: number; target: number | null };
  month: string;
  canManageTargets: boolean;
  onSetEmployeeTarget: (employeeId: string, month: string, targetValue: number) => Promise<void>;
}> = ({ row, month, canManageTargets, onSetEmployeeTarget }) => {
  const [draft, setDraft] = useState(row.target != null ? String(row.target) : '');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    const value = Number(draft);
    if (!draft || Number.isNaN(value) || value < 0) return;
    setIsSaving(true);
    try {
      await onSetEmployeeTarget(row.employeeId, `${month}-01`, value);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <tr className="border-b border-purple-900/10">
      <td className="p-2 text-stone-200">{row.name}</td>
      <td className="p-2 text-emerald-400 font-mono">{row.achieved.toLocaleString()}</td>
      <td className="p-2 text-stone-300 font-mono">{row.target != null ? row.target.toLocaleString() : '—'}</td>
      {canManageTargets && (
        <td className="p-2 flex items-center gap-2">
          <input
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-24 px-2 py-1 rounded-lg text-xs bg-stone-900/60 border border-stone-700/50 text-stone-200"
          />
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-2 py-1 rounded-lg text-[11px] font-bold text-emerald-200 bg-emerald-900/40 hover:bg-emerald-800/60 disabled:opacity-50"
          >
            {isSaving ? '...' : 'Save'}
          </button>
        </td>
      )}
    </tr>
  );
};

const RecordPaymentModal: React.FC<{
  client: ClientRecord;
  onClose: () => void;
  onSubmit: (input: {
    renewalValue: number;
    amountPaid: number;
    paymentChannel: RenewalPaymentChannel;
    renewalDurationMonths: 1 | 3 | 6 | 12;
    transferScreenshot: File;
    nextRenewalDate: string;
    newContract?: File | null;
  }) => Promise<void>;
}> = ({ client, onClose, onSubmit }) => {
  const [renewalValue, setRenewalValue] = useState(
    client.renewal_value != null ? String(client.renewal_value) : client.contract_value != null ? String(client.contract_value) : ''
  );
  const [amountPaid, setAmountPaid] = useState('');
  const [paymentChannel, setPaymentChannel] = useState<RenewalPaymentChannel>('kesra');
  const [duration, setDuration] = useState<1 | 3 | 6 | 12>(1);
  // Next renewal date is deliberately left blank — never pre-filled/auto-calculated (owner's
  // explicit decision: the real date can slip from what duration-math would predict).
  const [nextRenewalDate, setNextRenewalDate] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [contractChoice, setContractChoice] = useState<'keep' | 'new'>('keep');
  const [newContract, setNewContract] = useState<File | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    const valueNum = Number(renewalValue);
    const paidNum = Number(amountPaid);
    if (!renewalValue || Number.isNaN(valueNum) || valueNum <= 0) {
      setError('Renewal value is required.');
      return;
    }
    if (!amountPaid || Number.isNaN(paidNum) || paidNum <= 0) {
      setError('Amount paid is required.');
      return;
    }
    if (!screenshot) {
      setError('A transfer screenshot is required.');
      return;
    }
    if (!nextRenewalDate) {
      setError('The next renewal date is required.');
      return;
    }
    if (contractChoice === 'new' && !newContract) {
      setError('Please choose a new contract file, or switch back to "Keep existing contract".');
      return;
    }
    setError('');
    setIsSaving(true);
    try {
      await onSubmit({
        renewalValue: valueNum,
        amountPaid: paidNum,
        paymentChannel,
        renewalDurationMonths: duration,
        transferScreenshot: screenshot,
        nextRenewalDate,
        newContract: contractChoice === 'new' ? newContract : null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong while recording this payment.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-xl border border-purple-900/40 bg-[#1a1530] p-5 space-y-3">
        <h3 className="text-sm font-bold text-stone-200">Record Renewal Payment — {client.name}</h3>

        <label className="block text-xs text-stone-400">
          Renewal Value
          <input
            type="number"
            value={renewalValue}
            onChange={(e) => setRenewalValue(e.target.value)}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          />
        </label>

        <label className="block text-xs text-stone-400">
          Amount Paid Now
          <input
            type="number"
            value={amountPaid}
            onChange={(e) => setAmountPaid(e.target.value)}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          />
        </label>

        <label className="block text-xs text-stone-400">
          Paid To
          <select
            value={paymentChannel}
            onChange={(e) => setPaymentChannel(e.target.value as RenewalPaymentChannel)}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          >
            {(Object.keys(PAYMENT_CHANNEL_LABELS) as RenewalPaymentChannel[]).map((c) => (
              <option key={c} value={c}>
                {PAYMENT_CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-stone-400">
          Renewal Duration
          <select
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value) as 1 | 3 | 6 | 12)}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          >
            {DURATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-stone-400">
          Next Renewal Date (type the actual date — never auto-filled)
          <input
            type="date"
            value={nextRenewalDate}
            onChange={(e) => setNextRenewalDate(e.target.value)}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          />
        </label>

        <label className="block text-xs text-stone-400">
          Transfer Screenshot (required)
          <input
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => setScreenshot(e.target.files?.[0] || null)}
            className="w-full mt-1 text-xs text-stone-300"
          />
        </label>

        <div>
          <p className="text-xs text-stone-400 mb-1">Contract</p>
          <div className="flex items-center gap-4 text-xs text-stone-300">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={contractChoice === 'keep'}
                onChange={() => setContractChoice('keep')}
              />
              Keep existing contract
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={contractChoice === 'new'}
                onChange={() => setContractChoice('new')}
              />
              Upload a new contract
            </label>
          </div>
          {contractChoice === 'new' && (
            <input
              type="file"
              accept="image/*,application/pdf,.doc,.docx"
              onChange={(e) => setNewContract(e.target.files?.[0] || null)}
              className="w-full mt-2 text-xs text-stone-300"
            />
          )}
        </div>

        {error && <p className="text-xs text-rose-400">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-stone-300 bg-stone-800/60">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSaving}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-purple-700 hover:bg-purple-600 disabled:opacity-50 flex items-center gap-1.5"
          >
            {isSaving ? '...' : <><Upload className="w-3.5 h-3.5" /> Record Payment</>}
          </button>
        </div>
      </div>
    </div>
  );
};

const UpsellModal: React.FC<{
  client: ClientRecord;
  onClose: () => void;
  onSubmit: (patch: { services: ServiceType[]; other_services: string[]; renewal_value?: number }) => Promise<void>;
}> = ({ client, onClose, onSubmit }) => {
  const existingServices = getClientServices(client);
  const existingCustom = getClientCustomServices(client);
  const [serviceToAdd, setServiceToAdd] = useState<ServiceType | ''>('');
  const [newRenewalValue, setNewRenewalValue] = useState(
    client.renewal_value != null ? String(client.renewal_value) : client.contract_value != null ? String(client.contract_value) : ''
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!serviceToAdd) {
      setError('Select a service to add.');
      return;
    }
    setError('');
    setIsSaving(true);
    try {
      const { services, other_services } = splitClientServices([
        ...existingServices,
        ...existingCustom,
        serviceToAdd,
      ]);
      await onSubmit({
        services,
        other_services,
        renewal_value: newRenewalValue ? Number(newRenewalValue) : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong while recording this upsell.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-purple-900/40 bg-[#1a1530] p-5 space-y-3">
        <h3 className="text-sm font-bold text-stone-200">Upsell — {client.name}</h3>

        <label className="block text-xs text-stone-400">
          Add Service
          <select
            value={serviceToAdd}
            onChange={(e) => setServiceToAdd(e.target.value as ServiceType | '')}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          >
            <option value="">Select a service...</option>
            {CLIENT_SERVICE_OPTIONS.filter(
              (opt) => opt.value !== 'comprehensive' && !existingServices.includes(opt.value as ServiceType)
            ).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-stone-400">
          New Renewal Value (optional — updates what this renewal is worth)
          <input
            type="number"
            value={newRenewalValue}
            onChange={(e) => setNewRenewalValue(e.target.value)}
            className="w-full mt-1 px-2 py-1.5 rounded-lg text-sm bg-stone-900/60 border border-stone-700/50 text-stone-200"
          />
        </label>

        {error && <p className="text-xs text-rose-400">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-stone-300 bg-stone-800/60">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSaving}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-purple-700 hover:bg-purple-600 disabled:opacity-50"
          >
            {isSaving ? '...' : 'Add Upsell'}
          </button>
        </div>
      </div>
    </div>
  );
};
