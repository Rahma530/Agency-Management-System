// Phase 2: the Task Registry. Every task is a plain data entry (name, ordered stages, each with a
// provider order/system prompt/max output tokens/expected output format) — adding a 5th task later
// means adding an entry here, never touching taskRunner.ts's execution logic or index.ts's dispatch.
// PHASE1_TEST_* in index.ts is untouched and does not go through this registry at all.
//
// One stage vs. two: a task needs an EXTRACT stage only when its input genuinely requires a model to
// parse or restructure it (free text, an inconsistent/undocumented shape, anything not already
// guaranteed well-formed). CAMPAIGN_SUMMARY originally had one (Gemini primary, Groq fallback) that
// only ever reformatted already-validated, already-computed JSON — pure copying, no real parsing
// work. Live testing then hit Gemini returning 503 twice, which forced the EXTRACT fallback to Groq
// both times and put two Groq requests inside the same rate-limit minute for what was really a
// single logical request. Since EXTRACT was doing no real work for this task, it was removed
// entirely and replaced by buildAnalyzeInput() below (plain code, no model call) — CAMPAIGN_SUMMARY
// is now ANALYZE-only. The runner (taskRunner.ts) still executes however many stages a task defines
// with no special-casing — nothing here hardcodes "two stages"; a future task whose input actually
// needs model-assisted parsing defines its own two-stage TaskDefinition (its own EXTRACT prompt,
// schema, and provider order) the exact same way CAMPAIGN_SUMMARY's ANALYZE stage is defined below.
//
// Generic EXTRACT_CLIENT_DATA/ANALYZE_CLIENT_DATA task names from the original design were folded
// directly into CAMPAIGN_SUMMARY's stage(s) instead of being kept as separate top-level registry
// entries: the part that's actually reusable across future tasks is the runner/fallback mechanism
// (already generic in taskRunner.ts), not the prompts or schemas themselves — a future task's
// EXTRACT prompt will look nothing like one written for this task, so a shared "EXTRACT_CLIENT_DATA"
// entry would just be dead weight, not a real building block.
import { AiProvider } from './types.ts';

export type SupportedLanguage = 'ar' | 'en';
export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = { ar: 'Arabic', en: 'English' };
export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return value === 'ar' || value === 'en';
}

// Per-request detail level for CAMPAIGN_SUMMARY's ANALYZE stage. 'brief' is the default and its
// prompt/schema/token budget are unchanged from before this was added — EXTRACT never reads this at
// all, and it isn't part of the input payload allowlist (it's a request-level option, not data).
export type DetailLevel = 'brief' | 'detailed';
export function isDetailLevel(value: unknown): value is DetailLevel {
  return value === 'brief' || value === 'detailed';
}

// A stage's JSON output is well-formed (JSON.parse succeeds) but that alone doesn't mean it has the
// keys/types the next stage (or the caller) expects — a fallback model in particular can easily
// produce syntactically valid JSON in the wrong shape. validateOutput on TaskStageDefinition below
// checks the parsed value's shape and returns a normalized/cleaned version of it; `ok: false` means
// reject the whole stage rather than pass a malformed result onward.
export interface StageValidationResult {
  ok: boolean;
  value?: unknown;
}

export interface TaskStageDefinition {
  name: string;
  // Ordered: index 0 is tried first, then each next entry only after the previous one returns
  // ok:false — not limited to a single fallback. A function (not a plain array) so a provider order
  // that depends on an env var (see CAMPAIGN_SUMMARY_ANALYZE_ORDER below) can validate lazily, at
  // request time, and fail just this stage with a clear message rather than crashing the whole
  // Edge Function at cold start over one task's misconfigured override. A task with a fixed order
  // simply returns a constant array, e.g. `() => ['gemini', 'groq']`.
  providers: () => AiProvider[];
  systemPrompt: (language: SupportedLanguage, detail: DetailLevel) => string;
  maxOutputTokens: (detail: DetailLevel) => number;
  outputFormat: 'json' | 'text';
  // Only meaningful when outputFormat is 'json'; undefined means "valid JSON is enough, no shape
  // check". Applied uniformly to whichever provider in the order actually answered — see
  // taskRunner.ts — so a wrongly-shaped result from ANY of them is caught the same way.
  validateOutput?: (parsed: unknown, detail: DetailLevel) => StageValidationResult;
}

