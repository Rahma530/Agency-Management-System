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
import { AiCallInput, AiCallSuccess, AiProvider, AiProviderError, RateLimitHeaders } from '../types.ts';

export interface OpenAiCompatibleConfig {
  provider: Extract<AiProvider, 'groq' | 'openrouter'>;
  baseUrl: string;
  apiKeyEnvVar: string;
  modelEnvVar: string;
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
    throw new AiProviderError('rate_limit', `${config.provider} rate limit hit.`, {
      reason: 'rpm',
      statusCode: 429,
      rateLimitHeaders,
    });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AiProviderError('error', `${config.provider} request failed (HTTP ${res.status}): ${detail.slice(0, 300)}`, {
      statusCode: res.status,
      rateLimitHeaders,
    });
  }

  const data = await res.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new AiProviderError('error', `${config.provider} returned no usable text.`);

  return { text, provider: config.provider, model, rateLimitHeaders };
}
