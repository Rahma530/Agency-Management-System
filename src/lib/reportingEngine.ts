import {
  AssignmentRecord,
  CampaignRecord,
  ClientComparisonDelta,
  ClientComparisonMetrics,
  ClientComparisonRecord,
  ClientRecord,
  ComparisonMediaBuyingMetrics,
  ComparisonSeoMetrics,
  ComparisonSocialMetrics,
  ServiceType,
  SocialInsightRecord,
  TaskRecord,
  UserRole,
} from '../types/database';
import { getCampaignStartDate, getCampaignEndDate } from '../components/CampaignManagementModule';

// ----------------------------------------------------------------------------
// Period boundaries
// ----------------------------------------------------------------------------

export type ComparisonGranularity = 'monthly' | 'quarterly' | 'yearly';

export interface DateRange {
  start: string; // inclusive, YYYY-MM-DD
  end: string; // inclusive, YYYY-MM-DD
}

export interface ComparisonPeriod {
  label: string; // stored verbatim in client_comparisons.period_current/period_previous
  range: DateRange;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => d.toISOString().split('T')[0];
const inRange = (dateStr: string, range: DateRange) => dateStr >= range.start && dateStr <= range.end;

function monthPeriod(year: number, month0: number): ComparisonPeriod {
  const start = new Date(year, month0, 1);
  const end = new Date(year, month0 + 1, 0);
  return { label: `${year}-${pad2(month0 + 1)}`, range: { start: iso(start), end: iso(end) } };
}

// Reverses monthPeriod's label format ("YYYY-MM") back into a DateRange — only every actually
// correct for a label this function itself (transitively, via resolveComparisonPeriods) produced.
// Used by MonthlyReportDraftView.tsx, since a persisted client_comparisons row stores only the
// period label, not the DateRange that generated it — the monthly report draft always generates
// with monthly granularity, so this exact reverse mapping is safe for that one caller.
export function monthLabelToRange(label: string): DateRange | null {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month0 = parseInt(match[2], 10) - 1;
  return monthPeriod(year, month0).range;
}

function quarterPeriod(year: number, quarter: number): ComparisonPeriod {
  const start = new Date(year, (quarter - 1) * 3, 1);
  const end = new Date(year, quarter * 3, 0);
  return { label: `${year}-Q${quarter}`, range: { start: iso(start), end: iso(end) } };
}

function yearPeriod(year: number): ComparisonPeriod {
  return { label: `${year}`, range: { start: `${year}-01-01`, end: `${year}-12-31` } };
}

// Builds the current-vs-previous period pair for a preset granularity, anchored to whichever
// month/quarter/year the reference date (default: today) falls in.
export function resolveComparisonPeriods(
  granularity: ComparisonGranularity,
  referenceDate: Date = new Date()
): { current: ComparisonPeriod; previous: ComparisonPeriod } {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth(); // 0-indexed

  if (granularity === 'monthly') {
    const prevMonth0 = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    return { current: monthPeriod(year, month), previous: monthPeriod(prevYear, prevMonth0) };
  }

  if (granularity === 'quarterly') {
    const quarter = Math.floor(month / 3) + 1;
    const prevQuarter = quarter === 1 ? 4 : quarter - 1;
    const prevYear = quarter === 1 ? year - 1 : year;
    return { current: quarterPeriod(year, quarter), previous: quarterPeriod(prevYear, prevQuarter) };
  }

  return { current: yearPeriod(year), previous: yearPeriod(year - 1) };
}

// A caller-supplied arbitrary date range, for the "custom" comparison mode. The label is the
// range itself since there's no calendar-unit name to give it.
export function customPeriod(range: DateRange): ComparisonPeriod {
  return { label: `${range.start}_${range.end}`, range };
}

// ----------------------------------------------------------------------------
// Client-set resolution: "my own work" or "a specific agent's work", for the multi-scope
// reporting engine (Reports Hub). Deliberately mirrors two things that must stay in lockstep:
//  1. The visibility rules already coded in AMQueue.tsx (am_team_lead/am_agent) and
//     ServiceBriefsRoutingView.tsx's single-service queues (the other three departments) — team
//     leads see every client subscribed to their service, agents see only clients they hold a
//     formal assignments-table row for.
//  2. The report_scope_accessible() RLS helper the resulting comparison must pass on insert. If
//     this resolver and that helper diverge, a client-side "successful" generation can still be
//     rejected server-side — keep them matched.
// ----------------------------------------------------------------------------

// What a report/comparison generation call is about: one specific client, or an agent's pooled
// client set (agentId is the caller's own id for a self-generated "all my clients" report, or a
// direct report's id when a team lead generates one for a specific agent under them).
export type ReportScope = { type: 'client'; clientId: string } | { type: 'agent'; agentId: string };

// Which of the two independent report shapes to generate — shares its literal values with
// ClientComparisonRecord.row_kind (the DB discriminant) so UI state, the App.tsx handler
// parameter, and the persisted row all agree with no translation step between them.
export type ReportMode = 'comparison' | 'period_summary';

// True if the client subscribes to the given service. Standalone (not nested in
// resolveClientsForSubject below) so dashboards can ask "which clients belong to department X"
// directly, without needing a fake team-lead subject to route through the resolver.
// Module 13 Phase 5: reads ClientRecord.services directly — no more package_id -> packages
// indirection.
export function clientHasService(client: ClientRecord, service: ServiceType): boolean {
  return (client.services || []).includes(service);
}

// Every client subscribed to a given service — the same set a team lead for that department
// already sees (resolveClientsForSubject's team-lead branches below), factored out for callers
// that want "the whole department" without a subject user at all (DepartmentComparisonPanel).
export function resolveDepartmentClients(service: ServiceType, clients: ClientRecord[]): ClientRecord[] {
  return clients.filter((c) => clientHasService(c, service));
}

export function resolveClientsForSubject(
  subject: { id: string; role: UserRole },
  clients: ClientRecord[],
  assignments: AssignmentRecord[]
): ClientRecord[] {
  const isAssigned = (client: ClientRecord, service: ServiceType) =>
    assignments.some((a) => a.client_id === client.id && a.service_type === service && a.agent_id === subject.id);

  switch (subject.role) {
    case 'executive':
    case 'head_of_technical':
    case 'am_team_lead':
      // Module 13: 'lead' no longer exists as a status — client creation is now the onboarding
      // handoff itself, so every client is visible to these roles from creation onward.
      return clients;
    case 'am_agent':
      return clients.filter((c) => c.am_agent_id === subject.id);
    case 'media_buying_team_lead':
      return resolveDepartmentClients('media_buying', clients);
    case 'media_buying_agent':
      return resolveDepartmentClients('media_buying', clients).filter((c) => isAssigned(c, 'media_buying'));
    case 'seo_team_lead':
      return resolveDepartmentClients('seo', clients);
    case 'seo_agent':
      return resolveDepartmentClients('seo', clients).filter((c) => isAssigned(c, 'seo'));
    case 'social_media_team_lead':
      return resolveDepartmentClients('social_media', clients);
    case 'social_media_agent':
      return resolveDepartmentClients('social_media', clients).filter((c) => isAssigned(c, 'social_media'));
    default:
      return [];
  }
}

// Which service block(s) an aggregate report for this role should compute. The four
// single-department agent/lead roles only ever report on their own department's numbers, even
// if a pooled client happens to also subscribe to another service. AM and leadership roles own
// the whole client relationship, so their aggregate spans every service a pooled client has —
// signaled by returning undefined (no filter).
export function serviceFilterForRole(role: UserRole): ServiceType[] | undefined {
  switch (role) {
    case 'media_buying_team_lead':
    case 'media_buying_agent':
      return ['media_buying'];
    case 'seo_team_lead':
    case 'seo_agent':
      return ['seo'];
    case 'social_media_team_lead':
    case 'social_media_agent':
      return ['social_media'];
    default:
      return undefined;
  }
}

// ----------------------------------------------------------------------------
// Media Buying: spend, ROAS, conversions, CPA — from CampaignRecord, pooled across one or more
// clients (a single client is just the clientIds.length === 1 case).
// ----------------------------------------------------------------------------
// Campaign rows carry cumulative results for the campaign's whole run, not a per-day time
// series, so "in period X" means "was running during period X" (start/end overlap the range),
// not "logged on a date within X". This is the best available proxy given the schema.
function campaignOverlapsRange(c: CampaignRecord, range: DateRange): boolean {
  const start = getCampaignStartDate(c);
  if (!start) return false;
  const end = getCampaignEndDate(c);
  if (end) return start <= range.end && end >= range.start;
  return start <= range.end; // still running (or single-date row) — active for any period from its start onward
}

export function aggregateMediaBuyingMetrics(
  campaigns: CampaignRecord[],
  clientIds: string[],
  range: DateRange
): ComparisonMediaBuyingMetrics {
  const scoped = campaigns.filter((c) => clientIds.includes(c.client_id) && campaignOverlapsRange(c, range));

  const spend = scoped.reduce((sum, c) => sum + (c.spend || 0), 0);
  const conversions = scoped.reduce((sum, c) => {
    const v = c.results?.conversions;
    return sum + (typeof v === 'number' ? v : 0);
  }, 0);

  // CPA is a true ratio, so it's recomputed from the pooled totals rather than averaged
  // per-campaign — averaging per-campaign CPA would weight a $50 campaign the same as a $50k
  // one. This also corrects the original single-client implementation, which had the same flaw
  // at smaller scale.
  const cpa = conversions > 0 ? Math.round((spend / conversions) * 100) / 100 : null;

  // No revenue field exists to recompute a true ROAS ratio (unlike CPA), so this is the best
  // available proxy: each campaign's own reported ROAS, weighted by its spend, rather than a
  // flat average — still better than treating every campaign as equally sized.
  const roasEntries = scoped
    .map((c) => ({ roas: c.results?.roas, spend: c.spend || 0 }))
    .filter((e): e is { roas: number; spend: number } => typeof e.roas === 'number' && e.spend > 0);
  const roasWeight = roasEntries.reduce((sum, e) => sum + e.spend, 0);
  const roas = roasWeight > 0
    ? Math.round((roasEntries.reduce((sum, e) => sum + e.roas * e.spend, 0) / roasWeight) * 100) / 100
    : null;

  return { spend, roas, conversions, cpa };
}

// ----------------------------------------------------------------------------
// SEO: no analytics table exists in this schema — this is an operational delivery proxy
// (completed tasks + on-time rate for the SEO-team tasks of the pooled clients), not a true
// performance metric. Flagged in the reporting plan as a real data gap.
// ----------------------------------------------------------------------------
export function aggregateSeoMetrics(tasks: TaskRecord[], clientIds: string[], range: DateRange): ComparisonSeoMetrics {
  const completed = tasks.filter(
    (t) =>
      clientIds.includes(t.client_id) &&
      t.team === 'SEO' &&
      t.status === 'completed' &&
      t.completed_at &&
      inRange(t.completed_at.split('T')[0], range)
  );
  const completed_tasks = completed.length;
  if (completed_tasks === 0) return { completed_tasks, on_time_rate: null };

  // Ratio recomputed from the pooled completed-task set, not averaged per client — same
  // weighting principle as CPA above.
  const onTime = completed.filter((t) => t.completed_at!.split('T')[0] <= t.due_date).length;
  return { completed_tasks, on_time_rate: Math.round((onTime / completed_tasks) * 100) };
}

// ----------------------------------------------------------------------------
// Social Media: from SocialInsightRecord.metrics — an untyped JSON blob per platform row, so
// every field is pulled defensively (present or not, per row). reach/engagement_rate are
// averaged across the period's pooled rows (rate-like); follower_growth is summed (accumulates).
// ----------------------------------------------------------------------------
function avgMetric(rows: SocialInsightRecord[], key: string): number | null {
  const values = rows.map((r) => r.metrics?.[key]).filter((v): v is number => typeof v === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function sumMetric(rows: SocialInsightRecord[], key: string): number | null {
  const values = rows.map((r) => r.metrics?.[key]).filter((v): v is number => typeof v === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

export function aggregateSocialMetrics(
  insights: SocialInsightRecord[],
  clientIds: string[],
  range: DateRange
): ComparisonSocialMetrics {
  const rows = insights.filter((i) => clientIds.includes(i.client_id) && inRange(i.date, range));
  return {
    reach: avgMetric(rows, 'reach'),
    engagement_rate: avgMetric(rows, 'engagement_rate'),
    follower_growth: sumMetric(rows, 'follower_growth'),
  };
}

// ----------------------------------------------------------------------------
// Full metrics block for a period, pooled across one or more clients. Each service block is
// independently scoped to whichever of the given clients actually subscribes to that service
// (so a single client with only SEO never gets an empty media_buying block, and a mixed pool
// only counts each client toward the services it actually has) — narrowed further by
// serviceFilter when the caller's role only reports on one department's numbers.
// ----------------------------------------------------------------------------
export function generateClientComparisonMetrics(
  clients: ClientRecord[],
  range: DateRange,
  campaigns: CampaignRecord[],
  tasks: TaskRecord[],
  socialInsights: SocialInsightRecord[],
  serviceFilter?: ServiceType[]
): ClientComparisonMetrics {
  const wantsService = (service: ServiceType) => !serviceFilter || serviceFilter.includes(service);
  const clientIdsWith = (service: ServiceType) => clients.filter((c) => clientHasService(c, service)).map((c) => c.id);

  const metrics: ClientComparisonMetrics = {};

  if (wantsService('media_buying')) {
    const ids = clientIdsWith('media_buying');
    if (ids.length) metrics.media_buying = aggregateMediaBuyingMetrics(campaigns, ids, range);
  }
  if (wantsService('seo')) {
    const ids = clientIdsWith('seo');
    if (ids.length) metrics.seo = aggregateSeoMetrics(tasks, ids, range);
  }
  if (wantsService('social_media')) {
    const ids = clientIdsWith('social_media');
    if (ids.length) metrics.social_media = aggregateSocialMetrics(socialInsights, ids, range);
  }

  return metrics;
}

// ----------------------------------------------------------------------------
// Delta: % change per indicator, current vs. previous. null when either side is
// null/undefined, or when the previous value is 0 and current isn't (an undefined % change).
// ----------------------------------------------------------------------------
function pctDelta(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr === null || curr === undefined || prev === null || prev === undefined) return null;
  if (prev === 0) return curr === 0 ? 0 : null;
  return Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10; // one decimal place
}

export function computeComparisonDelta(
  current: ClientComparisonMetrics,
  previous: ClientComparisonMetrics
): ClientComparisonDelta {
  const delta: ClientComparisonDelta = {};

  if (current.media_buying || previous.media_buying) {
    const c = current.media_buying;
    const p = previous.media_buying;
    delta.media_buying = {
      spend: pctDelta(c?.spend, p?.spend),
      roas: pctDelta(c?.roas, p?.roas),
      conversions: pctDelta(c?.conversions, p?.conversions),
      cpa: pctDelta(c?.cpa, p?.cpa),
    };
  }

  if (current.seo || previous.seo) {
    const c = current.seo;
    const p = previous.seo;
    delta.seo = {
      completed_tasks: pctDelta(c?.completed_tasks, p?.completed_tasks),
      on_time_rate: pctDelta(c?.on_time_rate, p?.on_time_rate),
    };
  }

  if (current.social_media || previous.social_media) {
    const c = current.social_media;
    const p = previous.social_media;
    delta.social_media = {
      reach: pctDelta(c?.reach, p?.reach),
      engagement_rate: pctDelta(c?.engagement_rate, p?.engagement_rate),
      follower_growth: pctDelta(c?.follower_growth, p?.follower_growth),
    };
  }

  return delta;
}

// ----------------------------------------------------------------------------
// Threshold rules -> summary + recommendation text. Deterministic, no model call, auditable.
// Runs off the stored metrics_current/metrics_previous/delta, so it's re-derivable at render
// time from a persisted ClientComparisonRecord without needing its own storage column.
// ----------------------------------------------------------------------------
export function generateComparisonNarrative(
  current: ClientComparisonMetrics,
  previous: ClientComparisonMetrics,
  delta: ClientComparisonDelta
): { summary: string; recommendations: string } {
  const summaryParts: string[] = [];
  const recommendationParts: string[] = [];

  if (current.media_buying || previous.media_buying) {
    const d = delta.media_buying || {};
    const spendDelta = d.spend ?? null;
    const conversionsDelta = d.conversions ?? null;
    const roasDelta = d.roas ?? null;
    const cpaDelta = d.cpa ?? null;

    if (spendDelta !== null && conversionsDelta !== null && spendDelta > 10 && conversionsDelta < 0) {
      summaryParts.push(
        `Media Buying: efficiency declined — spend increased ${spendDelta}% while conversions dropped ${Math.abs(conversionsDelta)}%.`
      );
      recommendationParts.push(
        'Recommend reallocating budget away from underperforming campaigns and reviewing audience targeting for the next period.'
      );
    }
    if (roasDelta !== null && roasDelta > 15) {
      summaryParts.push(`Media Buying: strong improvement — ROAS increased ${roasDelta}%, indicating more efficient ad spend.`);
      recommendationParts.push('Recommend maintaining current strategy; consider a modest budget increase to scale results.');
    }
    if (cpaDelta !== null && cpaDelta > 20) {
      summaryParts.push(`Media Buying: cost per acquisition rose ${cpaDelta}% this period.`);
      recommendationParts.push('Recommend a creative refresh or narrower audience targeting to reduce cost per acquisition.');
    }
    if (spendDelta !== null && conversionsDelta !== null && Math.abs(spendDelta) <= 5 && conversionsDelta > 10) {
      summaryParts.push(
        `Media Buying: efficiency gain — conversions grew ${conversionsDelta}% without a proportional spend increase.`
      );
    }
  }

  if (current.social_media || previous.social_media) {
    const d = delta.social_media || {};
    const engagementDelta = d.engagement_rate ?? null;
    const followerDelta = d.follower_growth ?? null;

    if (engagementDelta !== null && engagementDelta < -15) {
      summaryParts.push('Social Media: engagement declined significantly this period.');
      recommendationParts.push('Recommend revisiting content cadence and format; consider A/B testing post types.');
    }
    if (followerDelta !== null && followerDelta > 20) {
      summaryParts.push('Social Media: strong audience growth this period.');
      recommendationParts.push('Recommend doubling down on the current content mix driving growth.');
    }
  }

  if (current.seo || previous.seo) {
    const c = current.seo;
    const p = previous.seo;
    const completedDelta = (c?.completed_tasks ?? 0) - (p?.completed_tasks ?? 0);
    const onTimeDeclined =
      c?.on_time_rate !== null &&
      c?.on_time_rate !== undefined &&
      p?.on_time_rate !== null &&
      p?.on_time_rate !== undefined &&
      c.on_time_rate < p.on_time_rate;

    if (completedDelta < 0 && onTimeDeclined) {
      summaryParts.push('SEO: delivery pace slowed this period.');
      recommendationParts.push('Recommend reviewing SEO team capacity or blockers for next period.');
    } else {
      summaryParts.push('SEO: consistent delivery maintained.');
    }
  }

  return {
    summary: summaryParts.length ? summaryParts.join(' ') : 'No significant changes to report this period.',
    recommendations: recommendationParts.length
      ? recommendationParts.join(' ')
      : 'No specific recommendations — performance is stable.',
  };
}

// ----------------------------------------------------------------------------
// Full generation, tying the above together into what gets stored in client_comparisons.
// `clients` is one client for the original single-client case, or a resolved pool (via
// resolveClientsForSubject) for an aggregate. Each service block is scoped automatically to
// whichever of `clients` actually subscribes to it (see generateClientComparisonMetrics), so
// passing a single client behaves exactly as before with no explicit service list needed.
// ----------------------------------------------------------------------------
export function generateClientComparison(
  clients: ClientRecord[],
  currentPeriod: ComparisonPeriod,
  previousPeriod: ComparisonPeriod,
  campaigns: CampaignRecord[],
  tasks: TaskRecord[],
  socialInsights: SocialInsightRecord[],
  serviceFilter?: ServiceType[]
): {
  row_kind: 'comparison';
  period_current: string;
  period_previous: string;
  metrics_current: ClientComparisonMetrics;
  metrics_previous: ClientComparisonMetrics;
  delta: ClientComparisonDelta;
  ai_recommendations_text: string;
  covered_client_ids: string[];
} {
  const metrics_current = generateClientComparisonMetrics(
    clients,
    currentPeriod.range,
    campaigns,
    tasks,
    socialInsights,
    serviceFilter
  );
  const metrics_previous = generateClientComparisonMetrics(
    clients,
    previousPeriod.range,
    campaigns,
    tasks,
    socialInsights,
    serviceFilter
  );
  const delta = computeComparisonDelta(metrics_current, metrics_previous);
  const { recommendations } = generateComparisonNarrative(metrics_current, metrics_previous, delta);

  return {
    row_kind: 'comparison',
    period_current: currentPeriod.label,
    period_previous: previousPeriod.label,
    metrics_current,
    metrics_previous,
    delta,
    ai_recommendations_text: recommendations,
    covered_client_ids: clients.map((c) => c.id),
  };
}

// ----------------------------------------------------------------------------
// Single-period snapshot: the same per-service metrics as above, for one period alone, with no
// prior-period comparison. metrics_previous/delta are {} (every field on those two types is
// optional, so an empty object is already a valid "nothing here" value) and there's no
// recommendation text — the threshold rules all key off a delta that doesn't exist here.
// ----------------------------------------------------------------------------
export function generatePeriodSummary(
  clients: ClientRecord[],
  period: ComparisonPeriod,
  campaigns: CampaignRecord[],
  tasks: TaskRecord[],
  socialInsights: SocialInsightRecord[],
  serviceFilter?: ServiceType[]
): {
  row_kind: 'period_summary';
  period_current: string;
  period_previous: null;
  metrics_current: ClientComparisonMetrics;
  metrics_previous: ClientComparisonMetrics;
  delta: ClientComparisonDelta;
  ai_recommendations_text: null;
  covered_client_ids: string[];
} {
  const metrics_current = generateClientComparisonMetrics(
    clients,
    period.range,
    campaigns,
    tasks,
    socialInsights,
    serviceFilter
  );

  return {
    row_kind: 'period_summary',
    period_current: period.label,
    period_previous: null,
    metrics_current,
    metrics_previous: {},
    delta: {},
    ai_recommendations_text: null,
    covered_client_ids: clients.map((c) => c.id),
  };
}

// ----------------------------------------------------------------------------
// Anomaly detection (Module 9, point 3): pure statistics, no model call. Answers a genuinely
// different question from computeComparisonDelta above — that's "did this period get worse than
// the one immediately before it"; this is "is this period well below what's normal for this
// client", using a rolling baseline over several prior periods rather than just one. Every time a
// comparison/period-summary is generated for a client, a new client_comparisons row accumulates
// (the unique constraint is per (client_id, period_current, period_previous) triple, not one row
// per client) — metrics_current across a client's historical rows, ordered by period_current, is
// the time series this baseline is drawn from.
// ----------------------------------------------------------------------------
export interface AnomalyFlag {
  service: ServiceType;
  metricLabel: string;
  currentValue: number;
  baselineValue: number;
  pctBelowBaseline: number; // positive, e.g. 32.4 = 32.4% below baseline
  // 'low' when the baseline was drawn from only 1 prior period — still shown (better than
  // nothing), but callers should visually distinguish it from a baseline backed by real history.
  confidence: 'low' | 'normal';
}

export interface ClientAnomalyResult {
  latestComparisonId: string;
  flags: AnomalyFlag[];
}

const ANOMALY_DROP_THRESHOLD_PCT = 25;
const ANOMALY_BASELINE_WINDOW = 3;

// Direction-aware by construction: only ever called with metrics where a lower value is bad
// (never spend, reach, or cpa, where "lower" isn't inherently a problem).
function flagIfBelowBaseline(
  service: ServiceType,
  metricLabel: string,
  currentValue: number | null | undefined,
  priorValues: (number | null | undefined)[]
): AnomalyFlag | null {
  if (typeof currentValue !== 'number') return null;
  const usable = priorValues.filter((v): v is number => typeof v === 'number');
  if (usable.length === 0) return null;

  const baseline = usable.reduce((sum, v) => sum + v, 0) / usable.length;
  if (baseline <= 0) return null; // nothing meaningful to compare a drop against

  const pctBelow = ((baseline - currentValue) / baseline) * 100;
  if (pctBelow < ANOMALY_DROP_THRESHOLD_PCT) return null;

  return {
    service,
    metricLabel,
    currentValue,
    baselineValue: Math.round(baseline * 100) / 100,
    pctBelowBaseline: Math.round(pctBelow * 10) / 10,
    confidence: usable.length < ANOMALY_BASELINE_WINDOW ? 'low' : 'normal',
  };
}

// `allComparisons` is every comparison/period-summary row visible to the caller, any scope, any
// order — this filters to the one client's own client-scoped rows (never agent-pooled rows, which
// carry client_id: null and are excluded by the equality filter) and sorts them itself. Returns
// null when there's no prior period to baseline against yet (0 or 1 total rows for this client).
export function detectClientAnomalies(
  clientId: string,
  allComparisons: ClientComparisonRecord[]
): ClientAnomalyResult | null {
  const rows = allComparisons
    .filter((r) => r.client_id === clientId)
    .slice()
    .sort((a, b) => a.period_current.localeCompare(b.period_current));
  if (rows.length < 2) return null;

  const latest = rows[rows.length - 1];
  const priorRows = rows.slice(0, -1).slice(-ANOMALY_BASELINE_WINDOW);

  const flags: AnomalyFlag[] = [];

  const mb = latest.metrics_current.media_buying;
  const mbPrior = priorRows.map((r) => r.metrics_current.media_buying);
  const roasFlag = flagIfBelowBaseline('media_buying', 'ROAS', mb?.roas, mbPrior.map((p) => p?.roas));
  if (roasFlag) flags.push(roasFlag);
  const conversionsFlag = flagIfBelowBaseline(
    'media_buying',
    'Conversions',
    mb?.conversions,
    mbPrior.map((p) => p?.conversions)
  );
  if (conversionsFlag) flags.push(conversionsFlag);

  const sm = latest.metrics_current.social_media;
  const smPrior = priorRows.map((r) => r.metrics_current.social_media);
  const engagementFlag = flagIfBelowBaseline(
    'social_media',
    'Engagement Rate',
    sm?.engagement_rate,
    smPrior.map((p) => p?.engagement_rate)
  );
  if (engagementFlag) flags.push(engagementFlag);
  const followerFlag = flagIfBelowBaseline(
    'social_media',
    'Follower Growth',
    sm?.follower_growth,
    smPrior.map((p) => p?.follower_growth)
  );
  if (followerFlag) flags.push(followerFlag);

  const seo = latest.metrics_current.seo;
  const seoPrior = priorRows.map((r) => r.metrics_current.seo);
  const onTimeFlag = flagIfBelowBaseline('seo', 'On-Time Rate', seo?.on_time_rate, seoPrior.map((p) => p?.on_time_rate));
  if (onTimeFlag) flags.push(onTimeFlag);

  return { latestComparisonId: latest.id, flags };
}

// ----------------------------------------------------------------------------
// Task completion stats for one client over a period — the delivery half of a monthly report
// draft (generatePeriodSummary above covers the analytics half). Deliberately client-scoped: the
// one existing similar function, performanceScore.ts's computeOnTimeCompletionRate, is
// employee-scoped (filters by assigned_to) and has no client-scoped equivalent today.
// ----------------------------------------------------------------------------
export interface ClientTaskCompletionStats {
  totalTasks: number;
  completedTasks: number;
  onTimeRate: number | null; // null when completedTasks is 0
}

export function computeClientTaskCompletionStats(
  tasks: TaskRecord[],
  clientId: string,
  range: DateRange
): ClientTaskCompletionStats {
  const clientTasks = tasks.filter((t) => t.client_id === clientId);
  const completed = clientTasks.filter(
    (t) => t.status === 'completed' && t.completed_at && inRange(t.completed_at.split('T')[0], range)
  );
  const onTimeRate =
    completed.length === 0
      ? null
      : Math.round((completed.filter((t) => t.completed_at!.split('T')[0] <= t.due_date).length / completed.length) * 100);

  return {
    totalTasks: clientTasks.length,
    completedTasks: completed.length,
    onTimeRate,
  };
}