export interface TaskDefinition {
  name: string;
  stages: TaskStageDefinition[];
  // Validates and normalizes the caller's raw payload into stage 0's actual input. Throws a plain
  // Error (caught by taskRunner.ts and turned into an ok:false with kind:'error') on any
  // violation — unknown field, wrong type, disallowed value, oversized payload.
  buildInitialInput: (rawPayload: unknown) => unknown;
}

// ----------------------------------------------------------------------------
// CAMPAIGN_SUMMARY input allowlist — the ONLY fields a caller may send. This is what guarantees no
// client name, phone number, email, or contract detail can ever reach a provider: the payload is
// aggregated performance numbers only, nothing else is even structurally possible to include.
// Mirrors reportingEngine.ts's existing ClientComparisonMetrics service/metric/unit vocabulary
// (SERVICE_METRIC_LABELS/SERVICE_METRIC_UNITS in ComparisonDisplay.tsx) so a future Phase 5 caller
// can build this payload directly from data it already computes today.
// ----------------------------------------------------------------------------
export const CAMPAIGN_SUMMARY_SERVICES = ['media_buying', 'social_media', 'seo'] as const;
export type CampaignSummaryService = (typeof CAMPAIGN_SUMMARY_SERVICES)[number];

export const CAMPAIGN_SUMMARY_METRICS_BY_SERVICE: Record<CampaignSummaryService, readonly string[]> = {
  media_buying: ['spend', 'roas', 'conversions', 'cpa'],
  social_media: ['reach', 'engagement_rate', 'follower_growth'],
  seo: ['completed_tasks', 'on_time_rate'],
};

export const CAMPAIGN_SUMMARY_UNITS = ['', 'SAR', '%', 'x'] as const;

// Matches reportingEngine.ts's four period-label shapes: monthly ("2026-03"), quarterly
// ("2026-Q1"), yearly ("2026"), and custom range ("2026-01-01_2026-03-31") — see
// resolveComparisonPeriods()/customPeriod() there for the generators these mirror. Widened from
// monthly-only after confirming (live) that nothing else in this file or in buildAnalyzeSystemPrompt
// assumed a monthly period except the Arabic "في الشهر السابق" phrase fixed just below.
const PERIOD_LABEL_RE = /^(?:\d{4}-\d{2}|\d{4}-Q[1-4]|\d{4}|\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2})$/;
const PERIOD_LABEL_ERROR = 'must be a valid period label ("YYYY-MM", "YYYY-Qn", "YYYY", or "YYYY-MM-DD_YYYY-MM-DD")';
const MAX_PAYLOAD_BYTES = 8 * 1024; // aggregated metrics only — 8 KB is already generous
const MAX_METRICS = 20;

interface CampaignSummaryMetricPoint {
  service: CampaignSummaryService;
  metric: string;
  current_value: number | null;
  previous_value: number | null;
  unit: string;
}

interface CampaignSummaryPayload {
  period_current: string;
  period_previous: string | null;
  metrics: CampaignSummaryMetricPoint[];
}

