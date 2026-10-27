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

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  Check,
  X,
  Search,
  Info,
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
  target_roas: number | null;
  status: string;
}

interface MentorshipOversightRow {
  overseer_id: string;
  media_buyer_id: string;
  assigned_by: string | null;
  assigned_at: string;
}

interface MentorshipGrowthTierRow {
  id: number;
  min_spend: number;
  max_spend: number | null;
  required_growth_pct: number;
  active: boolean;
}

const OVERSIGHT_ADMIN_ROLES = ['executive', 'head_of_technical', 'media_buying_team_lead'];
const MEDIA_BUYER_ROLE = 'media_buying_agent';

// mentorship_growth_tiers_write_rls's role list (20261204000000, corrected by
// 20261211000000_mentorship_growth_tiers_role_swap.sql) — same three roles as
// OVERSIGHT_ADMIN_ROLES above; kept as its own name so each call site reads for what it's
// actually gating, even though the role sets happen to be identical right now.
const GROWTH_TIER_ADMIN_ROLES = OVERSIGHT_ADMIN_ROLES;

// 'salla' and 'zid' aren't ad platforms (no spend runs "on" them) — they're the client's store
// platform, logged here anyway because the owner wants to compare what Salla/Zid record as real
// store sales against what the ad platforms (TikTok/Meta/Snapchat/Google) self-report, since those
// numbers routinely don't match. `media_buying_insights.platform` is plain text with no check
// constraint (see 20261030600000_document_media_buying_insights.sql), so adding values here needs
// no migration — same reasoning as the original tiktok/meta/snapchat/google list.
const PLATFORMS = ['tiktok', 'meta', 'snapchat', 'google', 'salla', 'zid'] as const;

// Owner-requested split (after seeing self-reported ad-platform numbers disagree with what the
// store actually recorded): the 4 ad platforms are no longer a place to type Sales/Spend at all —
// they're just a checkbox marking "we're actively running this client on this platform", no
// numbers attached. Salla/Zid are where real Sales/Spend get logged, and that's what
// get_mentorship_snapshot() (20261214000000) now sums into every Avg 3M / Current figure. Checking
// an ad-platform box writes a zero-value placeholder row (so "is this platform active this month"
// is still queryable the same way everything else here is), but the UI never asks for an amount.
const AD_PLATFORMS = ['tiktok', 'meta', 'snapchat', 'google'] as const;
const STORE_PLATFORMS = ['salla', 'zid'] as const;

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

// Short display labels for the per-platform Sales/Spend columns — keeps the (already wide,
// horizontally-scrollable) Overview table header compact.
const PLATFORM_LABELS: Record<(typeof PLATFORMS)[number], string> = {
  tiktok: 'TikTok',
  meta: 'Meta',
  snapchat: 'Snap',
  google: 'Google',
  salla: 'Salla',
  zid: 'Zid',
};

// Tint/ink pairs drawn from this app's own semantic tokens (index.css), not generic Tailwind
// red/green — same vocabulary as role badges and task-status badges elsewhere in the app.
const STATUS_TOKENS: Record<string, { bg: string; ink: string }> = {
  Successful: { bg: 'var(--success-bg)', ink: 'var(--success)' },
  'Below Target': { bg: 'var(--pink-bg)', ink: 'var(--roas-bad)' },
  'No Data': { bg: 'rgba(168,155,184,0.15)', ink: 'var(--grey)' },
  'Setup Needed': { bg: 'rgba(168,155,184,0.15)', ink: 'var(--text-lo)' },
};

const inputClass =
  'w-full px-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500';
const labelClass = 'text-[11px] font-semibold block mb-1';
const cardStyle = { background: 'var(--gradient-card)', border: '1px solid var(--border-soft)' };

// Plain-language restatements of get_mentorship_snapshot()'s actual SQL (20261206000000,
// simplified by 20261212000000) — kept in sync with that function's own column-by-column comment
// block by convention, the same way
// NON_SENSITIVE_CLIENT_COLUMNS and ClientRecord are kept in sync elsewhere in this app. Shown via
// MetricHeader's hover info icon, requested as "a tooltip like Meta Ads Manager's column info
// popups" so a column's exact formula is one hover away instead of needing the SQL file.
const METRIC_INFO: Record<string, { title: string; description: string }> = {
  margin: {
    title: 'Margin',
    description: "The client's profit margin %, set manually. Used in Profit = Sales × Margin − Spend.",
  },
  avg3mSales: {
    title: 'Avg 3M Sales',
    description:
      'Average monthly Sales over the 3 calendar months strictly before the selected month — counts only months that actually have logged data, not a fixed ÷3. Only Salla and Zid (the store platforms) count; TikTok, Meta, Google and Snapchat are just active/inactive markers and are excluded.',
  },
  avg3mSpent: {
    title: 'Avg 3M Spent',
    description:
      'Average monthly Spend over the 3 calendar months strictly before the selected month — counts only months that actually have logged data. Only Salla and Zid count; TikTok, Meta, Google and Snapchat are excluded.',
  },
  avg3mProfit: {
    title: 'Avg 3M Profit',
    description: 'Avg 3M Sales × Margin − Avg 3M Spent.',
  },
  currentSales: {
    title: 'Current Sales',
    description: 'Total Sales logged for the selected month, summed from Salla and Zid only — TikTok, Meta, Google and Snapchat are active/inactive markers and have no Sales/Spend of their own.',
  },
  currentSpent: {
    title: 'Current Spent',
    description: 'Total Spend logged for the selected month, summed from Salla and Zid only — TikTok, Meta, Google and Snapchat are active/inactive markers and have no Sales/Spend of their own.',
  },
  currentProfit: {
    title: 'Current Profit',
    description: 'Current Sales × Margin − Current Spent.',
  },
  currentRoas: {
    title: 'Current ROAS',
    description: 'Current Sales ÷ Current Spent for the selected month. Shows 0.00 when Spend is 0.',
  },
  requiredGrowth: {
    title: 'Required Growth',
    description:
      "Looked up from Avg 3M Spent against the Growth Tiers table (Growth Tiers tab) — a client spending more recently needs a lower growth % to stay on track, and vice versa.",
  },
  profitGrowth: {
    title: 'Profit Growth',
    description:
      '(Current Profit ÷ Avg 3M Profit) − 1. Left blank when Avg 3M Profit is zero or negative — there is no valid baseline to measure growth against.',
  },
  targetRoas: {
    title: 'Target ROAS',
    description:
      "Only shown for a client with no spend history at all (Avg 3M Sales is empty — this would be their first real month): the breakeven ROAS, 1 ÷ Margin — the ROAS needed to just cover Spend (Profit = 0). Blank (—) for any client with spend history, or if Margin isn't set.",
  },
  status: {
    title: 'Status',
    description:
      "Based only on the selected month's own numbers — Start Date plays no role. Setup Needed: Margin not set yet. No Data: nothing logged for the selected month. With no Avg 3M baseline yet (a new client, or no history before this month): Successful once this month's Profit is 0 or positive. With a valid Avg 3M Profit baseline: Successful requires this month's Profit to meet or beat Avg 3M Profit × (1 + Required Growth); otherwise Below Target.",
  },
};

