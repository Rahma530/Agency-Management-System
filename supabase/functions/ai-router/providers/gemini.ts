// Gemini adapter — plain REST against generativelanguage.googleapis.com, deliberately not the
// @google/genai SDK (already a dead, unused dependency in package.json per this session's AI-Layer
// audit). Every existing Edge Function in this repo imports only @supabase/supabase-js via a
// npm: specifier; @google/genai pulls in google-auth-library/protobufjs/ws — heavier
// Node-oriented machinery built for OAuth/service-account flows this single-API-key call doesn't
// need, and an unverified risk in Deno's npm compat layer for no benefit here. Groq/OpenRouter are
// both plain OpenAI-compatible REST too (see ../providers/openaiCompatible.ts) — this keeps every
// adapter the same shape.
import { AiCallInput, AiCallSuccess, AiProviderError } from '../types.ts';

// Verify against Google's current free-tier model list before relying on this default — free-tier
// model names and quotas already changed twice in 2026 (a 50-80% quota cut in Dec 2025, Pro models
// dropped from the free tier entirely in April 2026). Override via GEMINI_MODEL without a redeploy
// if this drifts.
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';

export async function callGemini(input: AiCallInput): Promise<AiCallSuccess> {
  if (!GEMINI_API_KEY) throw new AiProviderError('error', 'GEMINI_API_KEY is not configured.');

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
  };
  if (input.systemPrompt) {
    body.systemInstruction = { parts: [{ text: input.systemPrompt }] };
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
    // Gemini's 429 body doesn't reliably distinguish RPM vs RPD in a way worth parsing — see the
    // 'rpm' default reasoning in types.ts.
    throw new AiProviderError('rate_limit', 'Gemini rate limit hit.', { reason: 'rpm', statusCode: 429, rateLimitHeaders });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AiProviderError('error', `Gemini request failed (HTTP ${res.status}): ${detail.slice(0, 300)}`, {
      statusCode: res.status,
      rateLimitHeaders,
    });
  }

  const data = await res.json().catch(() => null);
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p: { text?: string }) => p.text || '')
    .join('');
  if (!text) throw new AiProviderError('error', 'Gemini returned no usable text.');

  return { text, provider: 'gemini', model: GEMINI_MODEL, rateLimitHeaders };
}