function validateCampaignSummaryPayload(rawPayload: unknown): CampaignSummaryPayload {
  const byteLength = new TextEncoder().encode(JSON.stringify(rawPayload ?? null)).length;
  if (byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload exceeds the ${MAX_PAYLOAD_BYTES}-byte limit for CAMPAIGN_SUMMARY.`);
  }
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new Error('CAMPAIGN_SUMMARY payload must be a JSON object.');
  }
  const p = rawPayload as Record<string, unknown>;
  const allowedTopKeys = new Set(['period_current', 'period_previous', 'metrics']);
  for (const key of Object.keys(p)) {
    if (!allowedTopKeys.has(key)) throw new Error(`Unknown payload field "${key}".`);
  }

  if (typeof p.period_current !== 'string' || !PERIOD_LABEL_RE.test(p.period_current)) {
    throw new Error(`period_current ${PERIOD_LABEL_ERROR}.`);
  }
  if (p.period_previous !== null && p.period_previous !== undefined
    && (typeof p.period_previous !== 'string' || !PERIOD_LABEL_RE.test(p.period_previous))) {
    throw new Error(`period_previous ${PERIOD_LABEL_ERROR}, or null.`);
  }
  if (!Array.isArray(p.metrics) || p.metrics.length === 0 || p.metrics.length > MAX_METRICS) {
    throw new Error(`metrics must be a non-empty array of at most ${MAX_METRICS} entries.`);
  }

  const allowedMetricKeys = new Set(['service', 'metric', 'current_value', 'previous_value', 'unit']);
  const metrics: CampaignSummaryMetricPoint[] = p.metrics.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`metrics[${i}] must be an object.`);
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!allowedMetricKeys.has(key)) throw new Error(`Unknown field "${key}" in metrics[${i}].`);
    }
    if (typeof e.service !== 'string' || !(CAMPAIGN_SUMMARY_SERVICES as readonly string[]).includes(e.service)) {
      throw new Error(`metrics[${i}].service must be one of: ${CAMPAIGN_SUMMARY_SERVICES.join(', ')}.`);
    }
    const service = e.service as CampaignSummaryService;
    if (typeof e.metric !== 'string' || !CAMPAIGN_SUMMARY_METRICS_BY_SERVICE[service].includes(e.metric)) {
      throw new Error(`metrics[${i}].metric "${String(e.metric)}" is not allowed for service "${service}".`);
    }
    if (e.current_value !== null && e.current_value !== undefined && typeof e.current_value !== 'number') {
      throw new Error(`metrics[${i}].current_value must be a number or null.`);
    }
    if (e.previous_value !== null && e.previous_value !== undefined && typeof e.previous_value !== 'number') {
      throw new Error(`metrics[${i}].previous_value must be a number or null.`);
    }
    const unit = e.unit === undefined ? '' : e.unit;
    if (typeof unit !== 'string' || !(CAMPAIGN_SUMMARY_UNITS as readonly string[]).includes(unit)) {
      throw new Error(`metrics[${i}].unit must be one of: ${CAMPAIGN_SUMMARY_UNITS.map((u) => JSON.stringify(u)).join(', ')}.`);
    }
    return {
      service,
      metric: e.metric,
      current_value: (e.current_value as number | null | undefined) ?? null,
      previous_value: (e.previous_value as number | null | undefined) ?? null,
      unit,
    };
  });

  return {
    period_current: p.period_current,
    period_previous: (p.period_previous as string | null | undefined) ?? null,
    metrics,
  };
}

// Replaces what the now-removed EXTRACT stage used to do (drop metrics with nothing to report,
// compute each kept metric's percentage change) — entirely in code, never asked of a model. Two
// separate reasons this is deterministic, not an LLM call: percentage change is trivial arithmetic
// (trusting a small/fast free-tier model to get it right every time would be an avoidable source of
// hallucinated numbers), and the filtering step is a single mechanical rule with no actual parsing
// work behind it, which was exactly why the old EXTRACT stage added a real Gemini/Groq call for no
// real benefit.
function buildAnalyzeInput(payload: CampaignSummaryPayload): unknown {
  return {
    period_current: payload.period_current,
    period_previous: payload.period_previous,
    metrics: payload.metrics
      .filter((m) => m.current_value !== null || m.previous_value !== null)
      .map((m) => ({
        ...m,
        // Math.abs(previous_value) matches reportingEngine.ts's own pctDelta() exactly — without
        // it, a metric whose previous_value is legitimately negative (only follower_growth today,
        // a net follower loss) could get an inverted sign here vs. the DeltaBadge already on
        // screen for that same metric, since this app's own UI computes delta with Math.abs and
        // this line previously didn't.
        delta_pct:
          m.current_value !== null && m.previous_value !== null && m.previous_value !== 0
            ? Math.round(((m.current_value - m.previous_value) / Math.abs(m.previous_value)) * 1000) / 10
            : null,
      })),
  };
}

// ----------------------------------------------------------------------------
// CAMPAIGN_SUMMARY's ANALYZE provider order — configurable via CAMPAIGN_SUMMARY_ANALYZE_ORDER
// (comma-separated, e.g. "gemini,groq,openrouter"). Parsed once at module load (same timing as
// GEMINI_MODEL/GROQ_MODEL/etc. in the provider adapters), but a parse failure is stored rather than
// thrown immediately: throwing here would crash the whole Edge Function — every task, including
// PHASE1_TEST_* — over one env var typo. The stored error is instead re-thrown lazily, only when
// this stage's providers() is actually called for a CAMPAIGN_SUMMARY request, which taskRunner.ts
// already catches and turns into an ok:false for that stage alone (same pattern as
// TaskDefinition.buildInitialInput's own throw-on-invalid-payload).
// ----------------------------------------------------------------------------
const KNOWN_PROVIDERS: readonly AiProvider[] = ['gemini', 'groq', 'openrouter'];
const DEFAULT_ANALYZE_ORDER: AiProvider[] = ['groq', 'gemini', 'openrouter'];

function parseAnalyzeProviderOrder(raw: string): AiProvider[] {
  const seen = new Set<AiProvider>();
  const order: AiProvider[] = [];
  for (const name of raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(name)) {
      throw new Error(
        `CAMPAIGN_SUMMARY_ANALYZE_ORDER contains an unknown provider "${name}" — must be a ` +
          `comma-separated list using only: ${KNOWN_PROVIDERS.join(', ')}.`
      );
    }
    const provider = name as AiProvider;
    if (!seen.has(provider)) {
      seen.add(provider);
      order.push(provider); // duplicates ignored, not rejected
    }
  }
  if (order.length === 0) {
    throw new Error('CAMPAIGN_SUMMARY_ANALYZE_ORDER is set but empty after parsing — list at least one provider.');
  }
  return order;
}

let cachedAnalyzeOrder: AiProvider[] | null = null;
let cachedAnalyzeOrderError: string | null = null;
try {
  const raw = Deno.env.get('CAMPAIGN_SUMMARY_ANALYZE_ORDER');
  cachedAnalyzeOrder = raw ? parseAnalyzeProviderOrder(raw) : DEFAULT_ANALYZE_ORDER;
} catch (err) {
  cachedAnalyzeOrderError = err instanceof Error ? err.message : String(err);
}

function getAnalyzeProviderOrder(): AiProvider[] {
  if (cachedAnalyzeOrderError) throw new Error(cachedAnalyzeOrderError);
  return cachedAnalyzeOrder as AiProvider[];
}

// ----------------------------------------------------------------------------
// Shared Arabic-quality rules — used by CAMPAIGN_SUMMARY's ANALYZE prompt below AND
// UNIFIED_CLIENT_REPORT's prompt, so a future wording refinement (two have already happened, from
// live testing) only needs to change one place instead of two prompts drifting apart. Returns ''
// for English, so callers can always append this unconditionally.
// ----------------------------------------------------------------------------
export function buildArabicQualityRules(language: SupportedLanguage): string {
  if (language !== 'ar') return '';
  return (
    `- Arabic grammar: match the verb/adjective's gender to the noun it describes (e.g. ` +
    `"ارتفعت تكلفة الاكتساب", not "ارتفع تكلفة الاكتساب").\n` +
    `- When the direction is already stated in words (ارتفع/انخفض/تراجع/تحسّن), write the ` +
    `percentage as a plain positive number (e.g. 26.2%) — never with a minus sign.\n` +
    `- Avoid "مسبقاً". When referring to the previous period, name it using its actual label from ` +
    `the input's period_previous field (e.g. "في الفترة 2026-02" or "في الفترة 2026-Q1"), never a ` +
    `fixed word like "الشهر الماضي" — the previous period is not always a month.\n`
  );
}

