// Phase 2: the Task Registry. Every task is a plain data entry (name, ordered stages, each with a
// provider/fallback/system prompt/max output tokens/expected output format) — adding a 5th task
// later means adding an entry here, never touching taskRunner.ts's execution logic or index.ts's
// dispatch. PHASE1_TEST_* in index.ts is untouched and does not go through this registry at all.
//
// Generic EXTRACT_CLIENT_DATA/ANALYZE_CLIENT_DATA task names from the original design were folded
// directly into CAMPAIGN_SUMMARY's own two stages instead of being kept as separate top-level
// registry entries: the part that's actually reusable across future tasks is the two-stage
// runner/fallback mechanism (already generic in taskRunner.ts), not the prompts or schemas
// themselves — a future task's EXTRACT prompt will look nothing like this one's, so a shared
// "EXTRACT_CLIENT_DATA" entry would just be dead weight, not a real building block.
import { AiProvider } from './types.ts';

export type SupportedLanguage = 'ar' | 'en';
export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = { ar: 'Arabic', en: 'English' };
export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return value === 'ar' || value === 'en';
}

export interface TaskStageDefinition {
  name: string;
  provider: AiProvider;
  fallbackProvider?: AiProvider;
  systemPrompt: (language: SupportedLanguage) => string;
  maxOutputTokens: number;
  outputFormat: 'json' | 'text';
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

const PERIOD_LABEL_RE = /^\d{4}-\d{2}$/; // matches reportingEngine.ts's "YYYY-MM" period label format
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
    throw new Error('period_current must be a "YYYY-MM" string.');
  }
  if (p.period_previous !== null && p.period_previous !== undefined
    && (typeof p.period_previous !== 'string' || !PERIOD_LABEL_RE.test(p.period_previous))) {
    throw new Error('period_previous must be a "YYYY-MM" string or null.');
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

// Percentage change is computed here, in code, never asked of a model: it's trivial arithmetic,
// and trusting a small/fast free-tier model to get it right every time would be a needless,
// avoidable source of hallucinated numbers in a system whose entire point is "every number must
// come from the input." EXTRACT's job (see its system prompt below) is therefore reformatting and
// filtering only, never arithmetic.
function withDeltaPct(payload: CampaignSummaryPayload): unknown {
  return {
    period_current: payload.period_current,
    period_previous: payload.period_previous,
    metrics: payload.metrics.map((m) => ({
      ...m,
      delta_pct:
        m.current_value !== null && m.previous_value !== null && m.previous_value !== 0
          ? Math.round(((m.current_value - m.previous_value) / m.previous_value) * 1000) / 10
          : null,
    })),
  };
}

// ----------------------------------------------------------------------------
// CAMPAIGN_SUMMARY prompts
// ----------------------------------------------------------------------------

// Stage 1 (EXTRACT, Gemini primary / Groq fallback). Deliberately thin for this specific task:
// because validateCampaignSummaryPayload() above already guarantees clean, well-typed input before
// any model ever sees it, there is no messy data here for an LLM to genuinely parse — its real job
// is a single mechanical filtering decision (drop metrics with nothing to report) plus faithful
// passthrough. This is an honest, deliberately modest use of the stage for this task; it still
// exercises the real two-stage/fallback pipeline end-to-end, and will carry more actual weight for
// a future task whose input isn't pre-validated structured JSON (e.g. free-text notes).
const EXTRACT_SYSTEM_PROMPT =
  'You are a data-formatting step in an internal agency reporting pipeline. You will receive a JSON ' +
  'object with period_current, period_previous, and a metrics array. Copy it into the exact same ' +
  'JSON shape, with one rule: remove any metric object where both current_value and previous_value ' +
  'are null (nothing to report). Do not change, round, add, or invent any value. Do not add or ' +
  'remove any field on period_current, period_previous, or a kept metric. Do not add any metric ' +
  'that is not already present. Respond with ONLY the JSON object — no markdown code fences, no ' +
  'explanation, no extra text before or after it.';

// Stage 2 (ANALYZE, Groq primary / OpenRouter fallback).
function buildAnalyzeSystemPrompt(language: SupportedLanguage): string {
  const languageName = LANGUAGE_NAMES[language];
  return (
    `You are a marketing performance analyst writing for an internal agency dashboard. You will ` +
    `receive a JSON object of already-verified metrics comparing two periods (service, metric, ` +
    `current_value, previous_value, delta_pct, unit). Analyze ONLY this data — never invent, ` +
    `estimate, or reference any number, client, platform, or fact that is not present in it.\n\n` +
    `Write in ${languageName}, using simple, professional wording suitable for a short business ` +
    `report. Metric names (e.g. ROAS, CPA) may stay in English even inside a ${languageName} sentence.\n\n` +
    `Respond with ONLY this JSON object — no markdown code fences, no explanation:\n` +
    `{"findings": string[], "recommendations": string[]}\n\n` +
    `Rules:\n` +
    `- findings: at most 3 short sentences. Prioritize the largest percentage changes or a metric ` +
    `moving in an unfavorable direction. Cite the actual current/previous value or delta_pct from ` +
    `the input in each one.\n` +
    `- recommendations: at most 3 short, actionable sentences, each grounded in a finding above. ` +
    `Return an empty array if nothing in the data warrants a recommendation — do not invent one.\n` +
    `- If a metric's current_value or previous_value is null, say so explicitly instead of ` +
    `guessing a number.\n` +
    `- If metrics is empty, respond with {"findings": ["<one sentence in ${languageName} saying no ` +
    `metrics were provided for this period>"], "recommendations": []}.\n` +
    `- Every number you write must exactly match a number present in the input JSON.`
  );
}

// ----------------------------------------------------------------------------
// The registry itself
// ----------------------------------------------------------------------------
export const TASK_REGISTRY: Record<string, TaskDefinition> = {
  CAMPAIGN_SUMMARY: {
    name: 'CAMPAIGN_SUMMARY',
    buildInitialInput: (rawPayload) => withDeltaPct(validateCampaignSummaryPayload(rawPayload)),
    stages: [
      {
        name: 'EXTRACT',
        provider: 'gemini',
        fallbackProvider: 'groq',
        systemPrompt: () => EXTRACT_SYSTEM_PROMPT,
        // Groq's own free-tier reasoning overhead was observed at ~423 tokens for a trivial
        // one-word reply (unconfirmed root cause: likely gpt-oss's internal reasoning pass before
        // the visible answer) — sized to cover that overhead plus this stage's actual JSON output
        // if EXTRACT falls back to Groq, comfortably under its 8,000 TPM cap for one call.
        maxOutputTokens: 1200,
        outputFormat: 'json',
      },
      {
        name: 'ANALYZE',
        provider: 'groq',
        fallbackProvider: 'openrouter',
        systemPrompt: buildAnalyzeSystemPrompt,
        maxOutputTokens: 1500,
        outputFormat: 'json',
      },
    ],
  },
};
