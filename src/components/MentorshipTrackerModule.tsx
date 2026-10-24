// Media Buyers Mentorship Tracker — frontend for the backend built in
// 20261203000000_platforms_add_meta_google.sql, 20261204000000_mentorship_sales_margin_tiers.sql,
// 20261205000000_mentorship_oversight.sql and 20261206000000_get_mentorship_snapshot.sql.
//
// Self-contained: fetches its own data via supabaseRaw.rpc('get_mentorship_snapshot', ...) rather
// than relying on App.tsx's central fetch, since that RPC already gates, server-side, who a given
// caller is allowed to see (self media buyer, or an overseer currently tracking them via
// mentorship_oversight) — there is nothing App.tsx needs to pre-fetch or pass down for this to be
// safe. Oversight management (who tracks whom) and the monthly data-entry form live in the same
// file as two in-module views, switched by a local tab state, to keep this a single drop-in
// component.
//
// Wiring into App.tsx (not done here — see the integration note at the bottom of this file):
//   import { MentorshipTrackerModule } from './components/MentorshipTrackerModule';
//   ... render <MentorshipTrackerModule currentUser={currentUser} /> wherever the app's nav
//   decides to show it (e.g. a new sidebar item, visible to media_buying_agent/
//   media_buying_team_lead/executive/head_of_technical — the RPC itself double-checks visibility
//   regardless of what the nav shows).

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  TrendingUp,
  Users,
  DollarSign,
  Target,
  Plus,
  X,
  UserPlus,
  Trash2,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { supabaseRaw } from '../lib/supabase';
import { UserRecord } from '../types/database';

// ----------------------------------------------------------------------------
// Types — shape of get_mentorship_snapshot()'s return table, column for column.
// ----------------------------------------------------------------------------
interface MentorshipSnapshotRow {
  media_buyer_id: string;
  media_buyer_name: string;
  client_id: string;
  client_name: string;
  start_date: string | null;
  profit_margin_pct: number | null;
  avg_3m_sales: number | null;
  avg_3m_spent: number | null;
  avg_3m_roas: number | null;
  avg_3m_profit: number | null;
  current_sales: number | null;
  current_spent: number | null;
  current_roas: number | null;
  current_profit: number | null;
  required_growth_pct: number | null;
  profit_growth_pct: number | null;
  status: string;
}

interface MentorshipOversightRow {
  overseer_id: string;
  media_buyer_id: string;
  assigned_by: string | null;
  assigned_at: string;
}

const OVERSIGHT_ADMIN_ROLES = ['executive', 'head_of_technical', 'media_buying_team_lead'];
const MEDIA_BUYER_ROLE = 'media_buying_agent';

const PLATFORMS = ['tiktok', 'meta', 'snapchat', 'google'] as const;