// ----------------------------------------------------------------------------
// CAMPAIGN_SUMMARY's ANALYZE prompt. Arabic-specific wording rules
// (grammar/phrasing) are appended only when language === 'ar', so the English variant stays as
// short as before — refined after live testing surfaced small but real Arabic-quality issues
// (gender-agreement errors, a minus sign clashing with a word-stated direction, an awkward
// "مسبقاً"). `intro` and `arabicRules` are shared between 'brief' and 'detailed' so the two schemas
// stay consistent on the parts that don't differ; 'brief'`s own text below is byte-for-byte what it
// was before "detailed" existed.
function buildAnalyzeSystemPrompt(language: SupportedLanguage, detail: DetailLevel): string {
  const languageName = LANGUAGE_NAMES[language];
  const arabicRules = buildArabicQualityRules(language);
  const intro =
    `You are a marketing performance analyst writing for an internal agency dashboard. You will ` +
    `receive a JSON object of already-verified metrics comparing two periods (service, metric, ` +
    `current_value, previous_value, delta_pct, unit). Analyze ONLY this data — never invent, ` +
    `estimate, or reference any number, client, platform, or fact that is not present in it.\n\n` +
    `Write in ${languageName}, using simple, professional wording suitable for a short business ` +
    `report. Metric names (e.g. ROAS, CPA) may stay in English even inside a ${languageName} sentence.\n\n`;

  if (detail === 'detailed') {
    return (
      intro +
      `Respond with ONLY this JSON object — no markdown code fences, no explanation:\n` +
      `{"summary": string, "by_service": [{"service": string, "text": string}], "recommendations": string[]}\n\n` +
      `Rules:\n` +
      `- summary: exactly 2 sentences giving the overall picture across all services present.\n` +
      `- by_service: one entry per service that actually appears in the input metrics ` +
      `(media_buying, social_media, and/or seo) — omit any service with no metrics in the input. ` +
      `Each entry's text is one short paragraph covering that service's findings, citing the actual ` +
      `current/previous value or delta_pct from the input.\n` +
      `- recommendations: at most 5 short, actionable sentences, ordered by priority (most important ` +
      `first), each tied to a specific finding in a by_service paragraph and grounded only in the ` +
      `input's numbers — never invent a fact or number not present in it. Return an empty array if ` +
      `nothing in the data warrants a recommendation.\n` +
      `- If a metric's current_value or previous_value is null, say so explicitly instead of ` +
      `guessing a number.\n` +
      arabicRules +
      `- If metrics is empty, respond with {"summary": "<one sentence in ${languageName} saying no ` +
      `metrics were provided for this period>", "by_service": [], "recommendations": []}.\n` +
      `- Every number you write must exactly match a number present in the input JSON.`
    );
  }

  return (
    intro +
    `Respond with ONLY this JSON object — no markdown code fences, no explanation:\n` +
    `{"findings": string[], "recommendations": string[]}\n\n` +
    `Rules:\n` +
    `- findings: at most 3 short sentences. Prioritize the largest percentage changes or a metric ` +
    `moving in an unfavorable direction; include at most one positive finding when the data shows a ` +
    `clear improvement, only if it still fits within the 3-finding limit. Cite the actual ` +
    `current/previous value or delta_pct from the input in each one.\n` +
    `- recommendations: at most 3 short, actionable sentences, each tied to a specific finding above ` +
    `and grounded only in the input's numbers — never invent a fact or number not present in it. ` +
    `Return an empty array if nothing in the data warrants a recommendation.\n` +
    `- If a metric's current_value or previous_value is null, say so explicitly instead of ` +
    `guessing a number.\n` +
    arabicRules +
    `- If metrics is empty, respond with {"findings": ["<one sentence in ${languageName} saying no ` +
    `metrics were provided for this period>"], "recommendations": []}.\n` +
    `- Every number you write must exactly match a number present in the input JSON.`
  );
}

