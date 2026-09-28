// Shared types for every provider adapter under ./providers/. Phase 1 only — no Task Registry,
// no rotation/cooldown state, no usage logging yet (see index.ts's header comment).

export type AiProvider = 'gemini' | 'grok';

export interface AiCallInput {
  prompt: string;
  systemPrompt?: string;
}

export interface AiCallSuccess {
  text: string;
  provider: AiProvider;
  model: string;
}

export type AiErrorKind = 'rate_limit' | 'error';
// Governs cooldown duration once the Phase 3 router owns retry timing: rpm/tpm reset in roughly a
// minute, rpd resets on the provider's next daily boundary. An adapter that can't tell which kind
// a given 429 was should pick 'rpm' (the shorter cooldown) — retrying a few seconds too early and
// getting another 429 is a cheap mistake; waiting a full day when only a minute was needed is not.
export type AiRateLimitReason = 'rpm' | 'rpd' | 'tpm';

export class AiProviderError extends Error {
  kind: AiErrorKind;
  reason?: AiRateLimitReason;
  statusCode?: number;

  constructor(kind: AiErrorKind, message: string, opts?: { reason?: AiRateLimitReason; statusCode?: number }) {
    super(message);
    this.kind = kind;
    this.reason = opts?.reason;
    this.statusCode = opts?.statusCode;
  }
}
