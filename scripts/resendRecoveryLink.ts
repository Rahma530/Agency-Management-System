/**
 * Re-issues a fresh one-time password-recovery link for an employee who
 * already has a real Supabase Auth account (public.users.auth_id is
 * already set) but never received or used their original link.
 *
 * Unlike scripts/provisionAuthUsers.ts — which only looks at rows where
 * auth_id IS NULL and creates a brand-new Auth account for each — this
 * script does NOT create anything. It looks up the existing Auth account
 * by email and asks Supabase to mint a new one-time recovery link for it.
 * The employee's password (if they ever set one) is untouched until they
 * actually click the new link and go through SetPasswordScreen again.
 *
 * NOT part of the app bundle — run manually:
 *   npx tsx scripts/resendRecoveryLink.ts "employee@agency.com"
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

if (!rawEmail) {
  console.error('Usage: npx tsx scripts/resendRecoveryLink.ts "employee@agency.com"');
  process.exit(1);
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
  console.error(`"${rawEmail}" doesn't look like a valid email address.`);
  process.exit(1);
}

const email = rawEmail.trim().toLowerCase();

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
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

  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery',
    email: employee.email,
  });

  if (linkErr) {
    console.error('Unable to generate a new recovery link:', linkErr.message);
    process.exit(1);
  }

  console.log(`Fresh recovery link for ${employee.name} <${employee.email}>:\n`);
  console.log(linkData.properties.action_link);
  console.log(
    '\nThis link is single-use and does not affect their existing password (if any) until they ' +
      'actually click it and complete SetPasswordScreen.'
  );
}

main();
