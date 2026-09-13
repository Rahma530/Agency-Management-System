import React from 'react';
import { TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';
import { ClientComparisonRecord, ClientRecord, ReportRecord, UserRecord } from '../../types/database';
import { generateComparisonNarrative, AnomalyFlag } from '../../lib/reportingEngine';

// ----------------------------------------------------------------------------
// Shared presentation pieces for a generated ClientComparisonRecord and the ReportRecords filed
// against them — used by both ClientDashboard's per-client "Reports & Comparisons" tab and the
// role-agnostic ReportsHub, so the two surfaces render identically instead of drifting apart.
// ----------------------------------------------------------------------------

const SERVICE_METRIC_LABELS: Record<string, Record<string, string>> = {
  media_buying: { spend: 'Spend', roas: 'ROAS', conversions: 'Conversions', cpa: 'CPA' },
  social_media: { reach: 'Reach', engagement_rate: 'Engagement Rate', follower_growth: 'Follower Growth' },
  seo: { completed_tasks: 'Completed Tasks', on_time_rate: 'On-Time Rate' },
};

const SERVICE_METRIC_UNITS: Record<string, Record<string, string>> = {
  media_buying: { spend: ' SAR', roas: 'x', conversions: '', cpa: ' SAR' },
  social_media: { reach: '', engagement_rate: '%', follower_growth: '' },
  seo: { completed_tasks: '', on_time_rate: '%' },
};

export const formatMetricValue = (value: number | null | undefined, unit: string): string => {
  if (value === null || value === undefined) return 'N/A';
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return `${rounded.toLocaleString()}${unit}`;
};

export const DeltaBadge: React.FC<{ value: number | null | undefined }> = ({ value }) => {
  if (value === null || value === undefined) {
    return <span className="text-[10px] text-stone-500 font-mono">—</span>;
  }
  const isUp = value > 0;
  const isFlat = value === 0;
  return (
    <span
      className="text-[10px] font-mono font-bold flex items-center gap-0.5"
      style={{ color: isFlat ? 'var(--lilac)' : isUp ? 'var(--roas-good)' : 'var(--roas-bad)' }}
    >
      {!isFlat && (isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />)}
      {isUp ? '+' : ''}
      {value}%
    </span>
  );
};

export const ServiceMetricsCard: React.FC<{
  serviceKey: 'media_buying' | 'social_media' | 'seo';
  title: string;
  current?: Record<string, any>;
  previous?: Record<string, any>;
  delta?: Partial<Record<string, number | null>>;
  // Period-summary rows have no previous/delta to show — just the current period's totals.
  flat?: boolean;
}> = ({ serviceKey, title, current, previous, delta, flat }) => {
  if (!current && !previous) return null;
  const labels = SERVICE_METRIC_LABELS[serviceKey];
  const units = SERVICE_METRIC_UNITS[serviceKey];
  return (
    <div className="p-3 rounded-lg border border-purple-900/20 bg-purple-950/10 space-y-2">
      <h5 className="text-xs font-bold text-white uppercase tracking-wide">{title}</h5>
      <div className="grid grid-cols-1 gap-1.5">
        {Object.keys(labels).map((key) => (
          <div key={key} className="flex items-center justify-between text-[11px]">
            <span className="text-stone-400">{labels[key]}</span>
            {flat ? (
              <span className="text-stone-300 font-mono">{formatMetricValue(current?.[key], units[key])}</span>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-stone-300 font-mono">
                  {formatMetricValue(previous?.[key], units[key])} → {formatMetricValue(current?.[key], units[key])}
                </span>
                <DeltaBadge value={delta?.[key]} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// A single generated comparison or period summary: period label, the three service metric
// cards (whichever are present), and — for a 'comparison' row only — the rule-generated
// narrative. Dispatches on row_kind directly rather than inferring the shape from
// period_previous, so a row's displayed shape can never disagree with how it was generated.
// Staff-only: pass anomalyFlags from ClientDashboard.tsx/ReportsHub.tsx, never from
// ClientPortalView.tsx — this is an internal early-warning signal (rolling-baseline drops), not
// something to alarm the client with alongside their own comparison narrative.
export const ComparisonCard: React.FC<{
  comparison: ClientComparisonRecord;
  subtitle?: string;
  canGenerateReport?: boolean;
  isGeneratingReport?: boolean;
  onGenerateReport?: () => void;
  anomalyFlags?: AnomalyFlag[];
}> = ({ comparison, subtitle, canGenerateReport, isGeneratingReport, onGenerateReport, anomalyFlags }) => {
  const isSummary = comparison.row_kind === 'period_summary';
  const narrative = isSummary
    ? null
    : generateComparisonNarrative(comparison.metrics_current, comparison.metrics_previous, comparison.delta);

  return (
    <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <span className="text-xs font-bold text-white font-mono">
            {isSummary ? comparison.period_current : `${comparison.period_current} vs ${comparison.period_previous}`}
          </span>
          {isSummary && (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded font-semibold text-purple-200 bg-purple-900/50 uppercase align-middle">
              Period Report
            </span>
          )}
          {subtitle && <span className="text-[11px] text-stone-400 block">{subtitle}</span>}
        </div>
        {canGenerateReport && onGenerateReport && (
          <button
            onClick={onGenerateReport}
            disabled={isGeneratingReport}
            className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all disabled:opacity-50"
          >
            {isGeneratingReport ? 'Filing...' : 'Generate Report'}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ServiceMetricsCard
          serviceKey="media_buying"
          title="Media Buying"
          current={comparison.metrics_current.media_buying}
          previous={comparison.metrics_previous.media_buying}
          delta={comparison.delta.media_buying}
          flat={isSummary}
        />
        <ServiceMetricsCard
          serviceKey="social_media"
          title="Social Media"
          current={comparison.metrics_current.social_media}
          previous={comparison.metrics_previous.social_media}
          delta={comparison.delta.social_media}
          flat={isSummary}
        />
        <ServiceMetricsCard
          serviceKey="seo"
          title="SEO (Delivery)"
          current={comparison.metrics_current.seo}
          previous={comparison.metrics_previous.seo}
          delta={comparison.delta.seo}
          flat={isSummary}
        />
      </div>

      {anomalyFlags && anomalyFlags.length > 0 && (
        <div className="p-3 rounded-lg bg-red-950/20 border border-red-800/40 space-y-1.5">
          <p className="text-xs font-bold text-red-300 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>Anomaly detected — below this client's own rolling baseline</span>
          </p>
          {anomalyFlags.map((flag, i) => (
            <p key={i} className="text-[11px] text-stone-300 leading-relaxed pl-5">
              <strong className="text-red-300">
                {flag.service.replace('_', ' ')} — {flag.metricLabel}:
              </strong>{' '}
              {flag.currentValue.toLocaleString()} is {flag.pctBelowBaseline}% below the baseline of{' '}
              {flag.baselineValue.toLocaleString()}
              {flag.confidence === 'low' ? ' (baseline from only 1 prior period — low confidence)' : ''}.
            </p>
          ))}
        </div>
      )}

      {narrative && (
        <div className="p-3 rounded-lg bg-purple-950/20 border border-purple-900/20 space-y-1.5">
          <p className="text-xs text-stone-200 leading-relaxed">
            <strong className="text-purple-300">Summary: </strong>
            {narrative.summary}
          </p>
          <p className="text-xs text-stone-200 leading-relaxed">
            <strong className="text-purple-300">Recommendation: </strong>
            {comparison.ai_recommendations_text || narrative.recommendations}
          </p>
        </div>
      )}
    </div>
  );
};

// Resolves a short, human label for a comparison's scope — a client name for the single-client
// case, or "Agent: <name> (N clients)" for a pooled aggregate — used as ComparisonCard's subtitle
// and in the filed-reports list below when the surface covers more than one client (ReportsHub).
export const describeComparisonScope = (
  comparison: Pick<ClientComparisonRecord, 'client_id' | 'agent_id' | 'covered_client_ids'>,
  clients: ClientRecord[],
  users: UserRecord[]
): string => {
  if (comparison.client_id) {
    return clients.find((c) => c.id === comparison.client_id)?.name || 'Unknown client';
  }
  if (comparison.agent_id) {
    const agent = users.find((u) => u.id === comparison.agent_id);
    const count = comparison.covered_client_ids?.length ?? 0;
    return `Agent: ${agent?.name || 'Unknown'} (${count} client${count === 1 ? '' : 's'})`;
  }
  return '';
};

// Filed reports list, resolving each report's scope label via its linked comparison.
export const FiledReportsList: React.FC<{
  reports: ReportRecord[];
  comparisons: ClientComparisonRecord[];
  clients: ClientRecord[];
  users: UserRecord[];
  showScope?: boolean;
  // When provided, a report row becomes clickable (used to open MonthlyReportDraftView.tsx for a
  // monthly draft) — omitted, rows stay static exactly as before.
  onSelectReport?: (report: ReportRecord) => void;
}> = ({ reports, comparisons, clients, users, showScope, onSelectReport }) => {
  if (reports.length === 0) {
    return <p className="text-xs text-stone-500 py-4 text-center">No reports filed yet.</p>;
  }
  return (
    <div className="space-y-2">
      {reports.map((r) => {
        const author = users.find((u) => u.id === r.generated_by);
        const comparison = comparisons.find((c) => c.id === r.comparison_id);
        const scopeLabel = showScope && comparison ? describeComparisonScope(comparison, clients, users) : null;
        const clickable = !!onSelectReport;
        return (
          <div
            key={r.id}
            onClick={clickable ? () => onSelectReport!(r) : undefined}
            className={`p-3 rounded-xl border border-purple-900/30 bg-[#161224]/80 flex items-center justify-between gap-3 ${
              clickable ? 'cursor-pointer hover:border-purple-500/50 transition-colors' : ''
            }`}
          >
            <div>
              <p className="text-xs font-bold text-white font-mono">{r.period}</p>
              <p className="text-[11px] text-stone-400">
                {scopeLabel ? `${scopeLabel} • ` : ''}
                Filed by {author?.name || 'Unknown'}
                {r.created_at ? ` • ${new Date(r.created_at).toLocaleDateString()}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {r.status === 'draft' && (
                <span className="text-[10px] px-2 py-0.5 rounded font-semibold text-amber-200 bg-amber-900/50 uppercase">
                  Draft
                </span>
              )}
              <span className="text-[10px] px-2 py-0.5 rounded font-semibold text-purple-200 bg-purple-900/50 uppercase">
                {r.type}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
