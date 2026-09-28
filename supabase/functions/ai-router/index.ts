// AI Orchestrator — Phase 2 of 6 (see the design conversation for the full architecture: Task
// Registry -> AI Router -> Provider Adapter -> Usage Tracking + Rate-Limit State -> result
// validation). Three providers (Gemini for extraction; Groq for analysis, primary; OpenRouter free
// models for analysis, emergency-fallback only — its free tier is roughly 50 requests/day unless
// the account has purchased credits) across two adapter files (./providers/gemini.ts;
// ./providers/openaiCompatible.ts, shared by Groq/OpenRouter since both are OpenAI-compatible
// REST), dispatched through ./providers/dispatch.ts, wired behind the same auth/CORS/enable-flag
// scaffold every Edge Function in this repo already uses (employee-invitation,
// employee-impersonation).
//
// Grok/xAI was evaluated and deliberately dropped: it has no renewing free tier (a one-time $25
// signup credit, then real paid charges), which doesn't fit this project's zero-AI-cost goal.
//
// Two request shapes are handled here, sharing the same auth/CORS/enable-flag gate above:
//  - PHASE1_TASK_MAP: the original Phase 1 skeleton, `{task, prompt, systemPrompt?}` — a single
//    raw call to one adapter, no registry, no fallback. Kept working unchanged for curl testing.
//  - TASK_REGISTRY (taskRegistry.ts): real, data-driven multi-stage tasks, `{task, payload,
//    language?}` — payload is validated against that task's own field allowlist (never free text),
//    executed by taskRunner.ts's generic sequential-stages-with-fallback runner.
//
// NOT yet implemented (Phases 3-4, in order):
//  - The AI Router's provider-rotation/cooldown MEMORY against ai_provider_state — a rate-limited
//    provider is retried again on the very next call today, nothing remembers it was just
//    exhausted. Fallback within a single request (per stage) already works (see taskRunner.ts).
//  - ai_usage logging.
//
// Deploy with JWT verification enabled. Provider API keys are used only here, never in React.
import { createClient } from 'npm:@supabase/supabase-js@2.114.0';
import { callProvider } from './providers/dispatch.ts';
import { AiProvider, AiProviderError } from './types.ts';
import { isSupportedLanguage, TASK_REGISTRY } from './taskRegistry.ts';
import { runRegistryTask } from './taskRunner.ts';

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

// Phase-1-only test scaffold — untouched, still bypasses the Task Registry entirely.
const PHASE1_TASK_MAP: Record<string, AiProvider> = {
  PHASE1_TEST_GEMINI: 'gemini',
  PHASE1_TEST_GROQ: 'groq',
  PHASE1_TEST_OPENROUTER: 'openrouter',
};

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

  let input: { task?: string; prompt?: string; systemPrompt?: string; payload?: unknown; language?: string };
  try { input = await req.json(); } catch { return response({ error: 'Invalid request.' }, 400); }
  if (!input || typeof input !== 'object' || typeof input.task !== 'string' || !input.task) {
    return response({ error: 'Invalid request.' }, 400);
  }

  // Path 1: the original Phase 1 skeleton — a single raw call, no registry, no fallback.
  const legacyProvider = PHASE1_TASK_MAP[input.task];
  if (legacyProvider) {
    if (typeof input.prompt !== 'string' || !input.prompt || input.prompt.length > 20000) {
      return response({ error: 'Invalid request.' }, 400);
    }
    try {
      const result = await callProvider(legacyProvider, { prompt: input.prompt, systemPrompt: input.systemPrompt });
      return response({ ok: true, ...result });
    } catch (err) {
      // A rate-limit or provider-side failure is an anticipated outcome this router is built to
      // handle, not a broken request — returned as 200 with ok:false so callers branch on the
      // body, while genuine request/auth problems above still use real HTTP statuses.
      if (err instanceof AiProviderError) {
        console.error(`ai-router ${legacyProvider} error (${err.kind}):`, err.message);
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
  }

  // Path 2: a real, data-driven Task Registry task — structured payload only, never free text.
  const task = TASK_REGISTRY[input.task];
  if (!task) return response({ error: `Unknown task "${input.task}".` }, 400);

  const language = isSupportedLanguage(input.language) ? input.language : 'ar';
  const result = await runRegistryTask(task, input.payload, language);
  if (result.ok) {
    return response({ ok: true, task: result.task, result: result.result, stages: result.stages });
  }
  console.error(`ai-router ${result.task}/${result.stage} error (${result.kind}):`, result.message);
  return response({
    ok: false,
    task: result.task,
    stage: result.stage,
    kind: result.kind,
    reason: result.reason,
    message: result.message,
    rateLimitHeaders: result.rateLimitHeaders,
    limitSource: result.limitSource,
  });
});