// Small hover-info icon next to a table header's label — click/hover reveals the metric's exact
// formula (METRIC_INFO above). `align` flips which side the popup opens from so it doesn't run
// off the table edge for the first/last columns.
const MetricHeader: React.FC<{ label: string; metricKey: keyof typeof METRIC_INFO; align?: 'left' | 'right' }> = ({
  label,
  metricKey,
  align = 'right',
}) => {
  const [open, setOpen] = useState(false);
  const info = METRIC_INFO[metricKey];
  return (
    <span className="relative inline-flex items-center gap-1 normal-case">
      {label}
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        className="text-stone-500 hover:text-white"
        aria-label={`What is ${label}?`}
      >
        <Info className="w-3 h-3" />
      </button>
      {open && (
        <div
          className={`absolute z-30 top-full mt-2 w-60 p-3 rounded-xl text-left font-normal normal-case ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
          style={{ background: 'var(--canvas)', border: '1px solid var(--border-soft)' }}
        >
          <div className="font-bold text-white text-xs mb-1">{info.title}</div>
          <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-lo)' }}>
            {info.description}
          </div>
        </div>
      )}
    </span>
  );
};

interface MentorshipTrackerModuleProps {
  currentUser: UserRecord;
  allUsers: UserRecord[]; // used only by the oversight tab to list media buyers / overseers by name
}

export const MentorshipTrackerModule: React.FC<MentorshipTrackerModuleProps> = ({
  currentUser,
  allUsers,
}) => {
  const [tab, setTab] = useState<'overview' | 'log' | 'oversight' | 'growth-tiers'>('overview');
  const [reportingMonth, setReportingMonth] = useState<string>(currentMonthStart());
  const [rows, setRows] = useState<MentorshipSnapshotRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeBuyerId, setActiveBuyerId] = useState<string | null>(null);
  // Inline Margin editing — added because neither media_buying_agent nor media_buying_team_lead
  // has a module in src/data/roles.ts's allowedModules that reaches EditClientModal.tsx (that
  // modal only ever opens from ClientDashboard.tsx, gated by canEditClient, which doesn't include
  // either role) — so without this, the backend permission from 20261207000000/20261208000000 had
  // no screen to actually use it from. media_buying_agent only ever sees their own clients here
  // (so every row shown to them is already editable per 20261208000000_update_client_details_mb_
  // agent_margin.sql's assignment check), media_buying_team_lead's grant is margin-only on any
  // client (20261207000000_update_client_details_add_margin.sql), and HOT/Executive have full
  // edit rights anyway (and keep access to EditClientModal too — this is just a faster path).
  const canEditMarginInline =
    currentUser.role === 'media_buying_agent' ||
    currentUser.role === 'media_buying_team_lead' ||
    currentUser.role === 'head_of_technical' ||
    currentUser.role === 'executive';
  const [editingMarginClientId, setEditingMarginClientId] = useState<string | null>(null);
  const [marginInput, setMarginInput] = useState('');
  const [marginSaving, setMarginSaving] = useState(false);
  const [marginError, setMarginError] = useState<string | null>(null);

  const isOversightAdmin = OVERSIGHT_ADMIN_ROLES.includes(currentUser.role);
  const isGrowthTierAdmin = GROWTH_TIER_ADMIN_ROLES.includes(currentUser.role);

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

  const startEditingMargin = (clientId: string, currentPct: number | null) => {
    setEditingMarginClientId(clientId);
    setMarginInput(currentPct != null ? String(Math.round(currentPct * 10000) / 100) : '');
    setMarginError(null);
  };

  const cancelEditingMargin = () => {
    setEditingMarginClientId(null);
    setMarginError(null);
  };

  const handleSaveMargin = async (clientId: string) => {
    const trimmed = marginInput.trim();
    let fraction: number | null = null;
    if (trimmed !== '') {
      const pct = Number(trimmed);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        setMarginError('Enter a number between 0 and 100.');
        return;
      }
      fraction = pct / 100;
    }
    setMarginError(null);
    setMarginSaving(true);
    const { error: rpcError } = await supabaseRaw.rpc('update_client_details', {
      p_client_id: clientId,
      p_patch: { profit_margin_pct: fraction },
    });
    setMarginSaving(false);
    if (rpcError) {
      setMarginError(rpcError.message);
      return;
    }
    setRows((prev) =>
      prev.map((row) => (row.client_id === clientId ? { ...row, profit_margin_pct: fraction } : row))
    );
    setEditingMarginClientId(null);
  };

  // Inline per-platform Sales/Spend editing directly from the Overview checkbox cell — same
  // reasoning and same role gate as Inline Margin editing above (canEditMarginInline covers
  // exactly the roles that can now write media_buying_insights: media_buying_agent for their own
  // assigned clients, media_buying_team_lead/head_of_technical/executive for any client, per
  // 20261210000000_media_buying_insights_admin_emergency_write.sql). Writes through the same
  // upsert LogMonthlyDataForm uses (one row at a time here, since only one platform is being
  // edited), onConflict client_id/platform/week_start_date so re-opening an already-checked box
  // edits that platform's existing row instead of creating a duplicate.
  const [editingPlatformCell, setEditingPlatformCell] = useState<{ clientId: string; platform: string } | null>(
    null
  );
  const [platformAmounts, setPlatformAmounts] = useState<{ sales: string; spend: string }>({ sales: '', spend: '' });
  const [platformSaving, setPlatformSaving] = useState(false);
  const [platformError, setPlatformError] = useState<string | null>(null);

  const startEditingPlatform = (clientId: string, platform: string, current?: { sales: number; spend: number }) => {
    setEditingPlatformCell({ clientId, platform });
    setPlatformAmounts({ sales: current ? String(current.sales) : '', spend: current ? String(current.spend) : '' });
    setPlatformError(null);
  };

  const cancelEditingPlatform = () => {
    setEditingPlatformCell(null);
    setPlatformError(null);
  };

  const handleSavePlatform = async () => {
    if (!editingPlatformCell) return;
    const { clientId, platform } = editingPlatformCell;
    const salesNum = Number(platformAmounts.sales);
    const spendNum = Number(platformAmounts.spend);
    if (platformAmounts.sales === '' || platformAmounts.spend === '' || !Number.isFinite(salesNum) || !Number.isFinite(spendNum)) {
      setPlatformError('Enter both Sales and Spend.');
      return;
    }
    setPlatformError(null);
    setPlatformSaving(true);
    const { error: upsertError } = await supabaseRaw.from('media_buying_insights').upsert(
      [
        {
          id: `mbi_${clientId}_${platform}_${reportingMonth}`,
          client_id: clientId,
          platform,
          week_start_date: reportingMonth,
          sales_value: salesNum,
          spend: spendNum,
          source: 'manual',
          created_by: currentUser.id,
        },
      ],
      { onConflict: 'client_id,platform,week_start_date' }
    );
    setPlatformSaving(false);
    if (upsertError) {
      setPlatformError(upsertError.message);
      return;
    }
    setPlatformBreakdown((prev) => ({
      ...prev,
      [clientId]: { ...prev[clientId], [platform]: { sales: salesNum, spend: spendNum } },
    }));
    setEditingPlatformCell(null);
  };

  // Ad-platform checkbox toggle (tiktok/meta/snapchat/google) — a pure on/off marker, never an
  // amount: checking it writes a zero-value placeholder row (so "active this month" stays
  // queryable the same way as every other platform row), unchecking it deletes that row. No
  // Sales/Spend editor ever opens for these — see AD_PLATFORMS comment above.
  const [adPlatformToggling, setAdPlatformToggling] = useState<string | null>(null);

  const toggleAdPlatform = async (clientId: string, platform: string, currentlyActive: boolean) => {
    const key = `${clientId}:${platform}`;
    setAdPlatformToggling(key);
    if (currentlyActive) {
      await supabaseRaw
        .from('media_buying_insights')
        .delete()
        .eq('client_id', clientId)
        .eq('platform', platform)
        .eq('week_start_date', reportingMonth);
      setPlatformBreakdown((prev) => {
        const next = { ...prev, [clientId]: { ...prev[clientId] } };
        delete next[clientId][platform];
        return next;
      });
    } else {
      await supabaseRaw.from('media_buying_insights').upsert(
        [
          {
            id: `mbi_${clientId}_${platform}_${reportingMonth}`,
            client_id: clientId,
            platform,
            week_start_date: reportingMonth,
            sales_value: 0,
            spend: 0,
            source: 'manual',
            created_by: currentUser.id,
          },
        ],
        { onConflict: 'client_id,platform,week_start_date' }
      );
      setPlatformBreakdown((prev) => ({
        ...prev,
        [clientId]: { ...prev[clientId], [platform]: { sales: 0, spend: 0 } },
      }));
    }
    setAdPlatformToggling(null);
  };

  // Per-platform breakdown for the current reporting month only (not a 3-month average — this
  // drives both the ad-platform active/inactive checkboxes and the Salla/Zid Sales/Spend amounts
  // shown per row). Queried directly from media_buying_insights rather than through
  // get_mentorship_snapshot, which only ever returns per-client totals already summed across
  // platforms — same RLS policy already covers every role that can see these rows
  // (20261030600000_document_media_buying_insights.sql's select policy).
  const [platformBreakdown, setPlatformBreakdown] = useState<
    Record<string, Record<string, { sales: number; spend: number }>>
  >({});

  useEffect(() => {
    const clientIds = Array.from(new Set(rows.map((r) => r.client_id)));
    if (clientIds.length === 0) {
      setPlatformBreakdown({});
      return;
    }
    (async () => {
      const { data, error: fetchError } = await supabaseRaw
        .from('media_buying_insights')
        .select('client_id, platform, sales_value, spend')
        .in('client_id', clientIds)
        .eq('week_start_date', reportingMonth);
      if (fetchError || !data) {
        setPlatformBreakdown({});
        return;
      }
      const map: Record<string, Record<string, { sales: number; spend: number }>> = {};
      (data as { client_id: string; platform: string; sales_value: number | null; spend: number | null }[]).forEach(
        (row) => {
          if (!map[row.client_id]) map[row.client_id] = {};
          map[row.client_id][row.platform] = {
            sales: Number(row.sales_value) || 0,
            spend: Number(row.spend) || 0,
          };
        }
      );
      setPlatformBreakdown(map);
    })();
  }, [rows, reportingMonth]);

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

  // Client-name search for the Overview table — only filters what's DISPLAYED, never `buyerRows`
  // itself, so the stat cards above (Total Clients, Total Spent, Success Rate, etc.) keep
  // reflecting the whole buyer's book regardless of what's currently typed into the search box.
  const [overviewSearch, setOverviewSearch] = useState('');
  const filteredBuyerRows = useMemo(() => {
    const q = overviewSearch.trim().toLowerCase();
    if (!q) return buyerRows;
    return buyerRows.filter((r) => r.client_name.toLowerCase().includes(q));
  }, [buyerRows, overviewSearch]);

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
        {isGrowthTierAdmin && (
          <TabButton active={tab === 'growth-tiers'} onClick={() => setTab('growth-tiers')} label="Growth Tiers" />
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

              <div className="relative mb-3 max-w-xs">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-lo)' }} />
                <input
                  type="text"
                  value={overviewSearch}
                  onChange={(e) => setOverviewSearch(e.target.value)}
                  placeholder="Search client…"
                  className="w-full pl-9 pr-3 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
                />
              </div>

              <div className="overflow-x-auto rounded-[20px]" style={cardStyle}>
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr
                      className="border-b border-purple-900/30 text-[11px] font-semibold uppercase tracking-wider"
                      style={{ color: 'var(--ink-soft)', background: 'var(--canvas)' }}
                    >
                      <th className="py-3 px-4">Client</th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Margin" metricKey="margin" /></th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Avg 3M Sales" metricKey="avg3mSales" /></th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Avg 3M Spent" metricKey="avg3mSpent" /></th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Avg 3M Profit" metricKey="avg3mProfit" /></th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Current Sales" metricKey="currentSales" /></th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Current Spent" metricKey="currentSpent" /></th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Current Profit" metricKey="currentProfit" /></th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Current ROAS" metricKey="currentRoas" /></th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Required Growth" metricKey="requiredGrowth" /></th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Profit Growth" metricKey="profitGrowth" /></th>
                      <th className="py-3 px-4 text-right"><MetricHeader label="Target ROAS" metricKey="targetRoas" /></th>
                      <th className="py-3 px-4"><MetricHeader label="Status" metricKey="status" align="left" /></th>
                      {PLATFORMS.map((p) => (
                        <th key={`head-${p}`} className="py-3 px-4 text-center">
                          {PLATFORM_LABELS[p]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-purple-900/20 text-xs">
                    {filteredBuyerRows.length === 0 && (
                      <tr>
                        <td colSpan={19} className="py-6 text-center" style={{ color: 'var(--text-lo)' }}>
                          No clients match "{overviewSearch}".
                        </td>
                      </tr>
                    )}
                    {filteredBuyerRows.map((r) => {
                      const st = STATUS_TOKENS[r.status] || { bg: 'rgba(168,155,184,0.15)', ink: 'var(--grey)' };
                      const breakdown = platformBreakdown[r.client_id] || {};
                      return (
                        <tr key={r.client_id}>
                          <td className="py-3.5 px-4 font-semibold text-white">{r.client_name}</td>
                          <td className="py-3.5 px-4 text-right">
                            {editingMarginClientId === r.client_id ? (
                              <div className="flex items-center justify-end gap-1.5">
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  autoFocus
                                  value={marginInput}
                                  onChange={(e) => setMarginInput(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveMargin(r.client_id);
                                    if (e.key === 'Escape') cancelEditingMargin();
                                  }}
                                  className="w-16 px-2 py-1 rounded-lg text-xs text-right focus:outline-none"
                                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--purple)', color: 'var(--white)' }}
                                />
                                <button
                                  type="button"
                                  onClick={() => handleSaveMargin(r.client_id)}
                                  disabled={marginSaving}
                                  className="p-1 rounded"
                                  style={{ color: 'var(--success)' }}
                                  title="Save"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEditingMargin}
                                  disabled={marginSaving}
                                  className="p-1 rounded text-stone-400 hover:text-white"
                                  title="Cancel"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : canEditMarginInline ? (
                              <button
                                type="button"
                                onClick={() => startEditingMargin(r.client_id, r.profit_margin_pct)}
                                className="hover:underline"
                              >
                                {r.profit_margin_pct == null ? (
                                  <span style={{ color: 'var(--warning)' }}>Not set</span>
                                ) : (
                                  <span className="text-stone-300">{fmtPct(r.profit_margin_pct)}</span>
                                )}
                              </button>
                            ) : r.profit_margin_pct == null ? (
                              <span style={{ color: 'var(--warning)' }}>Not set</span>
                            ) : (
                              <span className="text-stone-300">{fmtPct(r.profit_margin_pct)}</span>
                            )}
                            {editingMarginClientId === r.client_id && marginError && (
                              <div className="text-[10px] mt-1" style={{ color: 'var(--roas-bad)' }}>{marginError}</div>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.avg_3m_sales)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.avg_3m_spent)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.avg_3m_profit)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.current_sales)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.current_spent)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtMoney(r.current_profit)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">
                            {r.current_roas != null ? r.current_roas.toFixed(2) : '—'}
                          </td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtPct(r.required_growth_pct)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">{fmtPct(r.profit_growth_pct)}</td>
                          <td className="py-3.5 px-4 text-right text-stone-300">
                            {r.target_roas != null ? r.target_roas.toFixed(2) : '—'}
                          </td>
                          <td className="py-3.5 px-4">
                            <span
                              className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                              style={{ background: st.bg, color: st.ink }}
                            >
                              {r.status}
                            </span>
                          </td>
                          {PLATFORMS.map((p) => {
                            const pb = breakdown[p];
                            const active = Boolean(pb);
                            const isEditing =
                              editingPlatformCell?.clientId === r.client_id && editingPlatformCell?.platform === p;
                            const isAdPlatform = (AD_PLATFORMS as readonly string[]).includes(p);
                            if (isAdPlatform) {
                              // Pure on/off marker — no Sales/Spend editor, ever. See AD_PLATFORMS
                              // comment above.
                              const toggling = adPlatformToggling === `${r.client_id}:${p}`;
                              const badge = (
                                <span
                                  className={`inline-flex items-center justify-center w-4 h-4 rounded ${canEditMarginInline ? 'hover:opacity-80' : ''}`}
                                  style={{
                                    border: `1px solid ${active ? 'var(--success)' : 'var(--border-soft)'}`,
                                    background: active ? 'rgba(74, 222, 128, 0.12)' : 'transparent',
                                    opacity: toggling ? 0.5 : 1,
                                  }}
                                >
                                  {active && <Check className="w-3 h-3" style={{ color: 'var(--success)' }} />}
                                </span>
                              );
                              const activeTitle = active
                                ? `${PLATFORM_LABELS[p]}: active this month`
                                : `${PLATFORM_LABELS[p]}: not marked active this month`;
                              return (
                                <td key={`${r.client_id}-${p}`} className="py-3.5 px-4 text-center">
                                  {canEditMarginInline ? (
                                    <button
                                      type="button"
                                      onClick={() => toggleAdPlatform(r.client_id, p, active)}
                                      disabled={toggling}
                                      title={`${activeTitle} — click to ${active ? 'mark inactive' : 'mark active'}`}
                                    >
                                      {badge}
                                    </button>
                                  ) : (
                                    <span title={activeTitle}>{badge}</span>
                                  )}
                                </td>
                              );
                            }
                            return (
                              <td key={`${r.client_id}-${p}`} className="py-3.5 px-4 text-center">
                                {isEditing ? (
                                  <div
                                    className="flex flex-col items-stretch gap-1 text-left"
                                    style={{ minWidth: '92px' }}
                                  >
                                    <input
                                      type="number"
                                      autoFocus
                                      placeholder="Sales"
                                      value={platformAmounts.sales}
                                      onChange={(e) => setPlatformAmounts((prev) => ({ ...prev, sales: e.target.value }))}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSavePlatform();
                                        if (e.key === 'Escape') cancelEditingPlatform();
                                      }}
                                      className="w-full px-1.5 py-1 rounded-lg text-[11px] focus:outline-none"
                                      style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--purple)', color: 'var(--white)' }}
                                    />
                                    <input
                                      type="number"
                                      placeholder="Spend"
                                      value={platformAmounts.spend}
                                      onChange={(e) => setPlatformAmounts((prev) => ({ ...prev, spend: e.target.value }))}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSavePlatform();
                                        if (e.key === 'Escape') cancelEditingPlatform();
                                      }}
                                      className="w-full px-1.5 py-1 rounded-lg text-[11px] focus:outline-none"
                                      style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--purple)', color: 'var(--white)' }}
                                    />
                                    <div className="flex items-center justify-center gap-1.5">
                                      <button
                                        type="button"
                                        onClick={handleSavePlatform}
                                        disabled={platformSaving}
                                        className="p-1 rounded"
                                        style={{ color: 'var(--success)' }}
                                        title="Save"
                                      >
                                        <Check className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={cancelEditingPlatform}
                                        disabled={platformSaving}
                                        className="p-1 rounded text-stone-400 hover:text-white"
                                        title="Cancel"
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                    {platformError && (
                                      <div className="text-[10px]" style={{ color: 'var(--roas-bad)' }}>{platformError}</div>
                                    )}
                                  </div>
                                ) : canEditMarginInline ? (
                                  <button
                                    type="button"
                                    onClick={() => startEditingPlatform(r.client_id, p, pb)}
                                    title={
                                      active
                                        ? `${PLATFORM_LABELS[p]}: Sales ${fmtMoney(pb.sales)} · Spend ${fmtMoney(pb.spend)} — click to edit`
                                        : `${PLATFORM_LABELS[p]}: no data logged this month — click to add`
                                    }
                                  >
                                    <span
                                      className="inline-flex items-center justify-center w-4 h-4 rounded hover:opacity-80"
                                      style={{
                                        border: `1px solid ${active ? 'var(--success)' : 'var(--border-soft)'}`,
                                        background: active ? 'rgba(74, 222, 128, 0.12)' : 'transparent',
                                      }}
                                    >
                                      {active && <Check className="w-3 h-3" style={{ color: 'var(--success)' }} />}
                                    </span>
                                  </button>
                                ) : (
                                  <span
                                    className="inline-flex items-center justify-center w-4 h-4 rounded"
                                    style={{
                                      border: `1px solid ${active ? 'var(--success)' : 'var(--border-soft)'}`,
                                      background: active ? 'rgba(74, 222, 128, 0.12)' : 'transparent',
                                    }}
                                    title={
                                      active
                                        ? `${PLATFORM_LABELS[p]}: Sales ${fmtMoney(pb.sales)} · Spend ${fmtMoney(pb.spend)}`
                                        : `${PLATFORM_LABELS[p]}: no data logged this month`
                                    }
                                  >
                                    {active && <Check className="w-3 h-3" style={{ color: 'var(--success)' }} />}
                                  </span>
                                )}
                              </td>
                            );
                          })}
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

      {tab === 'growth-tiers' && isGrowthTierAdmin && <GrowthTiersPanel />}
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

// Logs one-or-more client+platform+month rows into public.media_buying_insights (sales_value +
// spend) in a single upsert. Writes with week_start_date = first day of the chosen month — the
// backend's monthly aggregation (get_mentorship_snapshot's `monthly` CTE) buckets by
// date_trunc('month', week_start_date), so a single first-of-month row per platform is exactly
// equivalent to "this client's figure for this platform, this month".
//
// Platforms are checkboxes rather than a single dropdown so one submission can log every platform
// this client is actually running on at once (including the non-ad "platforms" salla/zid — see
// the PLATFORMS comment above), instead of re-opening this form once per platform.
//
// Existing RLS on media_buying_insights (20261030600000) already allows media_buying_agent (for
// their own assigned clients), media_buying_team_lead and am_agent to insert — no new RPC needed.
const LogMonthlyDataForm: React.FC<{
  currentUser: UserRecord;
  rows: MentorshipSnapshotRow[];
  reportingMonth: string;
  onSaved: () => void;
}> = ({ currentUser, rows, reportingMonth, onSaved }) => {
  // media_buying_agent: only their own assigned clients (matches media_buying_insights_write_rls
  // — agent_assigned() — exactly). The other 3 roles (executive, head_of_technical,
  // media_buying_team_lead) can now write for ANY client as an emergency fallback (see
  // 20261210000000_media_buying_insights_admin_emergency_write.sql), so for them this pulls the
  // full active client list directly rather than `rows`, which is oversight-scoped
  // (get_mentorship_snapshot only returns a media buyer's clients to an overseer who has
  // explicitly added themselves via mentorship_oversight) — using `rows` here would silently hide
  // exactly the clients an emergency fallback exists to cover.
  const isEmergencyFallbackRole = currentUser.role !== MEDIA_BUYER_ROLE;
  const [allActiveClients, setAllActiveClients] = useState<[string, string][]>([]);

  useEffect(() => {
    if (!isEmergencyFallbackRole) return;
    (async () => {
      const { data } = await supabaseRaw
        .from('clients')
        .select('id, name')
        .neq('status', 'closed')
        .order('name');
      setAllActiveClients(((data as { id: string; name: string }[]) || []).map((c) => [c.id, c.name]));
    })();
  }, [isEmergencyFallbackRole]);

  const myClients = useMemo(
    () => (isEmergencyFallbackRole
      ? allActiveClients
      : Array.from(new Map(rows.filter((r) => r.media_buyer_id === currentUser.id).map((r) => [r.client_id, r.client_name])).entries())),
    [rows, currentUser, isEmergencyFallbackRole, allActiveClients],
  );

  const [clientId, setClientId] = useState('');

  // Searchable client picker — same combobox pattern as ReportsHub's client scope field: one
  // input that both filters AND displays the current selection, instead of a plain <select> that
  // forces scrolling/typeahead through however many clients this role can see (all active clients
  // for the 3 emergency-fallback roles above).
  const [clientSearchQuery, setClientSearchQuery] = useState('');
  const [clientComboboxOpen, setClientComboboxOpen] = useState(false);
  const clientComboboxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!clientComboboxOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (clientComboboxRef.current && !clientComboboxRef.current.contains(event.target as Node)) {
        setClientComboboxOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [clientComboboxOpen]);

  const searchedClients = useMemo(() => {
    const q = clientSearchQuery.trim().toLowerCase();
    if (!q) return myClients;
    return myClients.filter(([, name]) => name.toLowerCase().includes(q));
  }, [myClients, clientSearchQuery]);

  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [amounts, setAmounts] = useState<Record<string, { sales: string; spend: string }>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(false);

  // Pre-fill with whatever's already logged for this client+month (instead of always starting
  // blank) so re-selecting a client you already logged shows and lets you EDIT the existing
  // numbers — previously this form had no way to see what was already there, so re-picking a
  // client looked like "starting from scratch" even though the data existed (same RLS select
  // policy already covers every role that can reach this form).
  useEffect(() => {
    if (!clientId) {
      setSelectedPlatforms(new Set());
      setAmounts({});
      return;
    }
    let cancelled = false;
    setLoadingExisting(true);
    setMessage(null);
    (async () => {
      const { data } = await supabaseRaw
        .from('media_buying_insights')
        .select('platform, sales_value, spend')
        .eq('client_id', clientId)
        .eq('week_start_date', reportingMonth);
      if (cancelled) return;
      setLoadingExisting(false);
      const existing = (data as { platform: string; sales_value: number | null; spend: number | null }[]) || [];
      setSelectedPlatforms(new Set(existing.map((r) => r.platform)));
      const nextAmounts: Record<string, { sales: string; spend: string }> = {};
      existing.forEach((r) => {
        nextAmounts[r.platform] = { sales: String(r.sales_value ?? ''), spend: String(r.spend ?? '') };
      });
      setAmounts(nextAmounts);
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, reportingMonth]);

  const togglePlatform = (p: string) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
    setMessage(null);
  };

  const setAmount = (p: string, field: 'sales' | 'spend', value: string) => {
    setAmounts((prev) => ({ ...prev, [p]: { sales: prev[p]?.sales ?? '', spend: prev[p]?.spend ?? '', [field]: value } }));
  };

  const submit = async () => {
    if (!clientId) {
      setMessage({ type: 'err', text: 'Pick a client first.' });
      return;
    }
    const platformsToSave = PLATFORMS.filter((p) => selectedPlatforms.has(p));
    if (platformsToSave.length === 0) {
      setMessage({ type: 'err', text: 'Check at least one platform.' });
      return;
    }
    const payload: Record<string, unknown>[] = [];
    for (const p of platformsToSave) {
      // Ad platforms (tiktok/meta/snapchat/google) are a pure on/off marker — no amount required,
      // always saved as a zero-value row. Only Salla/Zid need real Sales/Spend entered.
      if ((AD_PLATFORMS as readonly string[]).includes(p)) {
        payload.push({
          id: `mbi_${clientId}_${p}_${reportingMonth}`,
          client_id: clientId,
          platform: p,
          week_start_date: reportingMonth,
          sales_value: 0,
          spend: 0,
          source: 'manual',
          created_by: currentUser.id,
        });
        continue;
      }
      const a = amounts[p];
      if (!a || a.sales === '' || a.spend === '') {
        setMessage({ type: 'err', text: `Enter both Sales and Spend for ${p}.` });
        return;
      }
      payload.push({
        id: `mbi_${clientId}_${p}_${reportingMonth}`,
        client_id: clientId,
        platform: p,
        week_start_date: reportingMonth,
        sales_value: Number(a.sales),
        spend: Number(a.spend),
        source: 'manual',
        created_by: currentUser.id,
      });
    }
    setSaving(true);
    setMessage(null);
    const { error } = await supabaseRaw
      .from('media_buying_insights')
      .upsert(payload, { onConflict: 'client_id,platform,week_start_date' });
    setSaving(false);
    if (error) {
      setMessage({ type: 'err', text: error.message });
    } else {
      setMessage({ type: 'ok', text: `Saved ${platformsToSave.length} platform${platformsToSave.length > 1 ? 's' : ''}.` });
      // Leave the form showing what was just saved (don't blank it back out) — it's now the
      // existing data for this client+month, same as what re-selecting this client would load.
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
          <div className="relative" ref={clientComboboxRef}>
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--grey)' }} />
            <input
              type="text"
              value={clientSearchQuery}
              onChange={(e) => {
                setClientSearchQuery(e.target.value);
                setClientComboboxOpen(true);
                if (clientId) setClientId('');
              }}
              onFocus={(e) => {
                setClientComboboxOpen(true);
                e.target.select();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setClientComboboxOpen(false);
              }}
              placeholder="Search client…"
              className="w-full pl-9 pr-8 py-1.5 rounded-xl text-xs bg-stone-900/80 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            />
            {clientSearchQuery && (
              <button
                type="button"
                onClick={() => {
                  setClientSearchQuery('');
                  setClientId('');
                  setClientComboboxOpen(true);
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-500 hover:text-white"
                aria-label="Clear client"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            {clientComboboxOpen && (
              <div
                className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-xl"
                style={{ background: 'var(--canvas)', border: '1px solid var(--border-soft)' }}
              >
                {searchedClients.length === 0 ? (
                  <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-lo)' }}>
                    No matching clients.
                  </div>
                ) : (
                  searchedClients.map(([id, name]) => (
                    <button
                      key={id}
                      type="button"
                      // onMouseDown (not onClick) fires before the input's outside-click listener
                      // can close the dropdown out from under this click.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setClientId(id);
                        setClientSearchQuery(name);
                        setClientComboboxOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-purple-900/40 ${
                        id === clientId ? 'bg-purple-900/30 text-white' : 'text-stone-300'
                      }`}
                    >
                      {name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {loadingExisting && (
            <div className="text-[11px] mt-1" style={{ color: 'var(--text-lo)' }}>
              Loading what's already logged for this client this month…
            </div>
          )}
        </div>

        <div>
          <label className={labelClass} style={{ color: 'var(--grey)' }}>
            Platforms — check TikTok/Meta/Snapchat/Google to mark them as active this month (no numbers needed); check Salla/Zid to log their actual Sales/Spend below (already-logged ones are pre-filled)
          </label>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((p) => {
              const checked = selectedPlatforms.has(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePlatform(p)}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold capitalize transition-all flex items-center gap-1.5"
                  style={
                    checked
                      ? { background: 'rgba(123, 47, 247, 0.3)', color: 'var(--purple-light)', border: '1px solid var(--purple)' }
                      : { background: 'rgba(10, 10, 13, 0.8)', color: 'var(--grey)', border: '1px solid var(--border-soft)' }
                  }
                >
                  <input type="checkbox" checked={checked} onChange={() => togglePlatform(p)} className="hidden" />
                  {checked && <Check className="w-3.5 h-3.5" />}
                  {p}
                </button>
              );
            })}
          </div>
        </div>

        {(STORE_PLATFORMS as readonly string[]).filter((p) => selectedPlatforms.has(p)).map((p) => (
          <div key={p} className="grid grid-cols-[auto_1fr_1fr] items-end gap-3">
            <div className="text-xs font-semibold capitalize pb-2.5" style={{ color: 'var(--purple-light)' }}>
              {p}
            </div>
            <div>
              <label className={labelClass} style={{ color: 'var(--grey)' }}>
                Sales Value
              </label>
              <input
                type="number"
                value={amounts[p]?.sales ?? ''}
                onChange={(e) => setAmount(p, 'sales', e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} style={{ color: 'var(--grey)' }}>
                Store Spend/Fees
              </label>
              <input
                type="number"
                value={amounts[p]?.spend ?? ''}
                onChange={(e) => setAmount(p, 'spend', e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
        ))}

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

// Executive / Head of Technical / Media Buying Team Lead only (mirrors
// mentorship_growth_tiers_write_rls exactly, per 20261211000000_mentorship_growth_tiers_role_
// swap.sql — ai_engineer never should have had write access here, and media_buying_team_lead,
// who actually runs this tracker day to day, should have) — manages the spend -> required-
// growth-% lookup get_mentorship_snapshot's `tier`
// lateral join reads (avg_3m_spend between min_spend and max_spend, null max_spend = no upper
// bound). Previously DB-only (seeded once from the tracker's original Settings sheet, no UI ever
// built for it) — every client showing the same Required Growth % is expected while they're all
// still in their first 3 months (avg_3m_spend = 0, so everyone falls in the lowest tier); it
// diverges automatically per client once real spend history exists. Rows are edited in place or
// deactivated, never deleted — same posture as public.platforms and the table's own RLS comment —
// so a tier a past calculation already used keeps resolving consistently.
const GrowthTiersPanel: React.FC = () => {
  const [tiers, setTiers] = useState<MentorshipGrowthTierRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editMin, setEditMin] = useState('');
  const [editMax, setEditMax] = useState('');
  const [editPct, setEditPct] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const [newMin, setNewMin] = useState('');
  const [newMax, setNewMax] = useState('');
  const [newPct, setNewPct] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: fetchError } = await supabaseRaw
      .from('mentorship_growth_tiers')
      .select('id, min_spend, max_spend, required_growth_pct, active')
      .order('min_spend');
    if (fetchError) {
      setError(fetchError.message);
    } else {
      setTiers((data as MentorshipGrowthTierRow[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startEditing = (t: MentorshipGrowthTierRow) => {
    setEditingId(t.id);
    setEditMin(String(t.min_spend));
    setEditMax(t.max_spend == null ? '' : String(t.max_spend));
    setEditPct(String(Math.round(t.required_growth_pct * 10000) / 100));
    setEditActive(t.active);
    setError(null);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setError(null);
  };

  const saveEditing = async () => {
    if (editingId == null) return;
    const minNum = Number(editMin);
    const maxNum = editMax.trim() === '' ? null : Number(editMax);
    const pctNum = Number(editPct);
    if (!Number.isFinite(minNum) || minNum < 0) {
      setError('Min Spend must be a number >= 0.');
      return;
    }
    if (maxNum !== null && (!Number.isFinite(maxNum) || maxNum <= minNum)) {
      setError('Max Spend must be greater than Min Spend, or left blank for no upper bound.');
      return;
    }
    if (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100) {
      setError('Required Growth % must be between 0 and 100.');
      return;
    }
    setSaving(true);
    const { error: updateError } = await supabaseRaw
      .from('mentorship_growth_tiers')
      .update({
        min_spend: minNum,
        max_spend: maxNum,
        required_growth_pct: pctNum / 100,
        active: editActive,
      })
      .eq('id', editingId);
    setSaving(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setEditingId(null);
    load();
  };

  const addTier = async () => {
    const minNum = Number(newMin);
    const maxNum = newMax.trim() === '' ? null : Number(newMax);
    const pctNum = Number(newPct);
    if (!Number.isFinite(minNum) || minNum < 0) {
      setError('Min Spend must be a number >= 0.');
      return;
    }
    if (maxNum !== null && (!Number.isFinite(maxNum) || maxNum <= minNum)) {
      setError('Max Spend must be greater than Min Spend, or left blank for no upper bound.');
      return;
    }
    if (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100) {
      setError('Required Growth % must be between 0 and 100.');
      return;
    }
    setAdding(true);
    setError(null);
    const { error: insertError } = await supabaseRaw.from('mentorship_growth_tiers').insert([
      { min_spend: minNum, max_spend: maxNum, required_growth_pct: pctNum / 100, active: true },
    ]);
    setAdding(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setNewMin('');
    setNewMax('');
    setNewPct('');
    load();
  };

  return (
    <div className="max-w-3xl">
      {error && (
        <div
          className="mb-4 p-3 rounded-xl text-sm flex items-center gap-2"
          style={{ background: 'rgba(245,163,163,0.12)', border: '1px solid var(--border-rose)', color: 'var(--roas-bad)' }}
        >
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="rounded-[20px] p-5 mb-5" style={cardStyle}>
        <h2 className="font-bold text-white mb-1">Required Growth tiers</h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-lo)' }}>
          Looked up by a client's Avg 3M Spend. Deactivate a tier instead of deleting it — a past
          month's calculation keeps resolving against whatever was active at the time it ran.
        </p>

        {loading ? (
          <div className="text-sm" style={{ color: 'var(--text-lo)' }}>
            Loading…
          </div>
        ) : (
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr
                className="border-b border-purple-900/30 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--ink-soft)' }}
              >
                <th className="py-2 pr-3">Min Spend</th>
                <th className="py-2 pr-3">Max Spend</th>
                <th className="py-2 pr-3">Required Growth %</th>
                <th className="py-2 pr-3">Active</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-purple-900/20">
              {tiers.map((t) => {
                const isEditing = editingId === t.id;
                return (
                  <tr key={t.id}>
                    <td className="py-2.5 pr-3">
                      {isEditing ? (
                        <input
                          type="number"
                          value={editMin}
                          onChange={(e) => setEditMin(e.target.value)}
                          className={`${inputClass} w-28`}
                        />
                      ) : (
                        <span className="text-stone-300">{fmtMoney(t.min_spend)}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      {isEditing ? (
                        <input
                          type="number"
                          placeholder="No upper bound"
                          value={editMax}
                          onChange={(e) => setEditMax(e.target.value)}
                          className={`${inputClass} w-28`}
                        />
                      ) : (
                        <span className="text-stone-300">{t.max_spend == null ? 'No upper bound' : fmtMoney(t.max_spend)}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      {isEditing ? (
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={editPct}
                          onChange={(e) => setEditPct(e.target.value)}
                          className={`${inputClass} w-20`}
                        />
                      ) : (
                        <span className="text-stone-300">{fmtPct(t.required_growth_pct)}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      {isEditing ? (
                        <input
                          type="checkbox"
                          checked={editActive}
                          onChange={(e) => setEditActive(e.target.checked)}
                        />
                      ) : (
                        <span style={{ color: t.active ? 'var(--success)' : 'var(--text-lo)' }}>
                          {t.active ? 'Active' : 'Inactive'}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5">
                      {isEditing ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={saveEditing}
                            disabled={saving}
                            className="p-1 rounded"
                            style={{ color: 'var(--success)' }}
                            title="Save"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditing}
                            disabled={saving}
                            className="p-1 rounded text-stone-400 hover:text-white"
                            title="Cancel"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEditing(t)}
                          className="text-xs font-semibold hover:underline"
                          style={{ color: 'var(--purple-light)' }}
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {tiers.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-sm" style={{ color: 'var(--text-lo)' }}>
                    No tiers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-[20px] p-5" style={cardStyle}>
        <h2 className="font-bold text-white mb-4 flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add a tier
        </h2>
        <div className="flex gap-3 items-end flex-wrap">
          <div>
            <label className={labelClass} style={{ color: 'var(--grey)' }}>
              Min Spend
            </label>
            <input type="number" value={newMin} onChange={(e) => setNewMin(e.target.value)} className={`${inputClass} w-32`} />
          </div>
          <div>
            <label className={labelClass} style={{ color: 'var(--grey)' }}>
              Max Spend (blank = no limit)
            </label>
            <input type="number" value={newMax} onChange={(e) => setNewMax(e.target.value)} className={`${inputClass} w-40`} />
          </div>
          <div>
            <label className={labelClass} style={{ color: 'var(--grey)' }}>
              Required Growth %
            </label>
            <input type="number" min={0} max={100} value={newPct} onChange={(e) => setNewPct(e.target.value)} className={`${inputClass} w-24`} />
          </div>
          <button
            onClick={addTier}
            disabled={adding}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold text-white shadow-md hover:opacity-90 disabled:opacity-50"
            style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
          >
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </div>
    </div>
  );
};
