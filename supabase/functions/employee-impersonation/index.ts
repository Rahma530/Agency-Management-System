// TEMPORARY TRANSITION FEATURE — intended for removal once every employee has adopted their own
// real, self-set password (distributed via scripts/provisionAuthUsers.ts). This function lets an
// active Head of Technical or AI Engineer log into a rank-and-file employee's account via a
// Supabase Auth magic link, without ever seeing or resetting that employee's real password — a
// bridge for the window until the team has fully transitioned off shared/admin-known credentials.
// Do not build new permanent features on top of this; when leadership decides the transition is
// done, this function (and its impersonation_sessions table / EmployeeImpersonation.tsx UI) should
// be deleted outright, not folded into something else.
//
// Deploy with JWT verification enabled. The service-role key is used only here, never in React.
import { createClient } from 'npm:@supabase/supabase-js@2.114.0';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const enabled = Deno.env.get('EMPLOYEE_IMPERSONATION_ENABLED') === 'true';
const supportedOrigins = new Set([
  'http://localhost:3000',
  'https://agency-management-system-alpha.vercel.app',
]);
const allowedOrigins = new Set((Deno.env.get('EMPLOYEE_IMPERSONATION_ALLOWED_ORIGIN') || 'http://localhost:3000')
  .split(',').map((origin) => origin.trim()).filter((origin) => supportedOrigins.has(origin)));

// Same two accounts, same protection level, as employee-test-account's password-reset guard:
// these Auth IDs can never be impersonated, exactly as they can never have their password reset.
// Shared project-level secrets, not duplicated per function.
const protectedAuthIds = [
  Deno.env.get('EMPLOYEE_TEST_PROTECTED_TOQA_AUTH_ID')?.trim().toLowerCase(),
  Deno.env.get('EMPLOYEE_TEST_PROTECTED_SHAHD_AUTH_ID')?.trim().toLowerCase(),
];
const protectedIdsConfigured = protectedAuthIds.every((id) =>
  !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
  && protectedAuthIds[0] !== protectedAuthIds[1];

// Leadership can never impersonate one another (or themselves) through this tool — only
// rank-and-file employees are valid targets. Kept as a literal list here, not imported from
// src/lib/permissions.ts: this function is deployed independently of the app bundle, same as
// employee-test-account's own inline role check.
const NON_IMPERSONATABLE_ROLES = new Set(['executive', 'head_of_technical', 'ai_engineer']);

const cors = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
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
  if (!enabled || !supabaseUrl || !anonKey || !serviceKey) return response({ error: 'Impersonation is disabled.' }, 503);
  if (!protectedIdsConfigured) return response({ error: 'Protected employee Auth IDs are not configured.' }, 503);

  const bearer = req.headers.get('Authorization') || '';
  if (!bearer.startsWith('Bearer ')) return response({ error: 'Authentication required.' }, 401);
  const callerClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser(bearer.slice(7));
  if (callerError || !caller) return response({ error: 'Authentication required.' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: tester, error: testerError } = await admin.from('users')
    .select('id, role, deactivated_at').eq('auth_id', caller.id).maybeSingle();
  if (testerError || !tester || tester.deactivated_at
    || !['head_of_technical', 'ai_engineer'].includes(tester.role)) {
    return response({ error: 'Only active Head of Technical or AI Engineer users may impersonate an employee.' }, 403);
  }

  let input: { action?: string; employeeId?: string };
  try { input = await req.json(); } catch { return response({ error: 'Invalid request.' }, 400); }
  if (!input || typeof input !== 'object' || input.action !== 'start'
    || typeof input.employeeId !== 'string' || !input.employeeId || input.employeeId.length > 150) {
    return response({ error: 'Invalid request.' }, 400);
  }

  const { data: employee, error: employeeError } = await admin.from('users')
    .select('id, email, role, auth_id, deactivated_at').eq('id', input.employeeId).maybeSingle();
  if (employeeError || !employee) return response({ error: 'Employee not found.' }, 404);
  if (employee.deactivated_at) return response({ error: 'Disabled employees cannot be impersonated.' }, 409);
  if (!employee.auth_id) return response({ error: 'Employee has no linked Auth account yet.' }, 409);
  if (NON_IMPERSONATABLE_ROLES.has(employee.role)) {
    return response({ error: 'Leadership accounts cannot be impersonated through this tool.' }, 403);
  }
  if (protectedAuthIds.includes(employee.auth_id.toLowerCase())) {
    return response({ error: 'This employee\'s account is protected and cannot be impersonated.' }, 403);
  }
  if (!employee.email) return response({ error: 'Employee has no work email on file.' }, 409);

  const { data: linked, error: linkedError } = await admin.auth.admin.getUserById(employee.auth_id);
  if (linkedError || !linked.user) return response({ error: 'Linked Auth account requires manual review.' }, 409);
  if (linked.user.banned_until && new Date(linked.user.banned_until).getTime() > Date.now()) {
    return response({ error: 'Linked Auth account is disabled.' }, 409);
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: linked.user.email || employee.email,
  });
  // generateLink only ever issues a one-time sign-in token; it never reads or changes
  // encrypted_password, so the employee's own password is completely unaffected by this call.
  if (linkError || !link?.properties?.hashed_token) {
    return response({ error: 'Could not generate an impersonation link.' }, 500);
  }

  const sessionId = crypto.randomUUID();
  const { error: insertError } = await admin.from('impersonation_sessions').insert({
    id: sessionId,
    admin_user_id: tester.id,
    admin_auth_id: caller.id,
    employee_id: employee.id,
    employee_auth_id: employee.auth_id,
  });
  if (insertError) {
    return response({ error: 'Could not record the impersonation session; nothing was started.' }, 500);
  }

  return response({
    sessionId,
    hashedToken: link.properties.hashed_token,
    employeeAuthId: employee.auth_id,
    employeeEmail: linked.user.email || employee.email,
  });
});
