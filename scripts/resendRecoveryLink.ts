/**
 * FALLBACK — the primary path is now the same "Send/Resend Invitation" in-app action described in
 * scripts/provisionAuthUsers.ts's header (supabase/functions/employee-invitation): it already
 * covers this exact resend case (an employee with auth_id set but no last_seen_at yet) from
 * EmployeeAdminHub.tsx, one employee at a time. Keep this script for a batch resend across every
 * already-provisioned employee at once, or when the Edge Function isn't deployed.
 *
 * Re-issues a fresh one-time password-recovery link for an employee who
 * already has a real Supabase Auth account (public.users.auth_id is
 * already set) but never received or used their original link.
 *
 * Unlike scripts/provisionAuthUsers.ts — which only looks at rows where
 * auth_id IS NULL and creates a brand-new Auth account for each — this
 * script does NOT create anything. It looks up existing Auth account(s)
 * by email and asks Supabase to mint new one-time recovery link(s) for
 * them. Each employee's password (if they ever set one) is untouched
 * until they actually click their new link and go through
 * SetPasswordScreen again.
 *
 * NOT part of the app bundle — run manually:
 *   npx tsx scripts/resendRecoveryLink.ts "employee@agency.com"   (single employee)
 *   npx tsx scripts/resendRecoveryLink.ts                          (batch — everyone already provisioned)
 *
 * Uses the Supabase service-role key, exactly like the other scripts in
 * this folder — read from the shell environment only, never from
 * .env.local, never written to disk:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/resendRecoveryLink.ts "employee@agency.com"
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_URL (or VITE_SUPABASE_URL) and/or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'See the terminal commands in the chat message for how to set these for this run only.'
  );
  process.exit(1);
}

const [, , rawEmail] = process.argv;

if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
  console.error(`"${rawEmail}" doesn't look like a valid email address.`);
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface Employee {
  id: string;
  name: string;
  email: string;
  auth_id: string | null;
}

interface LinkResult {
  name: string;
  email: string;
  link?: string;
  error?: string;
}

async function generateLinkFor(employee: Pick<Employee, 'name' | 'email'>): Promise<LinkResult> {
  try {
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: employee.email,
    });
    if (linkErr) throw linkErr;
    return { name: employee.name, email: employee.email, link: linkData.properties.action_link };
  } catch (err: any) {
    return { name: employee.name, email: employee.email, error: err?.message || String(err) };
  }
}

async function runSingle(rawEmailArg: string) {
  const email = rawEmailArg.trim().toLowerCase();

  const { data: employee, error: lookupErr } = await supabaseAdmin
    .from('users')
    .select('id, name, email, auth_id')
    .ilike('email', email)
    .maybeSingle();

  if (lookupErr) {
    console.error('Unable to look up this employee in public.users:', lookupErr.message);
    process.exit(1);
  }

  if (!employee) {
    console.error(`No employee found in public.users with email "${email}".`);
    process.exit(1);
  }

  if (!employee.auth_id) {
    console.error(
      `${employee.name} <${employee.email}> has no auth_id yet — they were never actually provisioned.\n` +
        'Run scripts/provisionAuthUsers.ts instead; it creates their Auth account and prints their first link.'
    );
    process.exit(1);
  }

  const result = await generateLinkFor(employee);
  if (result.error) {
    console.error('Unable to generate a new recovery link:', result.error);
    process.exit(1);
  }

  console.log(`Fresh recovery link for ${result.name} <${result.email}>:\n`);
  console.log(result.link);
  console.log(
    '\nThis link is single-use and does not affect their existing password (if any) until they ' +
      'actually click it and complete SetPasswordScreen.'
  );
}

async function runBatch() {
  const { data: employees, error: queryErr } = await supabaseAdmin
    .from('users')
    .select('id, name, email, auth_id')
    .not('auth_id', 'is', null);

  if (queryErr) {
    console.error('Unable to query provisioned employees:', queryErr.message);
    process.exit(1);
  }

  if (!employees || employees.length === 0) {
    console.log('No provisioned employees found — no public.users row has a non-null auth_id yet.');
    return;
  }

  console.log(`Found ${employees.length} provisioned employee(s). Generating fresh recovery links...\n`);

  const results: LinkResult[] = [];
  for (const employee of employees as Employee[]) {
    const result = await generateLinkFor(employee);
    results.push(result);
    if (result.link) {
      console.log(`[ok] ${result.email}`);
    } else {
      console.error(`[failed] ${result.email}: ${result.error}`);
    }
  }

  const succeeded = results.filter((r) => r.link);
  const failed = results.filter((r) => r.error);

  if (succeeded.length > 0) {
    console.log('\n=== Recovery Links ===\n');
    for (const r of succeeded) {
      console.log(`${r.name} <${r.email}>`);
      console.log(r.link);
      console.log('');
    }
  }

  if (failed.length > 0) {
    console.log('=== Failed ===\n');
    for (const r of failed) {
      console.log(`${r.name} <${r.email}>: ${r.error}`);
    }
    console.log('');
  }

  console.log(`${succeeded.length} link(s) generated, ${failed.length} failed.`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

async function main() {
  if (!rawEmail) {
    await runBatch();
    return;
  }
  await runSingle(rawEmail);
}

main();
