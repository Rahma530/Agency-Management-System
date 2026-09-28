// Generic adapter for any OpenAI-compatible chat-completions endpoint — used for both Groq
// (analysis stage, primary) and OpenRouter free models (analysis stage, emergency fallback only:
// its free tier is roughly 50 requests/day unless the account has purchased credits). One adapter,
// parameterized by base URL/API-key env var/model env var, rather than near-duplicate files, since
// the request/response shape is identical for both.
//
// Model names are NOT hardcoded with a fallback default here, unlike Gemini's adapter: this
// session's research hit contradicting secondary sources on which models are currently free on
// Groq (older sources still list Llama 3.1/3.3, which other, more specific findings say were
// removed from Groq's free tier in August 2026), and this sandbox's network egress proxy blocks
// direct access to both console.groq.com and openrouter.ai, so their live docs could not be read
// first-hand to settle it. Rather than ship a guessed model string that may 404 or silently route
// to a paid/unavailable model, GROQ_MODEL/OPENROUTER_MODEL are REQUIRED env vars — deploying this
// fails closed with a clear error until someone checks each provider's current free-model list
// live and sets the exact id.
import { AiCallInput, AiCallSuccess, AiProvider, AiProviderError, AiRateLimitReason, RateLimitHeaders } from '../types.ts';
import { sanitizeProviderErrorBody } from './sanitize.ts';

export interface OpenAiCompatibleConfig {
  provider: Extract<AiProvider, 'groq' | 'openrouter'>;
  baseUrl: string;
  apiKeyEnvVar: string;
  modelEnvVar: string;
}

// limit_source's existence and value were confirmed against a real captured OpenRouter 429 (per
// the field names reported from live testing); its exact nesting under error.metadata is this
// adapter's best-effort match to OpenRouter's typical error envelope shape, not itself verified
// against an official schema — the two fallback locations checked below exist in case that
// nesting isn't always consistent. Returns undefined (never throws) if the body isn't JSON or
// doesn't contain the field at all, which is the normal case for Groq.
function extractLimitSource(rawText: string): string | undefined {
  try {
    const parsed = JSON.parse(rawText);
    const candidate = parsed?.error?.metadata?.limit_source ?? parsed?.error?.limit_source ?? parsed?.limit_source;
    return typeof candidate === 'string' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

// Groq's own documented header semantics let us tell which limit actually fired:
// remaining-requests counts down a DAILY allowance, remaining-tokens a per-minute rolling window
// — so whichever hit exactly zero identifies the limit. OpenRouter's headers are a single generic
// Limit/Remaining/Reset with no requests-vs-tokens split, so there's nothing here to safely
// attribute to rpm/rpd/tpm for it — 'unknown' is the honest answer there, and extractLimitSource
// above carries OpenRouter's actual, more specific signal instead.
function inferRateLimitReason(config: OpenAiCompatibleConfig, headers: RateLimitHeaders): AiRateLimitReason {
  if (config.provider === 'groq') {
    if (headers.remainingRequests === '0') return 'rpd';
    if (headers.remainingTokens === '0') return 'tpm';
  }
  return 'unknown';
}

// Checked defensively regardless of which provider this call is for — reading a header that
// provider doesn't send is harmless (Headers.get returns null), and keeping one extraction
// function avoids per-provider branching for what's ultimately just header-name bookkeeping.
function extractRateLimitHeaders(headers: Headers): RateLimitHeaders {
  const get = (name: string) => headers.get(name) ?? undefined;
  return {
    // Groq's names (sent on every response, not just 429s) take priority; OpenRouter's generic
    // Limit/Remaining/Reset names (only present on an already-rate-limited response) fill the same
    // requests-limit slots when Groq's own headers aren't present.
    limitRequests: get('x-ratelimit-limit-requests') ?? get('X-RateLimit-Limit'),
    remainingRequests: get('x-ratelimit-remaining-requests') ?? get('X-RateLimit-Remaining'),
    resetRequests: get('x-ratelimit-reset-requests') ?? get('X-RateLimit-Reset'),
    limitTokens: get('x-ratelimit-limit-tokens'),
    remainingTokens: get('x-ratelimit-remaining-tokens'),
    resetTokens: get('x-ratelimit-reset-tokens'),
    retryAfter: get('retry-after'),
  };
}

export async function callOpenAiCompatible(
  config: OpenAiCompatibleConfig,
  input: AiCallInput
): Promise<AiCallSuccess> {
  const apiKey = Deno.env.get(config.apiKeyEnvVar) || '';
  const model = Deno.env.get(config.modelEnvVar) || '';
  if (!apiKey) throw new AiProviderError('error', `${config.apiKeyEnvVar} is not configured.`);
  if (!model) {
    throw new AiProviderError(
      'error',
      `${config.modelEnvVar} is not configured — set it to a current free model id from ${config.provider}'s live docs before use.`
    );
  }

  const messages: { role: string; content: string }[] = [];
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
  messages.push({ role: 'user', content: input.prompt });

  let res: Response;
  try {
    res = await fetch(config.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages }),
    });
  } catch (err) {
    throw new AiProviderError(
      'error',
      `${config.provider} request failed before a response: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const rateLimitHeaders = extractRateLimitHeaders(res.headers);

  if (res.status === 429) {
    const rawText = await res.text().catch(() => '');
    const limitSource = extractLimitSource(rawText);
    const detail = sanitizeProviderErrorBody(rawText, [apiKey]).slice(0, 300);
    throw new AiProviderError('rate_limit', `${config.provider} rate limit hit: ${detail}`, {
      reason: inferRateLimitReason(config, rateLimitHeaders),
      statusCode: 429,
      rateLimitHeaders,
      limitSource,
    });
  }
  if (!res.ok) {
    const detail = sanitizeProviderErrorBody(await res.text().catch(() => ''), [apiKey]).slice(0, 300);
    throw new AiProviderError('error', `${config.provider} request failed (HTTP ${res.status}): ${detail}`, {
      statusCode: res.status,
      rateLimitHeaders,
    });
  }

  const data = await res.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new AiProviderError('error', `${config.provider} returned no usable text.`);

  return { text, provider: config.provider, model, rateLimitHeaders };
}
