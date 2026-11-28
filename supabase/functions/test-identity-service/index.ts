// Testing Portal (simplified flow) — Phase 2: creates a synthetic test identity + minimal
// synthetic data on request, returns one direct sign-in link to it, and tears that same identity
// and its data down again on close. See supabase/migrations/20270201000000_test_identity_
// foundation.sql for the schema/RLS half of this (is_test / is_test_identity columns,
// app_user_is_test_identity(), the restrictive policies, and the per-function guards) — this
// function is useless without that migration applied first.
//
// Deliberately NOT a reuse of employee-impersonation's verifyOtp-in-the-same-tab approach: that
// flow swaps the *admin's own* open browser session in place, which only works because the admin
// is already signed in in that same tab. A test link is meant to be opened fresh, by anyone it's
// handed to, in any browser — so this follows scripts/provisionAuthUsers.ts's / employee-
// invitation's pattern instead: admin.auth.admin.generateLink()'s `action_link` is a real,
// standalone, clickable URL that Supabase's own hosted verify endpoint consumes, then redirects
// into the app with a real session already established — no new frontend route or page needed,
// the Supabase JS client already detects and consumes a session from the URL on load (same
// mechanism that already makes password-recovery and invitation links work in this app today).
//
// Two actions:
//   'create' — ai_engineer / head_of_technical only. Creates a synthetic Auth user + public.users
//               row (is_test_identity = true, role = the requested built-in role) and one
//               synthetic client + one synthetic task (is_test = true) so that role actually has
//               something to act on, logs a public.test_sessions row, and returns a sign-in link.
//   'close'  — the original requester, or executive/head_of_technical/ai_engineer. Deletes the
//               synthetic task, client, public.users row and Auth account (in FK-safe order),
//               and marks the test_sessions row closed. Idempotent: closing an already-closed
//               session is a no-op success, not an error.
//   'sweep'  — service-role only (called by a once-daily scheduled invocation, not from the
//               browser): closes every session whose expires_at has passed and was never
//               manually closed. Safety net only — see the migration's comment on expires_at.
//
// Scope, matching the migration: built-in roles only (the 19 fixed UserRole values). Custom
// roles (public.custom_roles / departments) are a separate, newer system this pass does not
// touch — requesting one is rejected with a clear message rather than silently mishandled.
//
// Deploy with JWT verification enabled. The service-role key is used only here, never in React.
import { createClient } from 'npm:@supabase/supabase-js@2.114.0';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const enabled = Deno.env.get('TEST_IDENTITY_SERVICE_ENABLED') === 'true';
const sweepSecret = Deno.env.get('TEST_IDENTITY_SWEEP_SECRET') || '';

const supportedOrigins = new Set([
  'http://localhost:3000',
  'https://agency-management-system-alpha.vercel.app',
  'https://kms.kesraa.com',
]);
const allowedOrigins = new Set((Deno.env.get('TEST_IDENTITY_SERVICE_ALLOWED_ORIGIN') || 'http://localhost:3000')
  .split(',').map((origin) => origin.trim()).filter((origin) => supportedOrigins.has(origin)));
const getRedirectUrl = (): string => {
  const value = (Deno.env.get('TEST_IDENTITY_REDIRECT_URL') || '').trim();
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !supportedOrigins.has(url.origin)) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
};
const redirectUrl = getRedirectUrl();

const cors = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

// The 19 built-in UserRole values — kept literally in sync with users_role_valid_guard()
// (supabase/migrations/20261101500000_users_role_validation_trigger.sql), minus custom roles,
// which this pass deliberately does not support yet (see header comment).
const BUILT_IN_ROLES = new Set([
  'executive', 'head_of_technical', 'sales', 'am_team_lead', 'am_agent',
  'media_buying_team_lead', 'media_buying_agent', 'seo_team_lead', 'seo_agent',
  'seo_content_agent', 'seo_backlink_agent', 'store_manager', 'programming_agent',
  'social_media_team_lead', 'social_media_agent', 'graphic_designer', 'video_editor',
  'ai_engineer', 'marketing_manager',
]);

// Matches src/data/roles.ts's AGENCY_ROLES[*].team exactly, so a synthetic identity's `team`
// behaves the same way a real employee's would for any team-scoped visibility rule.
const ROLE_TEAM: Record<string, string> = {
  executive: 'Executive',
  head_of_technical: 'Technical',
  sales: 'Sales',
  am_team_lead: 'Account Management',
  am_agent: 'Account Management',
  media_buying_team_lead: 'Media Buying',
  media_buying_agent: 'Media Buying',
  seo_team_lead: 'SEO',
  seo_agent: 'SEO',
  store_manager: 'SEO',
  seo_content_agent: 'SEO',
  seo_backlink_agent: 'SEO',
  programming_agent: 'Programming',
  social_media_team_lead: 'Social Media',
  social_media_agent: 'Social Media',
  graphic_designer: 'Creative & Design',
  video_editor: 'Video Production',
  ai_engineer: 'AI Engineering',
  marketing_manager: 'Marketing',
};

