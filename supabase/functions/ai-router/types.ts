// Shared types for every provider adapter under ./providers/. Phase 1 only — no Task Registry,
// no rotation/cooldown state, no usage logging yet (see index.ts's header comment).

export type AiProvider = 'gemini' | 'groq' | 'openrouter';

export interface AiCallInput {
  prompt: string;
  systemPrompt?: string;
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
// useful where a provider's headers don't cleanly separate requests-per-minute from
// requests-per-day (Gemini), so the Phase 3 router still has something to key a cooldown off of.
// An adapter that can't tell which kind a given 429 was should pick 'rpm' (the shorter cooldown)
// — retrying a few seconds too early and getting another 429 is a cheap mistake; waiting a full
// day when only a minute was needed is not.
export type AiRateLimitReason = 'rpm' | 'rpd' | 'tpm';

export class AiProviderError extends Error {
  kind: AiErrorKind;
  reason?: AiRateLimitReason;
  statusCode?: number;
  rateLimitHeaders?: RateLimitHeaders;

  constructor(
    kind: AiErrorKind,
    message: string,
    opts?: { reason?: AiRateLimitReason; statusCode?: number; rateLimitHeaders?: RateLimitHeaders }
  ) {
    super(message);
    this.kind = kind;
    this.reason = opts?.reason;
    this.statusCode = opts?.statusCode;
    this.rateLimitHeaders = opts?.rateLimitHeaders;
  }
}