function currentMonthStart(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function fmtMoney(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtPct(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

const STATUS_STYLES: Record<string, string> = {
  Successful: 'bg-green-100 text-green-800',
  'Below Target': 'bg-red-100 text-red-800',
  Onboarding: 'bg-blue-100 text-blue-800',
  'No Data': 'bg-gray-100 text-gray-600',
  'No Baseline': 'bg-amber-100 text-amber-800',
  'Setup Needed': 'bg-gray-200 text-gray-700',
};

interface MentorshipTrackerModuleProps {
  currentUser: UserRecord;
  allUsers: UserRecord[]; // used only by the oversight tab to list media buyers / overseers by name
}

export const MentorshipTrackerModule: React.FC<MentorshipTrackerModuleProps> = ({
  currentUser,
  allUsers,
}) => {
  const [tab, setTab] = useState<'overview' | 'log' | 'oversight'>('overview');
  const [reportingMonth, setReportingMonth] = useState<string>(currentMonthStart());
  const [rows, setRows] = useState<MentorshipSnapshotRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeBuyerId, setActiveBuyerId] = useState<string | null>(null);

  const isOversightAdmin = OVERSIGHT_ADMIN_ROLES.includes(currentUser.role);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabaseRaw.rpc('get_mentorship_snapshot', {
      p_reporting_month: reportingMonth,
    });
    if (rpcError) {
      setError(rpcError.message);
      setRows([]);
    } else {
      setRows((data as MentorshipSnapshotRow[]) || []);
    }
    setLoading(false);
  }, [reportingMonth]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  const buyers = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((r) => map.set(r.media_buyer_id, r.media_buyer_name));
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [rows]);

  useEffect(() => {
    if (!activeBuyerId && buyers.length > 0) setActiveBuyerId(buyers[0].id);
  }, [buyers, activeBuyerId]);

  const buyerRows = useMemo(
    () => rows.filter((r) => r.media_buyer_id === activeBuyerId),
    [rows, activeBuyerId],
  );

  const totals = useMemo(() => {
    const totalClients = buyerRows.length;
    const totalSpent = buyerRows.reduce((s, r) => s + (r.current_spent || 0), 0);
    const totalSales = buyerRows.reduce((s, r) => s + (r.current_sales || 0), 0);
    const overallRoas = totalSpent > 0 ? totalSales / totalSpent : 0;
    const successful = buyerRows.filter((r) => r.status === 'Successful').length;
    const belowTarget = buyerRows.filter((r) => r.status === 'Below Target').length;
    const successRate = successful + belowTarget > 0 ? successful / (successful + belowTarget) : 0;
    return { totalClients, totalSpent, totalSales, overallRoas, successRate };
  }, [buyerRows]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <TrendingUp className="w-6 h-6 text-indigo-600" />
          Media Buyers Mentorship
        </h1>
        <div className="flex items-center gap-3">
          <input
            type="month"
            value={reportingMonth.slice(0, 7)}
            onChange={(e) => setReportingMonth(`${e.target.value}-01`)}
            className="border rounded-lg px-3 py-1.5 text-sm"
          />
          <button
            onClick={loadSnapshot}
            className="p-2 rounded-lg border hover:bg-gray-50"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-6 border-b">
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} label="Overview" />
        <TabButton active={tab === 'log'} onClick={() => setTab('log')} label="Log Monthly Data" />
        {isOversightAdmin && (
          <TabButton active={tab === 'oversight'} onClick={() => setTab('oversight')} label="Oversight" />
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      {tab === 'overview' && (
        <>
          {buyers.length === 0 && !loading && (
            <div className="text-sm text-gray-500 py-12 text-center">
              No media buyers visible for this month — either none are assigned to you to oversee,
              or there is no data yet.
            </div>
          )}

          {buyers.length > 0 && (
            <div className="flex gap-2 mb-4">
              {buyers.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setActiveBuyerId(b.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                    activeBuyerId === b.id
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          )}

          {activeBuyerId && (
            <>
              <div className="grid grid-cols-5 gap-3 mb-5">
                <StatCard icon={<Users className="w-4 h-4" />} label="Total Clients" value={String(totals.totalClients)} />
                <StatCard icon={<DollarSign className="w-4 h-4" />} label="Total Spent" value={fmtMoney(totals.totalSpent)} />
                <StatCard icon={<DollarSign className="w-4 h-4" />} label="Total Sales" value={fmtMoney(totals.totalSales)} />
                <StatCard icon={<TrendingUp className="w-4 h-4" />} label="Overall ROAS" value={totals.overallRoas.toFixed(2)} />
                <StatCard icon={<Target className="w-4 h-4" />} label="Success Rate" value={fmtPct(totals.successRate)} />
              </div>

              <div className="overflow-x-auto border rounded-xl">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="text-left p-3">Client</th>
                      <th className="text-right p-3">Avg 3M Sales</th>
                      <th className="text-right p-3">Avg 3M Spent</th>
                      <th className="text-right p-3">Avg 3M Profit</th>
                      <th className="text-right p-3">Current Sales</th>
                      <th className="text-right p-3">Current Spent</th>
                      <th className="text-right p-3">Current Profit</th>
                      <th className="text-right p-3">Required Growth</th>
                      <th className="text-right p-3">Profit Growth</th>
                      <th className="text-left p-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buyerRows.map((r) => (
                      <tr key={r.client_id} className="border-t">
                        <td className="p-3 font-medium text-gray-900">{r.client_name}</td>
                        <td className="p-3 text-right">{fmtMoney(r.avg_3m_sales)}</td>
                        <td className="p-3 text-right">{fmtMoney(r.avg_3m_spent)}</td>
                        <td className="p-3 text-right">{fmtMoney(r.avg_3m_profit)}</td>
                        <td className="p-3 text-right">{fmtMoney(r.current_sales)}</td>
                        <td className="p-3 text-right">{fmtMoney(r.current_spent)}</td>
                        <td className="p-3 text-right">{fmtMoney(r.current_profit)}</td>
                        <td className="p-3 text-right">{fmtPct(r.required_growth_pct)}</td>
                        <td className="p-3 text-right">{fmtPct(r.profit_growth_pct)}</td>
                        <td className="p-3">
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              STATUS_STYLES[r.status] || 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {tab === 'log' && (
        <LogMonthlyDataForm
          currentUser={currentUser}
          rows={rows}
          reportingMonth={reportingMonth}
          onSaved={loadSnapshot}
        />
      )}

      {tab === 'oversight' && isOversightAdmin && (
        <OversightPanel currentUser={currentUser} allUsers={allUsers} />
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------------

const TabButton: React.FC<{ active: boolean; onClick: () => void; label: string }> = ({
  active,
  onClick,
  label,
}) => (
  <button
    onClick={onClick}
    className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
      active ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
    }`}
  >
    {label}
  </button>
);

const StatCard: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({
  icon,
  label,
  value,
}) => (
  <div className="border rounded-xl p-3">
    <div className="flex items-center gap-1.5 text-gray-500 text-xs mb-1">
      {icon} {label}
    </div>
    <div className="text-lg font-semibold text-gray-900">{value}</div>
  </div>
);

// Logs one client+platform+month row into public.media_buying_insights (sales_value + spend).
// Writes with week_start_date = first day of the chosen month — the backend's monthly aggregation
// (get_mentorship_snapshot's `monthly` CTE) buckets by date_trunc('month', week_start_date), so a
// single first-of-month row is exactly equivalent to "this client's figure for this month".
// Existing RLS on media_buying_insights (20261030600000) already allows media_buying_agent (for
// their own assigned clients), media_buying_team_lead and am_agent to insert — no new RPC needed.
const LogMonthlyDataForm: React.FC<{
  currentUser: UserRecord;
  rows: MentorshipSnapshotRow[];
  reportingMonth: string;
  onSaved: () => void;
}> = ({ currentUser, rows, reportingMonth, onSaved }) => {
  const myClients = useMemo(
    () => (currentUser.role === MEDIA_BUYER_ROLE
      ? Array.from(new Map(rows.filter((r) => r.media_buyer_id === currentUser.id).map((r) => [r.client_id, r.client_name])).entries())
      : Array.from(new Map(rows.map((r) => [r.client_id, r.client_name])).entries())),
    [rows, currentUser],
  );

  const [clientId, setClientId] = useState('');
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>('meta');
  const [sales, setSales] = useState('');
  const [spend, setSpend] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const submit = async () => {
    if (!clientId || sales === '' || spend === '') {
      setMessage({ type: 'err', text: 'Pick a client and enter both Sales and Spend.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    const id = `mbi_${clientId}_${platform}_${reportingMonth}`;
    const { error } = await supabaseRaw.from('media_buying_insights').upsert(
      {
        id,
        client_id: clientId,
        platform,
        week_start_date: reportingMonth,
        sales_value: Number(sales),
        spend: Number(spend),
        source: 'manual',
        created_by: currentUser.id,
      },
      { onConflict: 'client_id,platform,week_start_date' },
    );
    setSaving(false);
    if (error) {
      setMessage({ type: 'err', text: error.message });
    } else {
      setMessage({ type: 'ok', text: 'Saved.' });
      setSales('');
      setSpend('');
      onSaved();
    }
  };

  return (
    <div className="max-w-xl border rounded-xl p-5">
      <h2 className="font-semibold text-gray-900 mb-4">
        Log data for {reportingMonth.slice(0, 7)}
      </h2>

      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Client</label>
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Select a client…</option>
            {myClients.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Platform</label>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as (typeof PLATFORMS)[number])}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Sales Value</label>
            <input
              type="number"
              value={sales}
              onChange={(e) => setSales(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Ad Spend</label>
            <input
              type="number"
              value={spend}
              onChange={(e) => setSpend(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>

        {message && (
          <div className={`text-sm ${message.type === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
            {message.text}
          </div>
        )}

        <button
          onClick={submit}
          disabled={saving}
          className="w-full bg-indigo-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
};

// Executive / Head of Technical / Media Buying Team Leader only — who tracks which media buyer.
const OversightPanel: React.FC<{ currentUser: UserRecord; allUsers: UserRecord[] }> = ({
  currentUser,
  allUsers,
}) => {
  const [links, setLinks] = useState<MentorshipOversightRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedBuyer, setSelectedBuyer] = useState('');
  const [selectedOverseer, setSelectedOverseer] = useState(currentUser.id);

  const mediaBuyers = useMemo(
    () => allUsers.filter((u) => u.role === MEDIA_BUYER_ROLE && !u.deactivated_at),
    [allUsers],
  );
  const overseers = useMemo(
    () => allUsers.filter((u) => OVERSIGHT_ADMIN_ROLES.includes(u.role) && !u.deactivated_at),
    [allUsers],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabaseRaw.from('mentorship_oversight').select('*');
    if (!error) setLinks((data as MentorshipOversightRow[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!selectedBuyer || !selectedOverseer) return;
    const { error } = await supabaseRaw.rpc('add_mentorship_oversight', {
      p_overseer_id: selectedOverseer,
      p_media_buyer_id: selectedBuyer,
    });
    if (!error) load();
  };

  const remove = async (overseerId: string, buyerId: string) => {
    const { error } = await supabaseRaw.rpc('remove_mentorship_oversight', {
      p_overseer_id: overseerId,
      p_media_buyer_id: buyerId,
    });
    if (!error) load();
  };

  const nameOf = (id: string) => allUsers.find((u) => u.id === id)?.name || id;

  return (
    <div className="max-w-2xl">
      <div className="border rounded-xl p-5 mb-5">
        <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <UserPlus className="w-4 h-4" /> Add oversight
        </h2>
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">Overseer</label>
            <select
              value={selectedOverseer}
              onChange={(e) => setSelectedOverseer(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            >
              {overseers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">Media Buyer</label>
            <select
              value={selectedBuyer}
              onChange={(e) => setSelectedBuyer(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Select…</option>
              {mediaBuyers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={add}
            className="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-indigo-700 flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </div>

      <div className="border rounded-xl p-5">
        <h2 className="font-semibold text-gray-900 mb-3">Current oversight</h2>
        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : links.length === 0 ? (
          <div className="text-sm text-gray-500">No oversight assigned yet.</div>
        ) : (
          <ul className="divide-y">
            {links.map((l) => (
              <li
                key={`${l.overseer_id}-${l.media_buyer_id}`}
                className="py-2 flex items-center justify-between text-sm"
              >
                <span>
                  <strong>{nameOf(l.overseer_id)}</strong> tracks{' '}
                  <strong>{nameOf(l.media_buyer_id)}</strong>
                </span>
                <button
                  onClick={() => remove(l.overseer_id, l.media_buyer_id)}
                  className="text-red-600 hover:text-red-800"
                  title="Remove"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