// ----------------------------------------------------------------------------
// ANALYZE output validation — checked after JSON.parse succeeds, for BOTH the primary provider's
// output and any fallback's (taskRunner.ts applies this uniformly regardless of which one actually
// answered). Also does the whitespace/punctuation cleanup a live test surfaced (e.g. "37% ."):
// stray space before a percent sign or before sentence punctuation, and repeated whitespace.
// ----------------------------------------------------------------------------
function cleanText(text: string): string {
  return text
    .replace(/\s+%/g, '%')
    .replace(/\s+([.,،؛؟!:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function validateBriefAnalyzeOutput(parsed: unknown): StageValidationResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  const p = parsed as Record<string, unknown>;
  if (!isStringArray(p.findings) || !isStringArray(p.recommendations)) return { ok: false };
  return {
    ok: true,
    value: {
      findings: p.findings.slice(0, 3).map(cleanText),
      recommendations: p.recommendations.slice(0, 3).map(cleanText),
    },
  };
}

function validateDetailedAnalyzeOutput(parsed: unknown): StageValidationResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  const p = parsed as Record<string, unknown>;
  const rawByService = p.by_service;
  if (!isNonEmptyString(p.summary) || !Array.isArray(rawByService) || !isStringArray(p.recommendations)) {
    return { ok: false };
  }
  const byService: { service: string; text: string }[] = [];
  for (const entry of rawByService) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false };
    const e = entry as Record<string, unknown>;
    if (typeof e.service !== 'string' || !(CAMPAIGN_SUMMARY_SERVICES as readonly string[]).includes(e.service)) {
      return { ok: false };
    }
    if (!isNonEmptyString(e.text)) return { ok: false };
    byService.push({ service: e.service, text: cleanText(e.text) });
  }
  return {
    ok: true,
    value: {
      summary: cleanText(p.summary),
      by_service: byService.slice(0, 3),
      recommendations: p.recommendations.slice(0, 5).map(cleanText),
    },
  };
}

