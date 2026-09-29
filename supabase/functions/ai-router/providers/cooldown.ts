// Phase 3: rate-limit cooldown memory against public.ai_provider_state. This is NOT the source of
// truth for whether a provider's quota has actually reset — only the provider's own next response
// tells us that for certain — it's an in-between guess to avoid needlessly retrying a
// provider:model combination this router already knows was exhausted moments ago. Written only on
// a genuine 429 (see taskRunner.ts's runStage); never touched on success or on a non-429 error.
import { createClient } from 'npm:@supabase/supabase-js@2.114.0';
import { AiProvider, AiRateLimitReason, RateLimitHeaders } from '../types.ts';

type AdminClient = ReturnType<typeof createClient>;

export interface ProviderCandidate {
  provider: AiProvider;
  model: string;
}

// Matches ai_provider_state.id exactly.
export function cooldownId(candidate: ProviderCandidate): string {
  return `${candidate.provider}:${candidate.model}`;
}

// One batched query for every candidate a stage might try, instead of one round trip per
// provider. A query failure fails OPEN (returns an empty set, so every candidate is attempted as
// usual): this is a cost-avoidance optimization, not a safety gate, so a DB hiccup should never
// stop the router from making a real provider call it would otherwise have made.
export async function checkCooldowns(admin: AdminClient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await admin
    .from('ai_provider_state')
    .select('id')
    .in('id', ids)
    .gt('cooldown_until', new Date().toISOString());
  if (error) {
    console.error('ai-router checkCooldowns query failed:', error.message);
    return new Set();
  }
  return new Set(((data ?? []) as { id: string }[]).map((row) => row.id));
}

// Groq's own reset-requests/reset-tokens headers are duration strings observed in the shapes
// "2m59.56s" and "14h12m" — inferred from a handful of real captured responses this session, not a
// documented format spec (console.groq.com is blocked by this sandbox's network egress proxy).
// Returns null (never throws) on anything that doesn't match, so a real-world shape this regex
// didn't anticipate falls back to the flat/UTC-midnight defaults below rather than breaking
// cooldown recording entirely.
const DURATION_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/;

function parseDurationSeconds(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = DURATION_RE.exec(raw.trim());
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

const FLAT_COOLDOWN_SECONDS = 60;

function msUntilUtcMidnight(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return midnight - now.getTime();
}

export interface CooldownInput {
  provider: AiProvider;
  model: string;
  reason?: AiRateLimitReason;
  limitSource?: string;
  rateLimitHeaders?: RateLimitHeaders;
}

// How long to hold a provider:model in cooldown after a genuine 429. Prefers the provider's own
// reported reset window when one exists to parse (only Groq sends this, on every response,
// including the 429 itself); everything else — Gemini and OpenRouter, and Groq's own 'rpm'/
// 'unknown' reasons — falls back to a flat guess, since nothing in their responses says when the
// limit actually clears.
export function computeCooldownDurationMs(input: CooldownInput): number {
  if (input.provider === 'groq') {
    if (input.reason === 'tpm') {
      const parsed = parseDurationSeconds(input.rateLimitHeaders?.resetTokens);
      if (parsed !== null) return parsed * 1000;
    }
    if (input.reason === 'rpd') {
      const parsed = parseDurationSeconds(input.rateLimitHeaders?.resetRequests);
      if (parsed !== null) return parsed * 1000;
      // Groq virtually always sends resetRequests on every response — this UTC-midnight fallback
      // is a rarely-exercised safety net for the rare case it's missing or unparsable, not the
      // primary path for a daily-limit cooldown. Also uses UTC, which may not exactly match
      // Groq's actual daily-reset timezone — unverified, flagged in the Phase 3 report.
      return msUntilUtcMidnight();
    }
  }
  return FLAT_COOLDOWN_SECONDS * 1000;
}

// Never throws: a logging/state-write failure here must not turn an otherwise-successful AI
// response into a failed request. Call sites (taskRunner.ts, index.ts) still await this, since
// Deno Edge Functions can kill unawaited work once the response has been returned.
export async function recordCooldown(admin: AdminClient, input: CooldownInput): Promise<void> {
  try {
    const id = cooldownId(input);
    const durationMs = computeCooldownDurationMs(input);
    const nowIso = new Date().toISOString();
    const { error } = await admin.from('ai_provider_state').upsert({
      id,
      provider: input.provider,
      model: input.model,
      cooldown_until: new Date(Date.now() + durationMs).toISOString(),
      reason: input.limitSource ?? input.reason ?? null,
      last_hit_at: nowIso,
      updated_at: nowIso,
    });
    if (error) console.error('ai-router recordCooldown upsert failed:', error.message);
  } catch (err) {
    console.error('ai-router recordCooldown threw:', err instanceof Error ? err.message : String(err));
  }
}
