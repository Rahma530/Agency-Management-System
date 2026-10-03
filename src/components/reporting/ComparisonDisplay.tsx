import React, { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, AlertTriangle, Sparkles, Download } from 'lucide-react';
import { ClientComparisonRecord, ClientRecord, ReportRecord, ServiceType, UserRecord } from '../../types/database';
import { generateComparisonNarrative, AnomalyFlag } from '../../lib/reportingEngine';
import { downloadReportPdf, buildUnifiedReportMetricsTable, PdfParagraph, PdfBulletList } from '../../lib/pdfExport';

// ----------------------------------------------------------------------------
// Shared presentation pieces for a generated ClientComparisonRecord and the ReportRecords filed
// against them — used by both ClientDashboard's per-client "Reports & Comparisons" tab and the
// role-agnostic ReportsHub, so the two surfaces render identically instead of drifting apart.
// ----------------------------------------------------------------------------

const SERVICE_METRIC_LABELS: Record<string, Record<string, string>> = {
  media_buying: { spend: 'Spend', roas: 'ROAS', conversions: 'Conversions', cpa: 'CPA' },
  social_media: { reach: 'Reach', engagement_rate: 'Engagement Rate', follower_growth: 'Follower Growth' },
  // completed_tasks/on_time_rate are the pre-existing delivery proxy; organic_traffic/
  // keywords_top10_count/backlinks_acquired are additive, from seo_insights' weekly manual entry
  // (see 20261028000000_seo_insights.sql and reportingEngine.ts's aggregateSeoMetrics) — a real
  // performance signal alongside the delivery one, not a replacement for it.
  seo: {
    completed_tasks: 'Completed Tasks',
    on_time_rate: 'On-Time Rate',
    organic_traffic: 'Organic Traffic',
    keywords_top10_count: 'Keywords in Top 10',
    backlinks_acquired: 'Backlinks Acquired',
  },
};

const SERVICE_METRIC_UNITS: Record<string, Record<string, string>> = {
  media_buying: { spend: ' SAR', roas: 'x', conversions: '', cpa: ' SAR' },
  social_media: { reach: '', engagement_rate: '%', follower_growth: '' },
  seo: {
    completed_tasks: '',
    on_time_rate: '%',
    organic_traffic: '',
    keywords_top10_count: '',
    backlinks_acquired: '',
  },
};

export const formatMetricValue = (value: number | null | undefined, unit: string): string => {
  if (value === null || value === undefined) return 'N/A';
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return `${rounded.toLocaleString()}${unit}`;
};

// ----------------------------------------------------------------------------
// Phase 4 (AI Orchestrator): CAMPAIGN_SUMMARY payload builder. Converts an already-computed
// ClientComparisonRecord into the exact shape supabase/functions/ai-router/taskRegistry.ts's
// CAMPAIGN_SUMMARY input allowlist expects. Kept here rather than in reportingEngine.ts since it
// only runs when the optional "Generate AI Summary" button below is pressed — this intentionally
// duplicates the allowlist's own service/metric vocabulary rather than importing it, since
// taskRegistry.ts is Deno Edge Function code, not reachable from this Vite/browser bundle. This is
// the same "duplicated on purpose, kept in sync by convention" relationship taskRegistry.ts's own
// header comment already documents in the other direction (it mirrors SERVICE_METRIC_LABELS/UNITS
// defined just above in this file).
// ----------------------------------------------------------------------------
export interface CampaignSummaryMetricPoint {
  service: 'media_buying' | 'social_media' | 'seo';
  metric: string;
  current_value: number | null;
  previous_value: number | null;
  unit: string;
}

export interface CampaignSummaryPayload {
  period_current: string;
  period_previous: string | null;
  metrics: CampaignSummaryMetricPoint[];
}

export interface CampaignSummaryDetailedResult {
  summary: string;
  by_service: { service: string; text: string }[];
  recommendations: string[];
}

// Combined-scope item D: matches ai-router's UNIFIED_CLIENT_REPORT task output shape
// (taskRegistry.ts's UnifiedClientReportOutput) — a single narrative, not per-service paragraphs.
export interface UnifiedClientReportResult {
  narrative: string;
  recommendations: string[];
}