function validateAnalyzeOutput(parsed: unknown, detail: DetailLevel): StageValidationResult {
  return detail === 'detailed' ? validateDetailedAnalyzeOutput(parsed) : validateBriefAnalyzeOutput(parsed);
}

// ----------------------------------------------------------------------------
// UNIFIED_CLIENT_REPORT (combined-scope item D): a single, cohesively-written narrative
// synthesizing ALL of a client's active services together — deliberately NOT per-service
// paragraphs (that's exactly what CAMPAIGN_SUMMARY's 'detailed' by_service already does). Shares
// CAMPAIGN_SUMMARY's input shape/allowlist/validation verbatim (validateCampaignSummaryPayload,
// buildAnalyzeInput below in the registry entry) — the input here is the same already-verified,
// already-computed numeric JSON, just potentially spanning more services in one payload; no
// EXTRACT-equivalent stage is needed for the same reason CAMPAIGN_SUMMARY's own EXTRACT was
// removed (no real parsing work for a model to do). Only reachable, client-side, by a client's own
// assigned AM Agent (client.am_agent_id === currentUser.id) — see ClientDashboard.tsx.
// ----------------------------------------------------------------------------
export interface UnifiedClientReportOutput {
  narrative: string;
  recommendations: string[];
}

// No 'detail' concept for this task (single fixed output shape) — the function signature still
// takes it since taskRunner.ts calls every registry task's stage functions uniformly regardless of
// task; a request's detail (defaulted to 'brief' when unset, same as any other task) is simply
// ignored here.
function buildUnifiedReportSystemPrompt(language: SupportedLanguage): string {
  const languageName = LANGUAGE_NAMES[language];
  const arabicRules = buildArabicQualityRules(language);
  return (
    `You are the agency's own account lead writing a single, unified performance report directly ` +
    `to this client, covering every service they subscribe to together as ONE coherent story — ` +
    `never as separate, isolated sections per service. You will receive a JSON object of ` +
    `already-verified metrics comparing two periods (service, metric, current_value, ` +
    `previous_value, delta_pct, unit) across whichever services are present. Analyze ONLY this ` +
    `data — never invent, estimate, or reference any number, client, platform, or fact that is not ` +
    `present in it.\n\n` +
    `Voice: professional and data-grounded, written as this agency's own account lead speaking ` +
    `directly to the client. Confident but not exaggerated — no marketing fluff, no filler ` +
    `adjectives. Concise sentences. Every claim must be traceable to a specific number in the ` +
    `input.\n\n` +
    `Write in ${languageName}, using simple, professional wording suitable for a client-facing ` +
    `report. Metric names (e.g. ROAS, CPA) may stay in English even inside a ${languageName} ` +
    `sentence.\n\n` +
    `Respond with ONLY this JSON object — no markdown code fences, no explanation:\n` +
    `{"narrative": string, "recommendations": string[]}\n\n` +
    `Rules:\n` +
    `- narrative: 3 to 6 sentences telling ONE coherent story across every service present — never ` +
    `separate paragraphs per service. At least one sentence MUST explicitly connect a finding in ` +
    `one service to a finding in a different service (e.g. spend vs. engagement, delivery pace vs. ` +
    `performance) — a purely per-service enumeration, with no such connection, is not acceptable.\n` +
    `- recommendations: at most 5 short, actionable sentences, ordered by priority (most important ` +
    `first), grounded only in the input's numbers — never invent a fact or number not present in ` +
    `it. Return an empty array if nothing in the data warrants a recommendation.\n` +
    `- If a metric's current_value or previous_value is null, say so explicitly instead of ` +
    `guessing a number.\n` +
    arabicRules +
    `- If metrics is empty, respond with {"narrative": "<one sentence in ${languageName} saying no ` +
    `metrics were provided for this period>", "recommendations": []}.\n` +
    `- Every number you write must exactly match a number present in the input JSON.`
  );
}