const randomDiscardedPassword = () => crypto.randomUUID() + crypto.randomUUID();

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
  if (origin && !allowedOrigins.has(origin)) return response({ error: 'Origin not allowed.' }, 403);
  if (req.method === 'OPTIONS') return response({ ok: true });
  if (req.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);
  if (!enabled || !supabaseUrl || !anonKey || !serviceKey) return response({ error: 'Test identity service is disabled.' }, 503);

  let input: { action?: string; targetRole?: string; description?: string; sessionId?: string };
  try { input = await req.json(); } catch { return response({ error: 'Invalid request.' }, 400); }
  if (!input || typeof input !== 'object') return response({ error: 'Invalid request.' }, 400);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // --- 'sweep' is the only action with no human caller — authenticated by a shared secret
  // header instead of a Bearer user token, meant to be invoked by a once-daily scheduled trigger.
  if (input.action === 'sweep') {
    if (!sweepSecret || req.headers.get('X-Sweep-Secret') !== sweepSecret) {
      return response({ error: 'Not authorized.' }, 401);
    }
    const { data: expired, error: expiredError } = await admin.from('test_sessions')
      .select('id').is('closed_at', null).lt('expires_at', new Date().toISOString());
    if (expiredError) return response({ error: 'Could not look up expired sessions.' }, 500);
    const results: Array<{ sessionId: string; ok: boolean }> = [];
    for (const row of expired || []) {
      const ok = await closeSession(admin, row.id);
      results.push({ sessionId: row.id, ok });
    }
    return response({ swept: results.length, results });
  }

  // --- Every other action requires a real signed-in caller.
  const bearer = req.headers.get('Authorization') || '';
  if (!bearer.startsWith('Bearer ')) return response({ error: 'Authentication required.' }, 401);
  const callerClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser(bearer.slice(7));
  if (callerError || !caller) return response({ error: 'Authentication required.' }, 401);

  const { data: requester, error: requesterError } = await admin.from('users')
    .select('id, role, deactivated_at').eq('auth_id', caller.id).maybeSingle();
  if (requesterError || !requester || requester.deactivated_at) {
    return response({ error: 'Authentication required.' }, 401);
  }

  if (input.action === 'create') {
    if (!['ai_engineer', 'head_of_technical'].includes(requester.role)) {
      return response({ error: 'Only AI Engineer or Head of Technical may create a test identity.' }, 403);
    }
    if (!redirectUrl) return response({ error: 'Test identity redirect URL is not configured.' }, 503);

    const targetRole = (input.targetRole || '').trim();
    const description = (input.description || '').trim();
    if (!targetRole) return response({ error: 'targetRole is required.' }, 400);
    if (!BUILT_IN_ROLES.has(targetRole)) {
      return response({ error: 'That role is not supported yet. Only built-in roles can be test-identity targets for now (custom roles are not covered by this pass).' }, 400);
    }
    if (!description || description.length > 500) {
      return response({ error: 'description is required (max 500 characters).' }, 400);
    }

    const shortId = crypto.randomUUID().replace(/-/g, '');
    const syntheticUserId = `test-usr-${shortId}`;
    const syntheticClientId = `test-clt-${shortId}`;
    const syntheticTaskId = `test-tsk-${shortId}`;
    const syntheticEmail = `test.${shortId}@test.kesraa.internal`;
    const label = `Test Identity — ${targetRole} (${new Date().toISOString().slice(0, 10)})`;

    const { data: createdAuth, error: createAuthError } = await admin.auth.admin.createUser({
      email: syntheticEmail,
      password: randomDiscardedPassword(),
      email_confirm: true,
      user_metadata: { is_test_identity: true, requested_by: requester.id },
    });
    if (createAuthError || !createdAuth?.user) {
      return response({ error: 'Could not create the synthetic Auth account.' }, 500);
    }

    const { error: userInsertError } = await admin.from('users').insert({
      id: syntheticUserId,
      name: label,
      email: syntheticEmail,
      role: targetRole,
      team: ROLE_TEAM[targetRole] ?? null,
      auth_id: createdAuth.user.id,
      is_test_identity: true,
    });
    if (userInsertError) {
      await admin.auth.admin.deleteUser(createdAuth.user.id);
      return response({ error: `Could not create the synthetic identity: ${userInsertError.message}` }, 500);
    }

    const { error: clientInsertError } = await admin.from('clients').insert({
      id: syntheticClientId,
      name: label,
      status: 'active',
      is_test: true,
      am_agent_id: targetRole === 'am_agent' ? syntheticUserId : null,
      am_team_lead_id: targetRole === 'am_team_lead' ? syntheticUserId : null,
    });
    if (clientInsertError) {
      await admin.from('users').delete().eq('id', syntheticUserId);
      await admin.auth.admin.deleteUser(createdAuth.user.id);
      return response({ error: `Could not create synthetic test data: ${clientInsertError.message}` }, 500);
    }

    const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { error: taskInsertError } = await admin.from('tasks').insert({
      id: syntheticTaskId,
      client_id: syntheticClientId,
      title: label,
      description,
      assigned_to: syntheticUserId,
      created_by: syntheticUserId,
      team: ROLE_TEAM[targetRole] ?? null,
      status: 'todo',
      due_date: dueDate,
      priority: 'medium',
      is_test: true,
    });
    if (taskInsertError) {
      await admin.from('clients').delete().eq('id', syntheticClientId);
      await admin.from('users').delete().eq('id', syntheticUserId);
      await admin.auth.admin.deleteUser(createdAuth.user.id);
      return response({ error: `Could not create synthetic test data: ${taskInsertError.message}` }, 500);
    }

    const { data: session, error: sessionInsertError } = await admin.from('test_sessions').insert({
      requested_by: requester.id,
      synthetic_user_id: syntheticUserId,
      synthetic_client_id: syntheticClientId,
      synthetic_task_id: syntheticTaskId,
      target_role: targetRole,
      description,
    }).select('id, expires_at').single();
    if (sessionInsertError || !session) {
      await admin.from('tasks').delete().eq('id', syntheticTaskId);
      await admin.from('clients').delete().eq('id', syntheticClientId);
      await admin.from('users').delete().eq('id', syntheticUserId);
      await admin.auth.admin.deleteUser(createdAuth.user.id);
      return response({ error: 'Could not log the test session; nothing was created.' }, 500);
    }

    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: syntheticEmail,
      options: { redirectTo: redirectUrl },
    });
    if (linkError || !link?.properties?.action_link) {
      await closeSession(admin, session.id);
      return response({ error: 'Could not generate the test sign-in link; the test identity was rolled back.' }, 500);
    }

    return response({
      sessionId: session.id,
      testLink: link.properties.action_link,
      expiresAt: session.expires_at,
    });
  }

  if (input.action === 'close') {
    const sessionId = (input.sessionId || '').trim();
    if (!sessionId) return response({ error: 'sessionId is required.' }, 400);

    const { data: session, error: sessionError } = await admin.from('test_sessions')
      .select('id, requested_by, closed_at').eq('id', sessionId).maybeSingle();
    if (sessionError || !session) return response({ error: 'Test session not found.' }, 404);

    const canClose = session.requested_by === requester.id
      || ['executive', 'head_of_technical', 'ai_engineer'].includes(requester.role);
    if (!canClose) return response({ error: 'You do not have permission to close this test session.' }, 403);

    if (session.closed_at) return response({ ok: true, alreadyClosed: true });

    const ok = await closeSession(admin, sessionId);
    if (!ok) return response({ error: 'Could not fully close the test session. Please retry.' }, 500);
    return response({ ok: true });
  }

  return response({ error: 'Unknown action.' }, 400);
});