// Matches ai-router's own widened PERIOD_LABEL_RE (taskRegistry.ts) — monthly ("2026-03"),
// quarterly ("2026-Q1"), yearly ("2026"), and custom range ("2026-01-01_2026-03-31"). Kept as its
// own client-side copy (not imported — taskRegistry.ts is Deno Edge Function code) so the button
// can be pre-emptively hidden for a label ai-router would reject, same duplication relationship as
// the rest of this payload builder.
const CAMPAIGN_SUMMARY_PERIOD_LABEL_RE = /^(?:\d{4}-\d{2}|\d{4}-Q[1-4]|\d{4}|\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2})$/;

// SERVICE_METRIC_UNITS above carries a leading space for display concatenation (e.g. " SAR", so
// formatMetricValue can produce "1,200 SAR") — ai-router's CAMPAIGN_SUMMARY_UNITS allowlist
// requires the bare string ('', 'SAR', '%', 'x') with no leading space, so this trims rather than
// reusing that table's values verbatim.
function toAllowlistUnit(displayUnit: string): string {
  return displayUnit.trim();
}

// Whose period_current matches one of ai-router's four accepted label shapes, with at least one
// service's metrics present. serviceFilter (combined-scope item C): a department agent/team lead
// viewer only ever gets a payload built from their own service(s) — undefined means "every service
// present," same as before this was added.
//
// Deliberately allows a 'period_summary' row too (previously excluded here, not by ai-router
// itself): metrics_previous is always empty for one, so buildCampaignSummaryPayload below sends
// previous_value: null for every metric — a shape ai-router's own buildAnalyzeInput() already
// tolerates gracefully (confirmed by audit), so no taskRegistry.ts change was needed to allow this.
// The AI summary's prose is still comparison-flavored (CAMPAIGN_SUMMARY's prompt wasn't rewritten
// for a no-previous-period tone as part of this change), so expect it to read a little oddly around
// "no change" deltas on a period_summary row until/unless that prompt is revisited separately.
export function canBuildCampaignSummaryPayload(comparison: ClientComparisonRecord, serviceFilter?: ServiceType[]): boolean {
  if (!CAMPAIGN_SUMMARY_PERIOD_LABEL_RE.test(comparison.period_current)) return false;
  return (['media_buying', 'social_media', 'seo'] as const)
    .filter((service) => !serviceFilter || serviceFilter.includes(service))
    .some((service) => comparison.metrics_current[service] || comparison.metrics_previous[service]);
}

// Narrows a metrics/delta object down to only the given services — used both for the AI-summary
// payload and for the rule-based narrative box, so a department agent/team lead never sees (and
// ai-router is never sent) another department's numbers, even when the underlying row itself
// spans every service the client subscribes to. undefined filter returns the object unchanged.
function filterMetricsByViewer<T extends object>(metrics: T, serviceFilter: ServiceType[] | undefined): T {
  if (!serviceFilter) return metrics;
  const result: any = {};
  const metricsAny: any = metrics;
  for (const service of serviceFilter) {
    if (service in metricsAny) result[service] = metricsAny[service];
  }
  return result as T;
}

