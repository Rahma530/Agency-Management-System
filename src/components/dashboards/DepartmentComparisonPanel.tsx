import React, { useMemo, useState } from 'react';
import { BarChart3, Gauge, Clock } from 'lucide-react';
import {
  ClientRecord,
  CampaignRecord,
  TaskRecord,
  SocialInsightRecord,
  UserRecord,
  ServiceType,
} from '../../types/database';
import {
  ComparisonGranularity,
  resolveComparisonPeriods,
  resolveDepartmentClients,
  aggregateMediaBuyingMetrics,
  aggregateSeoMetrics,
  aggregateSocialMetrics,
} from '../../lib/reportingEngine';
import { computeOnTimeCompletionRate, PeriodRange } from '../../lib/performanceScore';
import { getUserCapacityData } from '../../lib/capacity';
import { isActiveEmployee } from '../../lib/permissions';

const GRANULARITY_OPTIONS: { value: ComparisonGranularity; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

const DEPARTMENTS: { service: ServiceType; team: string; label: string; accent: string }[] = [
  { service: 'media_buying', team: 'Media Buying', label: 'Media Buying', accent: '#38bdf8' },
  { service: 'seo', team: 'SEO', label: 'SEO', accent: '#34d399' },
  { service: 'social_media', team: 'Social Media', label: 'Social Media', accent: '#f472b6' },
];

const avg = (values: number[]): number | null =>
  values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;

// Every metric a single department's client-facing service produces (spend/ROAS, delivery rate,
// engagement) uses a different unit, so none of them are directly comparable to another
// department's — that's what the "headline" card is for (context, not comparison). The actual
// cross-department comparison uses two metrics normalized to 0-100 that mean the same thing
// regardless of department: on-time task completion and capacity utilization, both already
// computed per-employee elsewhere in the app (performanceScore.ts / capacity.ts) and just
// averaged here across each department's own employees.
interface DepartmentRow {
  service: ServiceType;
  label: string;
  accent: string;
  clientCount: number;
  headline: { label: string; value: string }[];
  avgOnTimeRate: number | null;
  avgCapacityUtilization: number | null;
}

export const DepartmentComparisonPanel: React.FC<{
  clients: ClientRecord[];
  campaigns: CampaignRecord[];
  tasks: TaskRecord[];
  socialInsights: SocialInsightRecord[];
  users: UserRecord[];
  services?: ServiceType[]; // omit to show all 3 technical departments
}> = ({ clients, campaigns, tasks, socialInsights, users, services }) => {
  const [granularity, setGranularity] = useState<ComparisonGranularity>('monthly');
  const period = useMemo(() => resolveComparisonPeriods(granularity).current, [granularity]);

  const departments = services ? DEPARTMENTS.filter((d) => services.includes(d.service)) : DEPARTMENTS;

  const rows: DepartmentRow[] = useMemo(() => {
    const periodRange: PeriodRange = {
      period: period.label,
      periodType: granularity === 'quarterly' ? 'quarterly' : 'monthly',
      start: period.range.start,
      end: period.range.end,
    };

    return departments.map(({ service, team, label, accent }) => {
      const deptClients = resolveDepartmentClients(service, clients);
      const clientIds = deptClients.map((c) => c.id);

      let headline: { label: string; value: string }[];
      if (service === 'media_buying') {
        const m = aggregateMediaBuyingMetrics(campaigns, clientIds, period.range);
        headline = [
          { label: 'ROAS', value: m.roas !== null ? `${m.roas}x` : 'N/A' },
          { label: 'Spend', value: `${m.spend.toLocaleString()} SAR` },
          { label: 'Conversions', value: `${m.conversions}` },
        ];
      } else if (service === 'seo') {
        const m = aggregateSeoMetrics(tasks, clientIds, period.range);
        headline = [
          { label: 'Completed Tasks', value: `${m.completed_tasks}` },
          { label: 'On-Time Rate (delivery)', value: m.on_time_rate !== null ? `${m.on_time_rate}%` : 'N/A' },
        ];
      } else {
        const m = aggregateSocialMetrics(socialInsights, clientIds, period.range);
        headline = [
          { label: 'Engagement Rate', value: m.engagement_rate !== null ? `${Math.round(m.engagement_rate * 100) / 100}%` : 'N/A' },
          { label: 'Reach', value: m.reach !== null ? `${Math.round(m.reach).toLocaleString()}` : 'N/A' },
        ];
      }

      const deptUsers = users.filter((u) => u.team === team && isActiveEmployee(u));
      const onTimeRates = deptUsers
        .map((u) => computeOnTimeCompletionRate(tasks, u.id, periodRange))
        .filter((v): v is number => v !== null);
      const capacityRates = deptUsers
        .map((u) => getUserCapacityData(u, clients, tasks))
        .filter((d) => !d.isUntracked)
        .map((d) => d.utilizationRate);

      return {
        service,
        label,
        accent,
        clientCount: deptClients.length,
        headline,
        avgOnTimeRate: avg(onTimeRates),
        avgCapacityUtilization: avg(capacityRates),
      };
    });
  }, [departments, clients, campaigns, tasks, socialInsights, users, period, granularity]);

  return (
    <div className="p-4 rounded-2xl border space-y-4" style={{ background: 'var(--gradient-card)', borderColor: 'var(--border-soft)' }}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-purple-400" />
          <h3 className="text-sm font-bold text-white">Department Performance Comparison</h3>
        </div>
        <div className="flex items-center gap-1 p-1 rounded-lg bg-stone-900 border border-stone-800">
          {GRANULARITY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setGranularity(opt.value)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all ${
                granularity === opt.value ? 'bg-purple-600/40 text-white' : 'text-stone-400 hover:text-white'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[10px] text-stone-500 -mt-2">
        {period.label} — headline metrics are department-specific (different units, not directly
        comparable); on-time rate and capacity utilization are normalized 0-100 and are the actual
        cross-department comparison.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {rows.map((row) => (
          <div key={row.service} className="p-3.5 rounded-xl border border-stone-800 bg-stone-900/60 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-wide" style={{ color: row.accent }}>
                {row.label}
              </h4>
              <span className="text-[10px] text-stone-400 font-mono">{row.clientCount} clients</span>
            </div>

            <div className="space-y-1">
              {row.headline.map((h) => (
                <div key={h.label} className="flex items-center justify-between text-[11px]">
                  <span className="text-stone-400">{h.label}</span>
                  <span className="font-mono font-bold text-stone-200">{h.value}</span>
                </div>
              ))}
            </div>

            <div className="pt-2 border-t border-stone-800 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-stone-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> On-Time Rate
                </span>
                <span className="font-mono font-bold text-white">
                  {row.avgOnTimeRate !== null ? `${row.avgOnTimeRate}%` : 'N/A'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-stone-400 flex items-center gap-1">
                  <Gauge className="w-3 h-3" /> Capacity Utilization
                </span>
                <span className="font-mono font-bold text-white">
                  {row.avgCapacityUtilization !== null ? `${row.avgCapacityUtilization}%` : 'N/A'}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
