// AI Orchestrator — Phase 1 of 6 (see the design conversation for the full architecture: Task
// Registry -> AI Router -> Provider Adapter -> Usage Tracking + Rate-Limit State -> result
// validation). This is deliberately a thin skeleton: three providers (Gemini for extraction; Groq
// for analysis, primary; OpenRouter free models for analysis, emergency-fallback only — its free
// tier is roughly 50 requests/day unless the account has purchased credits) across two adapter
// files (./providers/gemini.ts; ./providers/openaiCompatible.ts, shared by Groq/OpenRouter since
// both are OpenAI-compatible REST), wired behind the same auth/CORS/enable-flag scaffold every
// Edge Function in this repo already uses (employee-invitation, employee-impersonation), callable
// with a fixed test prompt via curl.
//
// Grok/xAI was evaluated and deliberately dropped: it has no renewing free tier (a one-time $25
// signup credit, then real paid charges), which doesn't fit this project's zero-AI-cost goal.
//
// NOT yet implemented (Phases 2-4, in order):
//  - The real Task Registry (prompt templates, per-task provider assignment, fallback rules).
//  - The AI Router's provider-rotation/cooldown logic against ai_provider_state.
//  - ai_usage logging.
// PHASE1_TASK_MAP below is a temporary stand-in for the registry — just enough to exercise each
// adapter independently. It exists so the request contract (task + prompt in, never a raw provider
// choice from the caller) doesn't change shape once the real registry replaces it in Phase 2.
//
// Deploy with JWT verification enabled. Provider API keys are used only here, never in React.
import { createClient } from 'npm:@supabase/supabase-js@2.114.0';
import { callGemini } from './providers/gemini.ts';
import { callOpenAiCompatible } from './providers/openaiCompatible.ts';
import { AiCallSuccess, AiProvider, AiProviderError } from './types.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const enabled = Deno.env.get('AI_ROUTER_ENABLED') === 'true';
const supportedOrigins = new Set([
  'http://localhost:3000',
  'https://agency-management-system-alpha.vercel.app',
]);
const allowedOrigins = new Set((Deno.env.get('AI_ROUTER_ALLOWED_ORIGIN') || 'http://localhost:3000')
  .split(',').map((origin) => origin.trim()).filter((origin) => supportedOrigins.has(origin)));

const cors = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

// Phase-1-only stand-in for the Task Registry — replaced wholesale in Phase 2, not extended here.
const PHASE1_TASK_MAP: Record<string, AiProvider> = {
  PHASE1_TEST_GEMINI: 'gemini',
  PHASE1_TEST_GROQ: 'groq',
  PHASE1_TEST_OPENROUTER: 'openrouter',
};

const GROQ_CONFIG = {
  provider: 'groq' as const,
  baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
  apiKeyEnvVar: 'GROQ_API_KEY',
  modelEnvVar: 'GROQ_MODEL',
};

const OPENROUTER_CONFIG = {
  provider: 'openrouter' as const,
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
  apiKeyEnvVar: 'OPENROUTER_API_KEY',
  modelEnvVar: 'OPENROUTER_MODEL',
};

function callProvider(provider: AiProvider, input: { prompt: string; systemPrompt?: string }): Promise<AiCallSuccess> {
  if (provider === 'gemini') return callGemini(input);
  if (provider === 'groq') return callOpenAiCompatible(GROQ_CONFIG, input);
  return callOpenAiCompatible(OPENROUTER_CONFIG, input);
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  const response = (body: Record<string, unknown>, status = 200): Response => new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      ...(origin && allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
  if (origin && !allowedOrigins.has(origin)) {
    return response({ error: 'Origin not allowed.' }, 403);
  }
  if (req.method === 'OPTIONS') return response({ ok: true });
  if (req.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);
  if (!enabled || !supabaseUrl || !anonKey || !serviceKey) return response({ error: 'AI router is disabled.' }, 503);

  const bearer = req.headers.get('Authorization') || '';
  if (!bearer.startsWith('Bearer ')) return response({ error: 'Authentication required.' }, 401);
  const callerClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser(bearer.slice(7));
  if (callerError || !caller) return response({ error: 'Authentication required.' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // No role allowlist, unlike employee-invitation/employee-impersonation: every one of the 4
  // features this will power (Phase 5) is already gated by its own existing per-feature permission
  // check client-side — this function's own job is just "reject anyone who isn't a real, active
  // internal employee," which also naturally excludes client_portal_users, a structurally separate
  // table this lookup can never match.
  const { data: callerRow, error: callerRowError } = await admin.from('users')
    .select('id, deactivated_at').eq('auth_id', caller.id).maybeSingle();
  if (callerRowError || !callerRow || callerRow.deactivated_at) {
    return response({ error: 'Only active employees may use the AI router.' }, 403);
  }

  let input: { task?: string; prompt?: string; systemPrompt?: string };
  try { input = await req.json(); } catch { return response({ error: 'Invalid request.' }, 400); }
  if (!input || typeof input !== 'object' || typeof input.task !== 'string' || typeof input.prompt !== 'string'
    || !input.prompt || input.prompt.length > 20000) {
    return response({ error: 'Invalid request.' }, 400);
  }

  const provider = PHASE1_TASK_MAP[input.task];
  if (!provider) return response({ error: `Unknown task "${input.task}".` }, 400);

  try {
    const result = await callProvider(provider, { prompt: input.prompt, systemPrompt: input.systemPrompt });
    return response({ ok: true, ...result });
  } catch (err) {
    // A rate-limit or provider-side failure is an anticipated outcome this router is built to
    // handle (Phase 3 onward), not a broken request — returned as 200 with ok:false so callers
    // branch on the body, while genuine request/auth problems above still use real HTTP statuses.
    if (err instanceof AiProviderError) {
      console.error(`ai-router ${provider} error (${err.kind}):`, err.message);
      return response({
        ok: false,
        kind: err.kind,
        reason: err.reason,
        message: err.message,
        rateLimitHeaders: err.rateLimitHeaders,
        limitSource: err.limitSource,
      });
    }
    console.error('ai-router unexpected error:', err);
    return response({ ok: false, kind: 'error', message: 'Unexpected error.' });
  }
});