// Deletes a session's synthetic task, client, public.users row and Auth account (FK-safe order:
// tasks before clients, public.users before the Auth user it points to), then marks the
// test_sessions row closed. Never deletes the test_sessions row itself -- that's the audit trail.
// Best-effort and idempotent: a row already gone (e.g. a previous partial close) is not an error.
async function closeSession(admin: ReturnType<typeof createClient>, sessionId: string): Promise<boolean> {
  const { data: session, error: sessionError } = await admin.from('test_sessions')
    .select('synthetic_user_id, synthetic_client_id, synthetic_task_id').eq('id', sessionId).maybeSingle();
  if (sessionError || !session) return false;

  let authIdToDelete: string | null = null;
  if (session.synthetic_user_id) {
    const { data: syntheticUser } = await admin.from('users')
      .select('auth_id').eq('id', session.synthetic_user_id).maybeSingle();
    authIdToDelete = syntheticUser?.auth_id ?? null;
  }

  if (session.synthetic_task_id) {
    await admin.from('tasks').delete().eq('id', session.synthetic_task_id);
  }
  if (session.synthetic_client_id) {
    await admin.from('clients').delete().eq('id', session.synthetic_client_id);
  }
  if (session.synthetic_user_id) {
    await admin.from('users').delete().eq('id', session.synthetic_user_id);
  }
  if (authIdToDelete) {
    await admin.auth.admin.deleteUser(authIdToDelete);
  }

  const { error: closeError } = await admin.from('test_sessions')
    .update({ closed_at: new Date().toISOString() }).eq('id', sessionId);
  return !closeError;
}
