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
// Styled with this app's actual dark design-token system (src/index.css: --gradient-card,
// --border-soft, --grey, --canvas, etc. and the bg-stone-900/80 input convention seen in
// CapacityManagement.tsx / AMQueue.tsx) rather than generic light-theme Tailwind grays — the app
// has no separate "dark mode", this IS the theme.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  TrendingUp,
  Users,
  DollarSign,
  Target,
  Plus,
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

// Builds "YYYY-MM-01" for the LOCAL calendar month, without ever going through
// Date#toISOString() — toISOString() converts to UTC first, which silently rolls the date back
// to the last day of the PREVIOUS month for any timezone ahead of UTC (e.g. Africa/Cairo,
// UTC+3) at local midnight. get_mentorship_snapshot() rejects anything that isn't the first of a
// month, so that shift is not cosmetic — it breaks the call outright.
function currentMonthStart(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function fmtMoney(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtPct(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

// Tint/ink pairs drawn from this app's own semantic tokens (index.css), not generic Tailwind
// red/green — same vocabulary as role badges and task-status badges elsewhere in the app.
const STATUS_TOKENS: Record<string, { bg: string; ink: string }> = {
  Successful: { bg: 'var(--success-bg)', ink: 'var(--success)' },
  'Below Target': { bg: 'var(--pink-bg)', ink: 'var(--roas-bad)' },
  Onboarding: { bg: 'var(--info-bg)', ink: 'var(--info)' },
  'No Data': { bg: 'rgba(168,155,184,0.15)', ink: 'var(--grey)' },
  'No Baseline': { bg: 'var(--warning-bg)', ink: 'var(--warning)' },
  'Setup Needed': { bg: 'rgba(168,155,184,0.15)', ink: 'var(--text-lo)' },
};

const inputClass =
  'w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500';
const labelClass = 'text-[11px] font-semibold block mb-1';
const cardStyle = { background: 'var(--gradient-card)', border: '1px solid var(--border-soft)' };

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
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <TrendingUp className="w-5 h-5" style={{ color: 'var(--purple-light)' }} />
          Media Buyers Mentorship
        </h1>
        <div className="flex items-center gap-3">
          <input
            type="month"
            value={reportingMonth.slice(0, 7)}
            onChange={(e) => setReportingMonth(`${e.target.value}-01`)}
            className={`${inputClass} w-auto`}
          />
          <button
            onClick={loadSnapshot}
            className="p-2 rounded-lg border border-stone-800 text-stone-300 hover:text-white hover:bg-stone-900/60"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex gap-1 mb-6 border-b border-stone-800">
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} label="Overview" />
        <TabButton active={tab === 'log'} onClick={() => setTab('log')} label="Log Monthly Data" />
        {isOversightAdmin && (
          <TabButton active={tab === 'oversight'} onClick={() => setTab('oversight')} label="Oversight" />
        )}
      </div>

      {error && (
        <div
          className="mb-4 p-3 rounded-xl text-sm flex items-center gap-2"
          style={{
            background: 'rgba(245,163,163,0.12)',
            border: '1px solid var(--border-rose)',
            color: 'var(--roas-bad)',
          }}
        >
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {tab === 'overview' && (
        <>
          {buyers.length === 0 && !loading && (
            <div className="text-sm py-12 text-center" style={{ color: 'var(--text-lo)' }}>
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
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${
                    activeBuyerId === b.id
                      ? 'bg-purple-600/30 text-white border-purple-500/50'
                      : 'bg-stone-900/60 text-stone-300 border-stone-800 hover:text-white'
                  }`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          )}

          {activeBuyerId && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
                <StatCard icon={<Users className="w-4 h-4" />} label="Total Clients" value={String(totals.totalClients)} />
                <StatCard icon={<DollarSign className="w-4 h-4" />} label="Total Spent" value={fmtMoney(totals.totalSpent)} />
                <StatCard icon={<DollarSign className="w-4 h-4" />} label="Total Sales" value={fmtMoney(totals.totalSales)} />
                <StatCard icon={<TrendingUp className="w-4 h-4" />} label="Overall ROAS" value={totals.overallRoas.toFixed(2)} />
                <StatCard icon={<Target className="w-4 h-4" />} label="Success Rate" value={fmtPct(totals.successRate)} />
              </div>

              <div className="overflow-x-auto rounded-[20px]" style={cardStyle}>
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr
                      className="border-b border-purple-900/30 text-[11px] font-semibold uppercase tracking-wider"
                      style={{ color: 'var(--ink-soft)', background: 'var(--canvas)' }}
                    >
                      <th className="py-3 px-4">Client</th>
                      <th className="py-3 px-4 text-right">Margin</th>
                      <th className="py-3 px-4 text-right">Avg 3M Sales</th>
                      <th className="py-3 px-4 text-right">Avg 3M Spent</th>
                      <th className="py-3 px-4 text-right">Avg 3M Profit</th>
                      <th className="py-3 px-4 text-right">Current Sales</th>
                      <th className="py-3 px-4 text-right">Current Spent</th>
                      <th className="py-3 px-4 text-right">Current Profit</th>
                      <th className="py-3 px-4 text-right">Required Growth</th>
                      <th className="py-3 px-4 text-right">Profit Growth</th>
                      <th className="py-3 px-4">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-purple-900/20 text-xs">
                    {buyerRows.map((r) => {
                      const st = STATUS_TOKENS[r.status] || { bg: 'rgba(168,155,184,0.15)', ink: 'var(--grey)' };
                      return (
                        <tr key={r.client_id}>
                          <td className="py-3.5 px-4 font-semibold text-white">{r.client_name}</td>
                          <td className="py-3.5 px-4 text-right">
                            {r.profit_margin_pct == null ? (
                              <span style={{ color: 'var(--warning)' }}>Not set</span>
                            ) : (
                              <span className="text-stone-300">{fmtPct(r.profit_margin_pct)}</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.avg_3m_sales)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.avg_3m_spent)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.avg_3m_profit)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.current_sales)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.current_spent)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.current_profit)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtPct(r.required_growth_pct)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtPct(r.profit_growth_pct)}</td>
                          <td className="py-3.5 px-4">
                            <span
                              className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                              style={{ background: st.bg, color: st.ink }}
                            >
                              {r.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
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
    className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
      active ? 'border-purple-500 text-white' : 'border-transparent text-stone-400 hover:text-stone-200'
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
  <div className="rounded-[20px] p-3" style={cardStyle}>
    <div className="flex items-center gap-1.5 text-[11px] font-semibold mb-1" style={{ color: 'var(--grey)' }}>
      {icon} {label}
    </div>
    <div className="text-lg font-bold text-white">{value}</div>
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
    <div className="max-w-xl rounded-[20px] p-5" style={cardStyle}>
      <h2 className="font-bold text-white mb-4">Log data for {reportingMonth.slice(0, 7)}</h2>

      <div className="space-y-3">
        <div>
          <label className={labelClass} style={{ color: 'var(--grey)' }}>
            Client
          </label>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={inputClass}>
            <option value="" className="bg-stone-900 text-white">
              Select a client…
            </option>
            {myClients.map(([id, name]) => (
              <option key={id} value={id} className="bg-stone-900 text-white">
                {name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} style={{ color: 'var(--grey)' }}>
            Platform
          </label>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as (typeof PLATFORMS)[number])}
            className={inputClass}
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p} className="bg-stone-900 text-white">
                {p}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass} style={{ color: 'var(--grey)' }}>
              Sales Value
            </label>
            <input type="number" value={sales} onChange={(e) => setSales(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass} style={{ color: 'var(--grey)' }}>
              Ad Spend
            </label>
            <input type="number" value={spend} onChange={(e) => setSpend(e.target.value)} className={inputClass} />
          </div>
        </div>

        {message && (
          <div
            className="text-sm"
            style={{ color: message.type === 'ok' ? 'var(--success)' : 'var(--roas-bad)' }}
          >
            {message.text}
          </div>
        )}

        <button
          onClick={submit}
          disabled={saving}
          className="w-full rounded-xl py-2 text-sm font-bold text-white shadow-md hover:opacity-90 active:scale-98 disabled:opacity-50"
          style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
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
      <div className="rounded-[20px] p-5 mb-5" style={cardStyle}>
        <h2 className="font-bold text-white mb-4 flex items-center gap-2">
          <UserPlus className="w-4 h-4" /> Add oversight
        </h2>
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className={labelClass} style={{ color: 'var(--grey)' }}>
              Overseer
            </label>
            <select value={selectedOverseer} onChange={(e) => setSelectedOverseer(e.target.value)} className={inputClass}>
              {overseers.map((u) => (
                <option key={u.id} value={u.id} className="bg-stone-900 text-white">
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className={labelClass} style={{ color: 'var(--grey)' }}>
              Media Buyer
            </label>
            <select value={selectedBuyer} onChange={(e) => setSelectedBuyer(e.target.value)} className={inputClass}>
              <option value="" className="bg-stone-900 text-white">
                Select…
              </option>
              {mediaBuyers.map((u) => (
                <option key={u.id} value={u.id} className="bg-stone-900 text-white">
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={add}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold text-white shadow-md hover:opacity-90"
            style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
          >
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </div>

      <div className="rounded-[20px] p-5" style={cardStyle}>
        <h2 className="font-bold text-white mb-3">Current oversight</h2>
        {loading ? (
          <div className="text-sm" style={{ color: 'var(--text-lo)' }}>
            Loading…
          </div>
        ) : links.length === 0 ? (
          <div className="text-sm" style={{ color: 'var(--text-lo)' }}>
            No oversight assigned yet.
          </div>
        ) : (
          <ul className="divide-y divide-purple-900/20">
            {links.map((l) => (
              <li
                key={`${l.overseer_id}-${l.media_buyer_id}`}
                className="py-2 flex items-center justify-between text-sm text-stone-200"
              >
                <span>
                  <strong className="text-white">{nameOf(l.overseer_id)}</strong> tracks{' '}
                  <strong className="text-white">{nameOf(l.media_buyer_id)}</strong>
                </span>
                <button
                  onClick={() => remove(l.overseer_id, l.media_buyer_id)}
                  style={{ color: 'var(--roas-bad)' }}
                  className="hover:opacity-75"
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
