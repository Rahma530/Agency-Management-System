// Temporary, opt-in account setup. Deploy with JWT verification enabled.
// The service-role key is used only in this Edge Function, never in React.
import { createClient, type User } from 'npm:@supabase/supabase-js@2.114.0';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const enabled = Deno.env.get('EMPLOYEE_TEST_ACCOUNT_SETUP_ENABLED') === 'true';
const allowedOrigin = Deno.env.get('EMPLOYEE_TEST_ALLOWED_ORIGIN') || 'http://localhost:3000';
// Auth IDs are configured on the server, never inferred from display names or browser data.
// Fail closed until both protected accounts have been identified.
const protectedAuthIds = [
  Deno.env.get('EMPLOYEE_TEST_PROTECTED_TOQA_AUTH_ID')?.trim().toLowerCase(),
  Deno.env.get('EMPLOYEE_TEST_PROTECTED_SHAHD_AUTH_ID')?.trim().toLowerCase(),
];
const protectedIdsConfigured = protectedAuthIds.every((id) =>
  !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
  && protectedAuthIds[0] !== protectedAuthIds[1];

const cors = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

function response(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function findAuthByEmail(admin: ReturnType<typeof createClient>, email: string): Promise<User | null> {
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (match) return match;
    if (data.users.length < 200) return null;
  }
  throw new Error('Auth directory too large to verify email safely.');
}

function generateTemporaryPassword(): string {
  const groups = ['abcdefghjkmnpqrstuvwxyz', 'ABCDEFGHJKMNPQRSTUVWXYZ', '23456789', '!@#_-'];
  const alphabet = groups.join('');
  const pick = (length: number): number => {
    const range = 0x100000000;
    const limit = range - (range % length);
    let value: number;
    do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= limit);
    return value % length;
  };
  const characters = groups.map((group) => group[pick(group.length)]);
  while (characters.length < 28) characters.push(alphabet[pick(alphabet.length)]);
  for (let index = characters.length - 1; index > 0; index--) {
    const swap = pick(index + 1);
    [characters[index], characters[swap]] = [characters[swap], characters[index]];
  }
  return characters.join('');
}

Deno.serve(async (req) => {
  if (req.headers.get('Origin') && req.headers.get('Origin') !== allowedOrigin) {
    return response({ error: 'Origin not allowed.' }, 403);
  }
  if (req.method === 'OPTIONS') return response({ ok: true });
  if (req.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);
  if (!enabled || !supabaseUrl || !anonKey || !serviceKey) return response({ error: 'Account setup is disabled.' }, 503);

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
    || !['executive', 'head_of_technical'].includes(tester.role)) {
    return response({ error: 'Only active Executive Management or Head of Technical may set up test accounts.' }, 403);
  }

  let input: { action?: string; employeeId?: string; password?: string };
  try { input = await req.json(); } catch { return response({ error: 'Invalid request.' }, 400); }
  if (!input || typeof input !== 'object' || !['status', 'setup', 'generate_test_password'].includes(input.action || '')
    || typeof input.employeeId !== 'string' || !input.employeeId || input.employeeId.length > 150) {
    return response({ error: 'Invalid request.' }, 400);
  }
  if (input.action === 'generate_test_password' && input.password !== undefined) {
    return response({ error: 'Invalid request.' }, 400);
  }

  const { data: employee, error: employeeError } = await admin.from('users')
    .select('id, email, auth_id, deactivated_at').eq('id', input.employeeId).maybeSingle();
  if (employeeError || !employee) return response({ error: 'Employee not found.' }, 404);
  if (employee.deactivated_at) return response({ error: 'Disabled employees cannot be tested.' }, 409);

  if (employee.auth_id) {
    const { data: linked, error } = await admin.auth.admin.getUserById(employee.auth_id);
    if (error || !linked.user) return response({ error: 'Linked Auth account requires manual review.' }, 409);
    if (linked.user.banned_until && new Date(linked.user.banned_until).getTime() > Date.now()) {
      return response({ error: 'Linked Auth account is disabled.' }, 409);
    }
    if (!linked.user.email_confirmed_at) return response({ error: 'Linked Auth email is unconfirmed; use the normal setup link.' }, 409);
    const protectedAccount = protectedIdsConfigured && protectedAuthIds.includes(employee.auth_id.toLowerCase());
    if (input.action === 'generate_test_password') {
      if (!protectedIdsConfigured) return response({ error: 'Protected employee Auth IDs are not configured.' }, 503);
      if (protectedAccount) return response({ error: 'This employee\'s existing password is protected and cannot be changed here.' }, 403);
      // Recheck the linkage immediately before changing Auth. A stale selection must not
      // reset a newly deactivated or re-linked employee's password.
      const { data: current, error: currentError } = await admin.from('users')
        .select('auth_id, deactivated_at').eq('id', employee.id).maybeSingle();
      if (currentError || !current || current.deactivated_at || current.auth_id !== employee.auth_id) {
        return response({ error: 'Employee account changed. Check its status before retrying.' }, 409);
      }
      const temporaryPassword = generateTemporaryPassword();
      const { error: updateError } = await admin.auth.admin.updateUserById(employee.auth_id, {
        password: temporaryPassword,
      });
      if (updateError) return response({ error: 'Could not generate the temporary test password.' }, 500);
      return response({ status: 'ready', authId: linked.user.id, authEmail: linked.user.email,
        emailMismatch: linked.user.email?.toLowerCase() !== employee.email?.toLowerCase(),
        canGenerateTestPassword: true, temporaryPassword });
    }
    return response({ status: 'ready', authId: linked.user.id, authEmail: linked.user.email,
      emailMismatch: linked.user.email?.toLowerCase() !== employee.email?.toLowerCase(),
      canGenerateTestPassword: protectedIdsConfigured && !protectedAccount,
      testPasswordBlockReason: !protectedIdsConfigured ? 'configuration' : protectedAccount ? 'protected' : undefined });
  }
  if (input.action === 'generate_test_password') return response({ error: 'Employee has no linked Auth account.' }, 409);
  if (!employee.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email)) {
    return response({ error: 'Employee has no valid work email; correct the profile before setup.' }, 409);
  }

  try {
    const existing = await findAuthByEmail(admin, employee.email);
    if (existing) return response({ error: 'An unlinked Auth account already uses this email. Manual review is required.' }, 409);
    if (input.action === 'status') return response({ status: 'pending' });
    if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128) {
      return response({ error: 'Temporary password must be 12–128 characters.' }, 400);
    }
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: employee.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { app_user_id: employee.id, testing_account: true },
    });
    if (createError || !created.user) return response({ error: 'Could not create Auth account.' }, 409);

    const { data: linkedRows, error: linkError } = await admin.from('users')
      .update({ auth_id: created.user.id }).eq('id', employee.id).is('auth_id', null)
      .is('deactivated_at', null).select('id');
    if (linkError || linkedRows?.length !== 1) {
      const { data: current } = await admin.from('users').select('auth_id').eq('id', employee.id).maybeSingle();
      if (current?.auth_id !== created.user.id) await admin.auth.admin.deleteUser(created.user.id);
      return response({ error: 'Could not link Auth account. Check the employee status before retrying.' }, 409);
    }
    return response({ status: 'ready', authId: created.user.id, authEmail: created.user.email, emailMismatch: false });
  } catch {
    return response({ error: 'Account setup failed. Check Auth and employee linkage before retrying.' }, 500);
  }
});