// Builds the CAMPAIGN_SUMMARY payload from a comparison's already-computed metrics_current/
// metrics_previous — a pure, deterministic transform, no fetch. Sends only the raw current_value/
// previous_value pair per metric; delta_pct is intentionally NOT computed here — ai-router's own
// buildAnalyzeInput() (taskRegistry.ts) computes it server-side from these same two numbers, per
// this project's standing rule that percentage math is never trusted to a model or duplicated
// client-side. buildAnalyzeInput() now divides by Math.abs(previous_value), matching this app's
// own reportingEngine.ts's pctDelta() exactly — previously it didn't, which could invert
// follower_growth's sign vs. the DeltaBadge already on screen (fixed alongside this phase).
export function buildCampaignSummaryPayload(
  comparison: ClientComparisonRecord,
  serviceFilter?: ServiceType[]
): CampaignSummaryPayload {
  const metrics: CampaignSummaryMetricPoint[] = [];

  (['media_buying', 'social_media', 'seo'] as const)
    .filter((service) => !serviceFilter || serviceFilter.includes(service))
    .forEach((service) => {
      const current = comparison.metrics_current[service];
      const previous = comparison.metrics_previous[service];
      if (!current && !previous) return;
      const labels = SERVICE_METRIC_LABELS[service];
      const units = SERVICE_METRIC_UNITS[service];
      Object.keys(labels).forEach((metric) => {
        const currentValue = (current as unknown as Record<string, unknown> | undefined)?.[metric];
        const previousValue = (previous as unknown as Record<string, unknown> | undefined)?.[metric];
        metrics.push({
          service,
          metric,
          current_value: typeof currentValue === 'number' ? currentValue : null,
          previous_value: typeof previousValue === 'number' ? previousValue : null,
          unit: toAllowlistUnit(units[metric] ?? ''),
        });
      });
    });

  return {
    period_current: comparison.period_current,
    period_previous: comparison.period_previous ?? null,
    metrics,
  };
}

