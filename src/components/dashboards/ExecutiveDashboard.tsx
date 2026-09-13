import React, { useMemo, useState } from 'react';
import { DollarSign, Users, TrendingDown, Building2, AlertCircle } from 'lucide-react';
import { ClientRecord, CampaignRecord, TaskRecord, SocialInsightRecord, UserRecord } from '../../types/database';
import { ComparisonGranularity, resolveComparisonPeriods } from '../../lib/reportingEngine';
import { DepartmentComparisonPanel } from './DepartmentComparisonPanel';
import { isCurrentlyActiveClient } from '../../lib/clientStatus';

const CHURN_GRANULARITY_OPTIONS: { value: ComparisonGranularity; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

const StatTile: React.FC<{
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  caption?: string;
  accent?: string;
}> = ({ label, value, icon: Icon, caption, accent }) => (
  <div className="p-4 rounded-xl bg-stone-900/60 border border-stone-800">
    <div className="flex items-center justify-between text-stone-400 mb-1.5">
      <span className="text-[11px] font-semibold">{label}</span>
      <Icon className="w-4 h-4" style={accent ? { color: accent } : undefined} />
    </div>
    <p className="text-2xl font-bold" style={{ color: accent || 'white' }}>
      {value}
    </p>
    {caption && <p className="text-[10px] text-stone-500 mt-1">{caption}</p>}
  </div>
);

export const ExecutiveDashboard: React.FC<{
  clients: ClientRecord[];
  campaigns: CampaignRecord[];
  tasks: TaskRecord[];
  socialInsights: SocialInsightRecord[];
  users: UserRecord[];
}> = ({ clients, campaigns, tasks, socialInsights, users }) => {
  const [churnGranularity, setChurnGranularity] = useState<ComparisonGranularity>('monthly');

  // Revenue and client counts are current-snapshot figures, not period-comparable — there's no
  // invoice/payment history in this schema, only each client's present contract_value/status.
  const statusCounts = useMemo(() => {
    const counts: Record<ClientRecord['status'], number> = { onboarding: 0, active: 0, paused: 0, renewal: 0, closed: 0 };
    clients.forEach((c) => {
      counts[c.status] = (counts[c.status] || 0) + 1;
    });
    return counts;
  }, [clients]);

  // Decision (Module 13): paused clients still count toward MRR — they're intentionally halted,
  // not de-billed — so this stays broader than isCurrentlyActiveClient (which excludes paused).
  const mrr = useMemo(
    () =>
      clients
        .filter((c) => c.status === 'active' || c.status === 'renewal' || c.status === 'paused')
        .reduce((sum, c) => sum + (c.contract_value || 0), 0),
    [clients]
  );

  // Churn rate: genuinely period-scoped now via clients.churned_at (added this phase). The
  // denominator approximates "clients that existed at period start" via created_at, since there's
  // no historical status snapshot to check what a client's status actually was on that date —
  // the best available proxy given the schema, same spirit as every other approximation already
  // flagged elsewhere in this app (campaign date-range overlap, SEO's delivery-only proxy, etc.).
  const churnStats = useMemo(() => {
    const period = resolveComparisonPeriods(churnGranularity).current;
    const existedAtStart = clients.filter((c) => (c.created_at || '') < period.range.start);
    const churnedInPeriod = clients.filter(
      (c) => c.status === 'closed' && c.churned_at && c.churned_at >= period.range.start && c.churned_at <= period.range.end
    );
    const legacyChurned = clients.filter((c) => c.status === 'closed' && !c.churned_at);
    const rate = existedAtStart.length > 0 ? Math.round((churnedInPeriod.length / existedAtStart.length) * 1000) / 10 : null;
    return { periodLabel: period.label, rate, churnedInPeriod: churnedInPeriod.length, base: existedAtStart.length, legacyChurned: legacyChurned.length };
  }, [clients, churnGranularity]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Monthly Recurring Revenue"
          value={`${mrr.toLocaleString()} SAR`}
          icon={DollarSign}
          accent="var(--roas-good)"
          caption="Active + Renewal + Paused contract value, current snapshot"
        />
        <StatTile
          label="Active Clients"
          value={clients.filter(isCurrentlyActiveClient).length}
          icon={Building2}
          caption={`${statusCounts.onboarding} onboarding, ${statusCounts.paused} paused`}
        />
        <StatTile
          label="Total Clients"
          value={clients.length}
          icon={Users}
          caption={`${statusCounts.closed} closed all-time`}
        />
        <div className="p-4 rounded-xl bg-stone-900/60 border border-stone-800">
          <div className="flex items-center justify-between text-stone-400 mb-1.5">
            <span className="text-[11px] font-semibold">Churn Rate</span>
            <TrendingDown className="w-4 h-4" style={{ color: 'var(--roas-bad)' }} />
          </div>
          <p className="text-2xl font-bold" style={{ color: 'var(--roas-bad)' }}>
            {churnStats.rate !== null ? `${churnStats.rate}%` : 'N/A'}
          </p>
          <p className="text-[10px] text-stone-500 mt-1">
            {churnStats.churnedInPeriod} of {churnStats.base} clients, {churnStats.periodLabel}
          </p>
          <div className="flex items-center gap-1 mt-2">
            {CHURN_GRANULARITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setChurnGranularity(opt.value)}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all ${
                  churnGranularity === opt.value ? 'bg-purple-600/40 text-white' : 'text-stone-500 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {churnStats.legacyChurned > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-950/20 border border-amber-900/30">
          <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[10px] text-stone-400">
            {churnStats.legacyChurned} closed client{churnStats.legacyChurned === 1 ? '' : 's'} predate closure-date tracking
            (churned_at unknown) and are excluded from the period figure above — not counted as closed in any period,
            not counted as active either.
          </p>
        </div>
      )}

      <DepartmentComparisonPanel
        clients={clients}
        campaigns={campaigns}
        tasks={tasks}
        socialInsights={socialInsights}
        users={users}
      />
    </div>
  );
};
