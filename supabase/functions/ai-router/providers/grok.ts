// Grok/xAI adapter — plain REST against xAI's OpenAI-compatible chat-completions endpoint, no SDK.
//
// IMPORTANT, confirmed via live research for this design (not assumed): unlike Gemini, xAI has no
// renewing daily/monthly free tier. A new account gets a one-time $25 signup credit; every call
// after that balance is exhausted is a real paid charge, not a quota that resets tomorrow. A 429
// or insufficient-credit response from this adapter should NOT be treated by the Phase 3 router as
// "available again after a cooldown" the way Gemini's daily limit is — it stays unavailable until
// someone adds a payment method / more credit to the account. This matches the confirmed policy
// ("if a single account's quota is insufficient, the fix is a paid tier upgrade on that account")
// but the router's cooldown logic needs to know this case doesn't self-heal on a timer.
import { AiCallInput, AiCallSuccess, AiProviderError } from '../types.ts';

// xAI's model lineup moves fast (grok-4.6/4.7 are current top picks per the xAI docs as of this
// design; older aliases like grok-4-fast redirect transparently to the current model rather than
// 404ing). Override via XAI_MODEL without a redeploy if this drifts before Phase 1 is exercised.
const XAI_MODEL = Deno.env.get('XAI_MODEL') || 'grok-4-fast';
const XAI_API_KEY = Deno.env.get('XAI_API_KEY') || '';

export async function callGrok(input: AiCallInput): Promise<AiCallSuccess> {
  if (!XAI_API_KEY) throw new AiProviderError('error', 'XAI_API_KEY is not configured.');

  const messages: { role: string; content: string }[] = [];
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
  messages.push({ role: 'user', content: input.prompt });

  let res: Response;
  try {
    res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${XAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: XAI_MODEL, messages }),
    });
  } catch (err) {
    throw new AiProviderError('error', `Grok request failed before a response: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 429) {
    throw new AiProviderError('rate_limit', 'Grok rate limit or exhausted credit balance hit.', { reason: 'rpm', statusCode: 429 });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AiProviderError('error', `Grok request failed (HTTP ${res.status}): ${detail.slice(0, 300)}`, { statusCode: res.status });
  }

  const data = await res.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new AiProviderError('error', 'Grok returned no usable text.');

  return { text, provider: 'grok', model: XAI_MODEL };
}