const SERVICE_TITLES: Record<'media_buying' | 'social_media' | 'seo', string> = {
  media_buying: 'Media Buying',
  social_media: 'Social Media',
  seo: 'SEO (Delivery)',
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
  // Phase 4 (AI Orchestrator): optional, additive-only enhancement to the rule-based narrative
  // below — never replaces it, never shown on its own. Omitted (same convention as
  // canGenerateReport/onGenerateReport above) wherever the AI button shouldn't appear at all;
  // ClientPortalView.tsx never passes this, so clients never see it. The function itself never
  // throws — it resolves to null and shows its own toast internally on any failure (see
  // App.tsx's handleGenerateCampaignSummary) — so this component never needs its own error state.
  onGenerateAiSummary?: (payload: CampaignSummaryPayload) => Promise<CampaignSummaryDetailedResult | null>;
  // Combined-scope item C: undefined = viewer sees every service (AM/leadership, or no filter
  // passed at all — e.g. ClientPortalView.tsx). An array = a department agent/team lead, narrowed
  // to only their own service(s) — applies to the ServiceMetricsCard grid below, the rule-based
  // narrative text, and the AI-summary payload alike, so no surface on this card can leak another
  // department's numbers to a scoped viewer.
  viewerServiceFilter?: ServiceType[];
}> = ({ comparison, subtitle, canGenerateReport, isGeneratingReport, onGenerateReport, anomalyFlags, onGenerateAiSummary, viewerServiceFilter }) => {
  const isSummary = comparison.row_kind === 'period_summary';
  // Narrowed to the viewer's own service(s) before computing the narrative — otherwise a scoped
  // viewer would still read rule-based findings about a department that isn't theirs, even though
  // the ServiceMetricsCard grid below correctly hides that department's numbers.
  const visibleMetricsCurrent = filterMetricsByViewer(comparison.metrics_current, viewerServiceFilter);
  const visibleMetricsPrevious = filterMetricsByViewer(comparison.metrics_previous, viewerServiceFilter);
  const visibleDelta = filterMetricsByViewer(comparison.delta, viewerServiceFilter);
  const narrative = isSummary ? null : generateComparisonNarrative(visibleMetricsCurrent, visibleMetricsPrevious, visibleDelta);

  const [isGeneratingAiSummary, setIsGeneratingAiSummary] = useState(false);
  const [aiSummaryResult, setAiSummaryResult] = useState<CampaignSummaryDetailedResult | null>(null);
  // Distinct from a null result: onGenerateAiSummary (App.tsx's handleGenerateCampaignSummary)
  // never throws — it resolves to null and only surfaces a transient toast on failure (see that
  // prop's own doc comment below) — so without this, a real ai-router failure looked identical
  // to the button simply never having been pressed, with no persistent in-component signal a
  // user could still see after the toast disappeared.
  const [aiSummaryFailed, setAiSummaryFailed] = useState(false);

  // Ephemeral by design (no persistence, no new column): reset whenever this card starts
  // representing a different comparison row, so a stale result never carries over if the parent
  // list re-renders with the same component instance pointed at a different row.
  useEffect(() => {
    setAiSummaryResult(null);
    setIsGeneratingAiSummary(false);
    setAiSummaryFailed(false);
  }, [comparison.id]);

  const canShowAiButton = !!onGenerateAiSummary && canBuildCampaignSummaryPayload(comparison, viewerServiceFilter);

  const handleGenerateAiSummary = async () => {
    if (!onGenerateAiSummary) return;
    setIsGeneratingAiSummary(true);
    setAiSummaryFailed(false);
    const result = await onGenerateAiSummary(buildCampaignSummaryPayload(comparison, viewerServiceFilter));
    setIsGeneratingAiSummary(false);
    if (result) {
      setAiSummaryResult(result);
    } else {
      setAiSummaryFailed(true);
    }
  };

  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // Combined-scope item E: builds the PDF from the same already-filtered view-model this card
  // already renders — narrative/visibleMetrics-derived text and aiSummaryResult (itself already
  // generated from a viewerServiceFilter-scoped payload, see handleGenerateAiSummary above) —
  // never from comparison's raw, unfiltered fields directly. This is deliberate: a PDF export is a
  // new place the same cross-department leak Stage C closed could reappear if it read from
  // unfiltered data instead of what's already on screen.
  const handleDownloadPdf = async () => {
    if (!narrative) return;
    setIsDownloadingPdf(true);
    setPdfError(null);
    try {
      const paragraphs: PdfParagraph[] = [
        { heading: 'Summary', body: narrative.summary },
        {
          heading: 'Recommendation',
          body: viewerServiceFilter ? narrative.recommendations : comparison.ai_recommendations_text || narrative.recommendations,
        },
      ];
      const bulletLists: PdfBulletList[] = [];
      if (aiSummaryResult) {
        paragraphs.push({ heading: 'AI Summary', body: aiSummaryResult.summary });
        aiSummaryResult.by_service.forEach((entry) => {
          const title = SERVICE_TITLES[entry.service as keyof typeof SERVICE_TITLES] || entry.service;
          paragraphs.push({ heading: `AI Summary — ${title}`, body: entry.text });
        });
        if (aiSummaryResult.recommendations.length > 0) {
          bulletLists.push({ heading: 'AI Recommendations', items: aiSummaryResult.recommendations });
        }
      }
      await downloadReportPdf({
        filename: `campaign-summary-${comparison.period_current}.pdf`,
        title: 'Campaign Summary Report',
        subtitle: `${subtitle ? `${subtitle} — ` : ''}${comparison.period_current} vs ${comparison.period_previous}`,
        paragraphs,
        bulletLists,
      });
    } catch (err) {
      console.error('PDF export failed:', err);
      setPdfError('Could not generate the PDF — try again.');
    } finally {
      setIsDownloadingPdf(false);
    }
  };

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
            className="purple-outline-action px-2.5 py-1 rounded-lg text-[11px] font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all disabled:opacity-50"
          >
            {isGeneratingReport ? 'Filing...' : 'Generate Report'}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(!viewerServiceFilter || viewerServiceFilter.includes('media_buying')) && (
          <ServiceMetricsCard
            serviceKey="media_buying"
            title="Media Buying"
            current={comparison.metrics_current.media_buying}
            previous={comparison.metrics_previous.media_buying}
            delta={comparison.delta.media_buying}
            flat={isSummary}
          />
        )}
        {(!viewerServiceFilter || viewerServiceFilter.includes('social_media')) && (
          <ServiceMetricsCard
            serviceKey="social_media"
            title="Social Media"
            current={comparison.metrics_current.social_media}
            previous={comparison.metrics_previous.social_media}
            delta={comparison.delta.social_media}
            flat={isSummary}
          />
        )}
        {(!viewerServiceFilter || viewerServiceFilter.includes('seo')) && (
          <ServiceMetricsCard
            serviceKey="seo"
            title="SEO (Delivery)"
            current={comparison.metrics_current.seo}
            previous={comparison.metrics_previous.seo}
            delta={comparison.delta.seo}
            flat={isSummary}
          />
        )}
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
            {/* comparison.ai_recommendations_text is a persisted plain string that can have been
                written from this row's FULL, unfiltered metrics (e.g. by the AM) — it can't be
                narrowed after the fact the way a structured object can, so a scoped viewer always
                gets the freshly-computed narrative.recommendations (derived from
                visibleMetricsCurrent/Previous/Delta above) instead of that persisted text, never
                the other way around. Unrestricted viewers keep today's exact behavior. */}
            {viewerServiceFilter ? narrative.recommendations : comparison.ai_recommendations_text || narrative.recommendations}
          </p>

          <div className="pt-1.5 border-t border-purple-900/20 flex items-center gap-2 flex-wrap">
            <button
              onClick={handleDownloadPdf}
              disabled={isDownloadingPdf}
              className="pdf-download-action px-2.5 py-1 rounded-lg text-[11px] font-bold text-stone-200 bg-stone-800/60 hover:bg-stone-700/60 hover:text-white border border-stone-600/40 transition-all disabled:opacity-50 flex items-center gap-1"
            >
              <Download className="w-3 h-3" />
              {isDownloadingPdf ? 'Preparing PDF...' : 'Download PDF'}
            </button>
            {pdfError && <span className="text-[11px] text-red-300">{pdfError}</span>}
          </div>
        </div>
      )}

      {/* AI summary section — deliberately its own block, independent of the rule-based narrative
          box above (which never renders for a period_summary row): "Generate AI Summary" must be
          offered for period_summary rows too, even though they have no narrative to sit inside. PDF
          export stays narrative-only (unchanged) — this request only asked to fix AI-summary
          gating, not PDF export's. */}
      {(canShowAiButton || aiSummaryResult || aiSummaryFailed) && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            {canShowAiButton && (
              <button
                onClick={handleGenerateAiSummary}
                disabled={isGeneratingAiSummary}
                className="ai-summary-action px-2.5 py-1 rounded-lg text-[11px] font-bold text-indigo-200 bg-indigo-900/40 hover:bg-indigo-800/60 hover:text-white border border-indigo-700/40 transition-all disabled:opacity-50"
              >
                {isGeneratingAiSummary
                  ? 'Generating AI Summary...'
                  : aiSummaryResult
                  ? 'Regenerate AI Summary'
                  : 'Generate AI Summary'}
              </button>
            )}
          </div>

          {aiSummaryFailed && (
            <p className="text-xs text-red-300">Something went wrong generating the AI summary — try again.</p>
          )}

          {/* AI-generated content — Arabic per the request's language:'ar' (matches this task's
              prompt design: metric names like ROAS/CPA stay in English inside Arabic sentences).
              Visually distinct (indigo, not purple) from the deterministic narrative above it, so
              it's never mistaken for the same rule-based text. */}
          {aiSummaryResult && (
            <div className="p-3 rounded-lg bg-indigo-950/20 border border-indigo-900/30 space-y-1.5">
              <p className="text-[10px] font-bold text-indigo-300 uppercase tracking-wide">AI Summary</p>
              <p className="text-xs text-stone-200 leading-relaxed" dir="rtl">
                {aiSummaryResult.summary}
              </p>
              {aiSummaryResult.by_service.map((entry, i) => (
                <p key={i} className="text-xs text-stone-200 leading-relaxed" dir="rtl">
                  <strong className="text-indigo-300">
                    {SERVICE_TITLES[entry.service as keyof typeof SERVICE_TITLES] || entry.service}:{' '}
                  </strong>
                  {entry.text}
                </p>
              ))}
              {aiSummaryResult.recommendations.length > 0 && (
                <ul className="list-disc list-inside space-y-0.5" dir="rtl">
                  {aiSummaryResult.recommendations.map((rec, i) => (
                    <li key={i} className="text-xs text-stone-200 leading-relaxed">
                      {rec}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Combined-scope item D: the unified multi-service report — client-level (not tied to one
// ComparisonCard row), so it lives as its own panel rather than another prop on ComparisonCard.
// Reuses CAMPAIGN_SUMMARY's own buildCampaignSummaryPayload/canBuildCampaignSummaryPayload
// unchanged (no serviceFilter — this is AM-only, and an AM always sees every service), since
// UNIFIED_CLIENT_REPORT's input allowlist is identical to CAMPAIGN_SUMMARY's. No period picker for
// this phase — always built from the client's own most recently generated 'comparison' row,
// passed in by the caller (ClientDashboard.tsx).
// ----------------------------------------------------------------------------
export const UnifiedReportPanel: React.FC<{
  latestComparison: ClientComparisonRecord | null;
  onGenerateUnifiedReport: (payload: CampaignSummaryPayload) => Promise<UnifiedClientReportResult | null>;
  // When there's no comparison yet at all, generating still works in one click: this computes and
  // saves one for the CURRENTLY selected period first (reusing handleGenerateComparison's own
  // logic/write path in App.tsx, always in 'comparison' mode — the unified report has never had a
  // period_summary variant and this doesn't add one), then the result feeds straight into
  // onGenerateUnifiedReport below. Omitted entirely means "this viewer can't generate at all,"
  // same convention as every other optional handler prop in this file.
  onEnsureComparison?: () => Promise<ClientComparisonRecord | null>;
}> = ({ latestComparison, onGenerateUnifiedReport, onEnsureComparison }) => {
  const [stage, setStage] = useState<'idle' | 'computing' | 'generating'>('idle');
  const [result, setResult] = useState<UnifiedClientReportResult | null>(null);
  // Holds whichever comparison the last successful generation actually used — latestComparison
  // itself may still be null (or a stale, older row) for a render or two after an on-demand
  // ensure-then-generate click, since it only updates once the parent's client_comparisons state
  // round-trips back down as a prop. PDF export reads this instead of latestComparison directly.
  const [resolvedComparison, setResolvedComparison] = useState<ClientComparisonRecord | null>(null);

  // Ephemeral, same as ComparisonCard's own AI summary — cleared if the underlying comparison
  // this panel is built from changes (e.g. a fresh comparison was just generated).
  useEffect(() => {
    setResult(null);
    setStage('idle');
    setResolvedComparison(null);
  }, [latestComparison?.id]);

  const canBuild = latestComparison ? canBuildCampaignSummaryPayload(latestComparison) : !!onEnsureComparison;

  const handleGenerate = async () => {
    setStage('computing');
    try {
      const comparison = latestComparison || (onEnsureComparison ? await onEnsureComparison() : null);
      if (!comparison || !canBuildCampaignSummaryPayload(comparison)) return;
      setResolvedComparison(comparison);
      setStage('generating');
      const fresh = await onGenerateUnifiedReport(buildCampaignSummaryPayload(comparison));
      if (fresh) setResult(fresh);
    } finally {
      setStage('idle');
    }
  };

  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const pdfSourceComparison = resolvedComparison || latestComparison;

  // Combined-scope item E: the metrics table is built from pdfSourceComparison directly, unfiltered
  // — correct here specifically because this panel is AM-only (isClientsOwnAmAgent in
  // ClientDashboard.tsx), so there is no viewerServiceFilter concept to respect in the first
  // place; buildUnifiedReportMetricsTable deliberately has no filter parameter, so it can't
  // accidentally be reused from a scoped context without a compile error forcing a second look.
  const handleDownloadPdf = async () => {
    if (!pdfSourceComparison || !result) return;
    setIsDownloadingPdf(true);
    setPdfError(null);
    try {
      await downloadReportPdf({
        filename: `unified-client-report-${pdfSourceComparison.period_current}.pdf`,
        title: 'Unified Client Report',
        subtitle:
          pdfSourceComparison.period_current + (pdfSourceComparison.period_previous ? ` vs ${pdfSourceComparison.period_previous}` : ''),
        paragraphs: [{ heading: 'Narrative', body: result.narrative }],
        bulletLists: result.recommendations.length > 0 ? [{ heading: 'Recommendations', items: result.recommendations }] : [],
        table: buildUnifiedReportMetricsTable(pdfSourceComparison),
      });
    } catch (err) {
      console.error('PDF export failed:', err);
      setPdfError('Could not generate the PDF — try again.');
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  return (
    <div className="p-4 rounded-xl border border-amber-900/30 bg-amber-950/10 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-bold text-amber-300 flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            <span>Unified Client Report</span>
          </h3>
          <p className="text-[11px] text-stone-400">
            {latestComparison
              ? `One combined narrative across every active service, for ${latestComparison.period_current}` +
                (latestComparison.period_previous ? ` vs ${latestComparison.period_previous}` : '') + '.'
              : onEnsureComparison
              ? 'Generates a comparison for the period selected below if none exists yet, then the unified narrative — one click.'
              : 'Generate a comparison below first — the unified report is built from your most recent one.'}
          </p>
        </div>
        {canBuild && (
          <button
            onClick={handleGenerate}
            disabled={stage !== 'idle'}
            className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-amber-200 bg-amber-900/40 hover:bg-amber-800/60 hover:text-white border border-amber-700/40 transition-all disabled:opacity-50"
          >
            {stage === 'computing'
              ? 'Computing metrics...'
              : stage === 'generating'
              ? 'Generating...'
              : result
              ? 'Regenerate Unified Report'
              : 'Generate Unified Report'}
          </button>
        )}
      </div>

      {latestComparison && !canBuild && (
        <p className="text-xs text-stone-500">
          Your most recent comparison isn't eligible yet (no metrics, or a period label ai-router
          doesn't accept) — generate a new comparison below first.
        </p>
      )}

      {result && (
        <div className="p-3 rounded-lg bg-amber-950/20 border border-amber-900/30 space-y-1.5">
          <p className="text-xs text-stone-200 leading-relaxed" dir="rtl">
            {result.narrative}
          </p>
          {result.recommendations.length > 0 && (
            <ul className="list-disc list-inside space-y-0.5" dir="rtl">
              {result.recommendations.map((rec, i) => (
                <li key={i} className="text-xs text-stone-200 leading-relaxed">
                  {rec}
                </li>
              ))}
            </ul>
          )}
          <div className="pt-1.5 border-t border-amber-900/20 flex items-center gap-2 flex-wrap">
            <button
              onClick={handleDownloadPdf}
              disabled={isDownloadingPdf}
              className="pdf-download-action px-2.5 py-1 rounded-lg text-[11px] font-bold text-stone-200 bg-stone-800/60 hover:bg-stone-700/60 hover:text-white border border-stone-600/40 transition-all disabled:opacity-50 flex items-center gap-1"
            >
              <Download className="w-3 h-3" />
              {isDownloadingPdf ? 'Preparing PDF...' : 'Download PDF'}
            </button>
            {pdfError && <span className="text-[11px] text-red-300">{pdfError}</span>}
          </div>
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// UX-flow change: "Generate AI Summary" used to be reachable only from an already-rendered
// ComparisonCard, which meant it was invisible until a client_comparisons row already existed for
// the current period (i.e. until "Generate Comparison"/"Generate Period Report" below had already
// been clicked at least once). This panel offers the same action up front, alongside that button,
// for both comparison and period_summary modes. A single click either reuses an already-computed
// row for the currently selected period (exactly today's ComparisonCard behavior, no recompute) or
// — when none exists yet — computes and saves one first via onEnsureComparison (which reuses
// handleGenerateComparison's own logic/write path in App.tsx unchanged, including its
// service-filtered merge write for department agents), then immediately builds the payload and
// calls ai-router, all as one user-facing action. The result renders inline here rather than inside
// whichever ComparisonCard the newly-created row ends up as (that card's own AI section still works
// independently afterward, e.g. to regenerate).
// ----------------------------------------------------------------------------
export const DirectAiSummaryPanel: React.FC<{
  mode: 'comparison' | 'period_summary';
  onEnsureComparison: () => Promise<ClientComparisonRecord | null>;
  onGenerateAiSummary: (payload: CampaignSummaryPayload) => Promise<CampaignSummaryDetailedResult | null>;
  viewerServiceFilter?: ServiceType[];
}> = ({ mode, onEnsureComparison, onGenerateAiSummary, viewerServiceFilter }) => {
  const [stage, setStage] = useState<'idle' | 'computing' | 'generating'>('idle');
  const [result, setResult] = useState<CampaignSummaryDetailedResult | null>(null);
  const [ineligible, setIneligible] = useState(false);
  // Distinct from ineligible: onGenerateAiSummary never throws — it resolves to null and only
  // surfaces a transient toast on a real ai-router failure (see ComparisonCard's own
  // aiSummaryFailed for the identical reasoning) — without this, that failure looked identical
  // to the button simply never having been pressed once the toast was gone.
  const [failed, setFailed] = useState(false);

  // Cleared on a mode switch (Comparison Report <-> Period Report) — a result generated under one
  // mode has no bearing on the other.
  useEffect(() => {
    setResult(null);
    setIneligible(false);
    setFailed(false);
    setStage('idle');
  }, [mode]);

  const handleClick = async () => {
    setIneligible(false);
    setFailed(false);
    setStage('computing');
    try {
      const row = await onEnsureComparison();
      if (!row) return; // onEnsureComparison's own failure path already surfaced a notification
      if (!canBuildCampaignSummaryPayload(row, viewerServiceFilter)) {
        setIneligible(true);
        return;
      }
      setStage('generating');
      const fresh = await onGenerateAiSummary(buildCampaignSummaryPayload(row, viewerServiceFilter));
      if (fresh) {
        setResult(fresh);
      } else {
        setFailed(true);
      }
    } finally {
      setStage('idle');
    }
  };

  return (
    <div className="p-4 rounded-xl border border-indigo-900/30 bg-indigo-950/10 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-bold text-indigo-300 flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            <span>AI Summary</span>
          </h3>
          <p className="text-[11px] text-stone-400">
            Uses the period selected below — computes it first if it hasn't been generated yet.
          </p>
        </div>
        <button
          onClick={handleClick}
          disabled={stage !== 'idle'}
          className="ai-summary-action px-2.5 py-1 rounded-lg text-[11px] font-bold text-indigo-200 bg-indigo-900/40 hover:bg-indigo-800/60 hover:text-white border border-indigo-700/40 transition-all disabled:opacity-50"
        >
          {stage === 'computing'
            ? 'Computing metrics...'
            : stage === 'generating'
            ? 'Generating AI Summary...'
            : result
            ? 'Regenerate AI Summary'
            : 'Generate AI Summary'}
        </button>
      </div>

      {ineligible && (
        <p className="text-xs text-stone-500">
          That period isn't eligible for an AI summary yet (no metrics, or a period label ai-router
          doesn't accept).
        </p>
      )}

      {failed && <p className="text-xs text-red-300">Something went wrong generating the AI summary — try again.</p>}

      {result && (
        <div className="p-3 rounded-lg bg-indigo-950/20 border border-indigo-900/30 space-y-1.5">
          <p className="text-[10px] font-bold text-indigo-300 uppercase tracking-wide">AI Summary</p>
          <p className="text-xs text-stone-200 leading-relaxed" dir="rtl">
            {result.summary}
          </p>
          {result.by_service.map((entry, i) => (
            <p key={i} className="text-xs text-stone-200 leading-relaxed" dir="rtl">
              <strong className="text-indigo-300">
                {SERVICE_TITLES[entry.service as keyof typeof SERVICE_TITLES] || entry.service}:{' '}
              </strong>
              {entry.text}
            </p>
          ))}
          {result.recommendations.length > 0 && (
            <ul className="list-disc list-inside space-y-0.5" dir="rtl">
              {result.recommendations.map((rec, i) => (
                <li key={i} className="text-xs text-stone-200 leading-relaxed">
                  {rec}
                </li>
              ))}
            </ul>
          )}
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
