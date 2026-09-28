// Shared types for every provider adapter under ./providers/, and for the Phase 2 Task Registry
// (taskRegistry.ts) / runner (taskRunner.ts). Still no rotation/cooldown state or usage logging
// (Phases 3-4) — see index.ts's header comment.

export type AiProvider = 'gemini' | 'groq' | 'openrouter';

export interface AiCallInput {
  prompt: string;
  systemPrompt?: string;
  // Per-stage cap from the Task Registry (undefined for the Phase 1 PHASE1_TEST_* path, which
  // has no registry entry to read one from). Each adapter sends this under whichever field name
  // its own API expects.
  maxOutputTokens?: number;
}

// Raw rate-limit-related response headers, surfaced exactly as the provider returned them — no
// parsing, unit conversion, or interpretation here. Names and shapes differ by provider:
//  - Groq sends all six on every response (not just 429s), split into requests vs tokens, with
//    reset values as DURATION strings ("2m59.56s", "14h12m"), not absolute timestamps.
//  - OpenRouter sends only Limit/Remaining/Reset, and only on an already-rate-limited response —
//    a successful call carries no rate-limit headers at all.
//  - Gemini's REST API does not document per-request rate-limit headers; only `retryAfter` (a
//    generic, widely-used HTTP convention) is opportunistically captured there.
// Turning these into a concrete rate_limited_until timestamp is the Phase 3 router's job, once
// ai_provider_state exists to record it against — per the confirmed policy, provider-reported
// state is the source of truth for availability; this repo's own usage counting is observability
// only, never itself the gate.
export interface RateLimitHeaders {
  limitRequests?: string;
  remainingRequests?: string;
  resetRequests?: string;
  limitTokens?: string;
  remainingTokens?: string;
  resetTokens?: string;
  retryAfter?: string;
}

export interface AiCallSuccess {
  text: string;
  provider: AiProvider;
  model: string;
  rateLimitHeaders?: RateLimitHeaders;
}

export type AiErrorKind = 'rate_limit' | 'error';
// Best-effort classification, kept alongside the raw headers above (not a replacement for them):
// useful only where a provider's own response actually identifies which limit was hit (e.g. Groq's
// remaining-requests vs remaining-tokens headers hitting zero). 'unknown' is the honest answer when
// nothing in the response says which limit fired — never guess 'rpm' as a default; a wrong guess
// here means the Phase 3 router either retries too soon against a still-exhausted daily quota, or
// waits a full day against a limit that would have reset in a minute. Prefer a provider-specific
// field over this whenever one exists (see AiProviderError.limitSource for OpenRouter).
export type AiRateLimitReason = 'rpm' | 'rpd' | 'tpm' | 'unknown';

export class AiProviderError extends Error {
  kind: AiErrorKind;
  reason?: AiRateLimitReason;
  statusCode?: number;
  rateLimitHeaders?: RateLimitHeaders;
  // OpenRouter-specific: its 429 body's `limit_source` (e.g. "upstream_provider_shared_pool")
  // distinguishes a shared-pool limit (often clears in seconds, safe to retry soon) from the
  // account's own daily cap (won't clear until the provider's reset) — a more specific signal than
  // the generic rpm/rpd/tpm taxonomy above, so it's kept as its own field rather than forced into
  // `reason`.
  limitSource?: string;

  constructor(
    kind: AiErrorKind,
    message: string,
    opts?: { reason?: AiRateLimitReason; statusCode?: number; rateLimitHeaders?: RateLimitHeaders; limitSource?: string }
  ) {
    super(message);
    this.kind = kind;
    this.reason = opts?.reason;
    this.statusCode = opts?.statusCode;
    this.rateLimitHeaders = opts?.rateLimitHeaders;
    this.limitSource = opts?.limitSource;
  }
}
