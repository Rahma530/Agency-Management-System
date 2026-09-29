// Gemini adapter — plain REST against generativelanguage.googleapis.com, deliberately not the
// @google/genai SDK (already a dead, unused dependency in package.json per this session's AI-Layer
// audit). Every existing Edge Function in this repo imports only @supabase/supabase-js via a
// npm: specifier; @google/genai pulls in google-auth-library/protobufjs/ws — heavier
// Node-oriented machinery built for OAuth/service-account flows this single-API-key call doesn't
// need, and an unverified risk in Deno's npm compat layer for no benefit here. Groq/OpenRouter are
// both plain OpenAI-compatible REST too (see ../providers/openaiCompatible.ts) — this keeps every
// adapter the same shape.
import { AiCallInput, AiCallSuccess, AiProviderError } from '../types.ts';
import { sanitizeProviderErrorBody } from './sanitize.ts';

// No hardcoded default (unlike Phase 1's original gemini-2.5-flash): Google removed that model for
// new users during Phase 2's build (a live 404 confirmed against the real deployed function, not
// assumed), and free-tier model names/quotas have already changed multiple times in 2026 — GROQ_
// MODEL/OPENROUTER_MODEL already fail closed the same way for the same reason. Set GEMINI_MODEL to
// a current free-tier model id from Google's live docs before use.
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') || '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';

export async function callGemini(input: AiCallInput): Promise<AiCallSuccess> {
  if (!GEMINI_API_KEY) throw new AiProviderError('error', 'GEMINI_API_KEY is not configured.');
  if (!GEMINI_MODEL) {
    throw new AiProviderError('error', 'GEMINI_MODEL is not configured — set it to a current free-tier model id from Gemini\'s live docs before use.');
  }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
  };
  if (input.systemPrompt) {
    body.systemInstruction = { parts: [{ text: input.systemPrompt }] };
  }
  if (input.maxOutputTokens) {
    body.generationConfig = { maxOutputTokens: input.maxOutputTokens };
  }

  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AiProviderError('error', `Gemini request failed before a response: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Gemini's REST API doesn't document per-request rate-limit headers the way Groq/OpenRouter do;
  // only `retry-after` (a generic, widely-used HTTP convention) is opportunistically captured —
  // harmless to read even if Google doesn't actually send it.
  const rateLimitHeaders = { retryAfter: res.headers.get('retry-after') ?? undefined };

  if (res.status === 429) {
    const detail = sanitizeProviderErrorBody(await res.text().catch(() => ''), [GEMINI_API_KEY]).slice(0, 300);
    // Gemini's REST API has no documented header or body field that identifies which limit (RPM,
    // RPD, TPM) actually fired — 'unknown' is the honest answer, not a guessed 'rpm' default; see
    // AiRateLimitReason's comment in types.ts for why guessing wrong here is worse than admitting
    // we don't know.
    throw new AiProviderError('rate_limit', `Gemini rate limit hit: ${detail}`, { reason: 'unknown', statusCode: 429, rateLimitHeaders });
  }
  if (!res.ok) {
    const detail = sanitizeProviderErrorBody(await res.text().catch(() => ''), [GEMINI_API_KEY]).slice(0, 300);
    throw new AiProviderError('error', `Gemini request failed (HTTP ${res.status}): ${detail}`, {
      statusCode: res.status,
      rateLimitHeaders,
    });
  }

  const data = await res.json().catch(() => null);
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p: { text?: string }) => p.text || '')
    .join('');
  if (!text) throw new AiProviderError('error', 'Gemini returned no usable text.');

  // usageMetadata's field names are confirmed from real captured responses this session (Phase 1/2
  // live testing), not a first-hand read of Google's docs (blocked by this sandbox's egress
  // proxy) — thoughtsTokenCount is only present at all when the model actually used thinking
  // tokens, so it's left undefined rather than 0 when absent.
  const usage = data?.usageMetadata;
  return {
    text,
    provider: 'gemini',
    model: GEMINI_MODEL,
    rateLimitHeaders,
    inputTokens: typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : undefined,
    outputTokens: typeof usage?.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : undefined,
    totalTokens: typeof usage?.totalTokenCount === 'number' ? usage.totalTokenCount : undefined,
    thoughtsTokens: typeof usage?.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : undefined,
  };
}
