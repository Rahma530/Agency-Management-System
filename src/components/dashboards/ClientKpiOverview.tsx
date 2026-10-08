import React, { useMemo, useState } from 'react';
import { Building2, DollarSign, TrendingDown, Users } from 'lucide-react';
import { ClientRecord } from '../../types/database';
import { isCurrentlyActiveClient } from '../../lib/clientStatus';
import { ComparisonGranularity, resolveComparisonPeriods } from '../../lib/reportingEngine';

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
    <p className="text-2xl font-bold" style={{ color: accent || 'var(--text-hi)' }}>
      {value}
    </p>
    {caption && <p className="text-[10px] text-stone-500 mt-1">{caption}</p>}
  </div>
);

export const ClientKpiOverview: React.FC<{ clients: ClientRecord[] }> = ({ clients }) => {
  const [churnGranularity, setChurnGranularity] = useState<ComparisonGranularity>('monthly');

  // Revenue and client counts are current-snapshot figures, not period-comparable — there's no
  // invoice/payment history in this schema, only each client's present contract_value/status.
  const statusCounts = useMemo(() => {
    const counts: Record<ClientRecord['status'], number> = { onboarding: 0, active: 0, paused: 0, renewal: 0, closed: 0 };
    clients.forEach((client) => {
      counts[client.status] = (counts[client.status] || 0) + 1;
    });
    return counts;
  }, [clients]);

  // Decision (Module 13): paused clients still count toward MRR — they're intentionally halted,
  // not de-billed — so this stays broader than isCurrentlyActiveClient (which excludes paused).
  const mrr = useMemo(
    () =>
      clients
        .filter((client) => client.status === 'active' || client.status === 'renewal' || client.status === 'paused')
        .reduce((sum, client) => sum + (client.contract_value || 0), 0),
    [clients]
  );

  // Preserve the Executive dashboard's existing churn semantics: current snapshot status,
  // churned_at in the selected period, and created_at as the period-start denominator proxy.
  const churnStats = useMemo(() => {
    const period = resolveComparisonPeriods(churnGranularity).current;
    const existedAtStart = clients.filter((client) => (client.created_at || '') < period.range.start);
    const churnedInPeriod = clients.filter(
      (client) =>
        client.status === 'closed' &&
        client.churned_at &&
        client.churned_at >= period.range.start &&
        client.churned_at <= period.range.end
    );
    const legacyChurned = clients.filter((client) => client.status === 'closed' && !client.churned_at);
    const rate = existedAtStart.length > 0
      ? Math.round((churnedInPeriod.length / existedAtStart.length) * 1000) / 10
      : null;
    return {
      periodLabel: period.label,
      rate,
      churnedInPeriod: churnedInPeriod.length,
      base: existedAtStart.length,
      legacyChurned: legacyChurned.length,
    };
  }, [clients, churnGranularity]);

  return (
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
          {CHURN_GRANULARITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setChurnGranularity(option.value)}
              className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all ${
                churnGranularity === option.value ? 'bg-purple-600/40 text-white' : 'text-stone-500 hover:text-white'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
