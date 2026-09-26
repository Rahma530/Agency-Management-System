// In-app replacement for the manual scripts/provisionAuthUsers.ts / scripts/resendRecoveryLink.ts
// terminal workflow. Given an employee row, this either creates their real Supabase Auth account
// (if they don't have one yet — public.users.auth_id is null) or reuses the existing one, then
// issues a fresh one-time password-RECOVERY link exactly the way both scripts already do —
// deliberately not admin.inviteUserByEmail(): a recovery-type link is what this app's own
// PASSWORD_RECOVERY auth-event handling (App.tsx) and SetPasswordScreen.tsx are already built
// around, and this app has never used Supabase's own email delivery anywhere. The link is
// returned in the response body for the admin to copy and deliver themselves (WhatsApp, email,
// etc.) — this function never sends anything on its own.
//
// The scripts remain as a documented fallback; this is now the primary path.
//
// Deploy with JWT verification enabled. The service-role key is used only here, never in React.
import { createClient, type User } from 'npm:@supabase/supabase-js@2.114.0';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const enabled = Deno.env.get('EMPLOYEE_INVITATION_ENABLED') === 'true';
const supportedOrigins = new Set([
  'http://localhost:3000',
  'https://agency-management-system-alpha.vercel.app',
]);
const allowedOrigins = new Set((Deno.env.get('EMPLOYEE_INVITATION_ALLOWED_ORIGIN') || 'http://localhost:3000')
  .split(',').map((origin) => origin.trim()).filter((origin) => supportedOrigins.has(origin)));

const cors = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

// supabase-js v2's admin API has no direct getUserByEmail; page through listUsers() and match
// client-side — same approach as scripts/provisionAuthUsers.ts's findAuthUserByEmail().
async function findAuthUserByEmail(admin: ReturnType<typeof createClient>, email: string): Promise<User | null> {
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data.users as User[];
    const match = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match;
    if (users.length < 200) return null;
  }
  throw new Error('Auth directory too large to search safely.');
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
  if (!enabled || !supabaseUrl || !anonKey || !serviceKey) return response({ error: 'Employee invitation is disabled.' }, 503);

  const bearer = req.headers.get('Authorization') || '';
  if (!bearer.startsWith('Bearer ')) return response({ error: 'Authentication required.' }, 401);
  const callerClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser(bearer.slice(7));
  if (callerError || !caller) return response({ error: 'Authentication required.' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // canAddEmployees's exact role set (lib/permissions.ts) — kept as a literal list here, not
  // imported from src/: this function is deployed independently of the app bundle, same as every
  // other Edge Function in this repo.
  const { data: sender, error: senderError } = await admin.from('users')
    .select('id, role, deactivated_at').eq('auth_id', caller.id).maybeSingle();
  if (senderError || !sender || sender.deactivated_at
    || !['executive', 'head_of_technical', 'ai_engineer'].includes(sender.role)) {
    return response({ error: 'Only active Executive, Head of Technical, or AI Engineer users may send an invitation.' }, 403);
  }

  let input: { employeeId?: string };
  try { input = await req.json(); } catch { return response({ error: 'Invalid request.' }, 400); }
  if (!input || typeof input !== 'object' || typeof input.employeeId !== 'string'
    || !input.employeeId || input.employeeId.length > 150) {
    return response({ error: 'Invalid request.' }, 400);
  }

  const { data: employee, error: employeeError } = await admin.from('users')
    .select('id, name, email, role, auth_id, deactivated_at').eq('id', input.employeeId).maybeSingle();
  if (employeeError || !employee) return response({ error: 'Employee not found.' }, 404);
  if (employee.deactivated_at) return response({ error: 'Disabled employees cannot be invited.' }, 409);
  if (!employee.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email)) {
    return response({ error: 'Employee has no valid work email; correct the profile before inviting.' }, 409);
  }

  try {
    let authUser: User | null = null;
    let wasNewAccount = false;

    if (employee.auth_id) {
      const { data: linked, error: linkedError } = await admin.auth.admin.getUserById(employee.auth_id);
      if (linkedError || !linked.user) return response({ error: 'Linked Auth account requires manual review.' }, 409);
      authUser = linked.user;
    } else {
      // Find-or-create, same order as scripts/provisionAuthUsers.ts: an Auth account for this
      // email may already exist from an earlier partial run (created but the public.users update
      // failed) — reuse it instead of erroring out on "already registered".
      authUser = await findAuthUserByEmail(admin, employee.email);
      if (!authUser) {
        const { data: created, error: createError } = await admin.auth.admin.createUser({
          email: employee.email,
          password: crypto.randomUUID() + crypto.randomUUID(),
          email_confirm: true,
          user_metadata: { app_user_id: employee.id, name: employee.name, role: employee.role },
        });
        if (createError || !created.user) return response({ error: 'Could not create the Auth account.' }, 500);
        authUser = created.user;
      }
      wasNewAccount = true;

      const { error: linkFieldError } = await admin.from('users')
        .update({ auth_id: authUser.id }).eq('id', employee.id).is('auth_id', null);
      if (linkFieldError) return response({ error: 'Could not link the new Auth account to this employee.' }, 500);
    }

    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: authUser.email || employee.email,
    });
    // generateLink({type: 'recovery'}) only ever issues a one-time password-setup token; it never
    // sets or exposes a real password.
    if (linkError || !link?.properties?.action_link) {
      return response({ error: 'Could not generate an invitation link.' }, 500);
    }

    return response({
      actionLink: link.properties.action_link,
      authId: authUser.id,
      wasNewAccount,
    });
  } catch (err) {
    console.error('employee-invitation error:', err);
    return response({ error: 'Could not send the invitation.' }, 500);
  }
});