function validateUnifiedReportOutput(parsed: unknown): StageValidationResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  const p = parsed as Record<string, unknown>;
  if (!isNonEmptyString(p.narrative) || !isStringArray(p.recommendations)) return { ok: false };
  return {
    ok: true,
    value: {
      narrative: cleanText(p.narrative),
      recommendations: p.recommendations.slice(0, 5).map(cleanText),
    },
  };
}

// ----------------------------------------------------------------------------
// The registry itself
// ----------------------------------------------------------------------------
export const TASK_REGISTRY: Record<string, TaskDefinition> = {
  CAMPAIGN_SUMMARY: {
    name: 'CAMPAIGN_SUMMARY',
    buildInitialInput: (rawPayload) => buildAnalyzeInput(validateCampaignSummaryPayload(rawPayload)),
    // Single stage — see this file's header comment for why EXTRACT was removed for this task
    // specifically (it did no real parsing work) rather than being a structural limit: a future
    // task with genuinely messy input defines its own two-(or more-)stage TaskDefinition the same
    // way this one is defined.
    stages: [
      {
        name: 'ANALYZE',
        // Default groq -> gemini -> openrouter; override with CAMPAIGN_SUMMARY_ANALYZE_ORDER (see
        // that env var's parsing logic above this registry for validation/fail-closed behavior).
        providers: getAnalyzeProviderOrder,
        systemPrompt: buildAnalyzeSystemPrompt,
        // 'detailed' needs real headroom (summary + up to 3 by_service paragraphs + up to 5
        // recommendations, plus Groq's own reasoning overhead) — see the commit/report for the
        // full token-budget arithmetic against Groq's 8,000 TPM free-tier cap. 'brief' is
        // unchanged from before "detailed" existed. Applied uniformly to whichever provider in
        // the order above actually serves the request, including Gemini — flagged in the commit
        // report as an unverified risk specifically for Gemini (thinking-token behavior could not
        // be confirmed against Google's official docs, blocked in this sandbox).
        maxOutputTokens: (detail) => (detail === 'detailed' ? 3000 : 1500),
        outputFormat: 'json',
        validateOutput: validateAnalyzeOutput,
      },
    ],
  },
  UNIFIED_CLIENT_REPORT: {
    name: 'UNIFIED_CLIENT_REPORT',
    // Identical input handling to CAMPAIGN_SUMMARY — same allowlist, same delta_pct computed in
    // code, never asked of a model (see buildAnalyzeInput's own comment above).
    buildInitialInput: (rawPayload) => buildAnalyzeInput(validateCampaignSummaryPayload(rawPayload)),
    stages: [
      {
        name: 'ANALYZE',
        // Fixed default order, not configurable via its own env var for this phase (no separate
        // ask for that) — same providers/fallback order CAMPAIGN_SUMMARY defaults to.
        providers: () => ['groq', 'gemini', 'openrouter'],
        systemPrompt: (language) => buildUnifiedReportSystemPrompt(language),
        // ~4000 tokens: a genuine cross-service narrative (3-6 sentences weaving multiple
        // services together, per the system prompt) plus up to 5 recommendations needs more room
        // than CAMPAIGN_SUMMARY's single-service 'detailed' cap (3000). Input size is unchanged
        // from CAMPAIGN_SUMMARY's own (same metrics payload, same allowlist), so worst case is
        // roughly 225 (system prompt) + 150 (input) + 4000 (output) ≈ 4400 tokens — still
        // comfortably under Groq's 8,000 TPM free-tier limit.
        maxOutputTokens: () => 4000,
        outputFormat: 'json',
        validateOutput: (parsed) => validateUnifiedReportOutput(parsed),
      },
    ],
  },
};
