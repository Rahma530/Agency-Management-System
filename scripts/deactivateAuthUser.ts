/**
 * Ongoing deactivation tool: ban the Supabase Auth account for every employee whose public.users
 * row has been deactivated in-app (deactivated_at set) but whose auth.users account isn't banned
 * yet. Re-run this any time someone is deactivated via the "Deactivate Employee" action
 * (EmployeeAdminHub.tsx) — it always sweeps whatever is currently pending deactivation, not a
 * fixed list, same idea as scripts/provisionAuthUsers.ts.
 *
 * NOT part of the app bundle — run manually from the terminal with
 * `npx tsx scripts/deactivateAuthUser.ts` (or `npm run deactivate-auth-users`).
 * Uses the Supabase service-role key, which bypasses RLS entirely — never import or reference
 * this script from anything that ships to the browser.
 *
 * WHY BAN, NOT DELETE
 * --------------------
 * "Deactivation" was chosen over hard-deleting the auth.users account specifically because it's
 * reversible: a ~100 year ban_duration locks the account out just as completely as deletion would
 * (they can never sign in again), but a later "reactivate" only needs
 * `admin.updateUserById(id, { ban_duration: 'none' })` plus clearing public.users.deactivated_at —
 * no re-provisioning, no new auth_id, no lost history. `admin.deleteUser()` would be a one-way
 * door: the Auth identity is gone for good, and re-enabling someone would mean running
 * provisionAuthUsers.ts again to create a brand new (different) Auth account for them.
 *
 * WHY IT READS THE LIVE TABLE, NOT A FIXED LIST
 * -----------------------------------------------
 * Same reasoning as provisionAuthUsers.ts: deactivation can happen one employee at a time, from
 * any of the 6 roles authorized to do it (executive/head_of_technical + all 5 team leads), so
 * there's no fixed list to iterate — this just sweeps `deactivated_at is not null` every time.
 *
 * SAFE TO RE-RUN
 * ----------------
 * Each user is handled in its own try/catch so one failure doesn't abort the run. An account
 * that's already banned is simply re-banned (idempotent, not an error) — there's no cheap way to
 * check "already banned" without the same admin call this makes anyway.
 */

import { createClient } from '@supabase/supabase-js';
import { UserRecord } from '../src/types/database';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ~100 years — long enough to be a permanent lockout in practice, while remaining reversible via
// a single admin.updateUserById(id, { ban_duration: 'none' }) call, unlike admin.deleteUser().
const DEACTIVATION_BAN_DURATION = '876000h';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_URL (or VITE_SUPABASE_URL) and/or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'See the terminal commands in the chat message for how to set these for this run only.'
  );
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface ResultRow {
  email: string;
  name: string;
  status: 'banned' | 'skipped_no_auth_id' | 'failed';
  error?: string;
}

async function deactivateOne(user: UserRecord): Promise<ResultRow> {
  const base = { email: user.email || user.id, name: user.name };

  if (!user.auth_id) {
    // A deactivated employee who was never provisioned (still pending) has no Auth account to
    // ban in the first place — not an error, just nothing to do here.
    return { ...base, status: 'skipped_no_auth_id' };
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.auth_id, {
    ban_duration: DEACTIVATION_BAN_DURATION,
  });
  if (error) throw error;

  return { ...base, status: 'banned' };
}

async function main() {
  const { data: deactivatedUsers, error: queryErr } = await supabaseAdmin
    .from('users')
    .select('*')
    .not('deactivated_at', 'is', null);
  if (queryErr) {
    console.error('Unable to query deactivated employees:', queryErr.message);
    process.exit(1);
  }

  if (!deactivatedUsers || deactivatedUsers.length === 0) {
    console.log('No deactivated employees found — nothing to ban.');
    return;
  }

  console.log(`Found ${deactivatedUsers.length} deactivated employee(s). Banning Auth accounts...\n`);

  const results: ResultRow[] = [];
  for (const user of deactivatedUsers as UserRecord[]) {
    try {
      const result = await deactivateOne(user);
      results.push(result);
      console.log(`[${result.status}] ${result.email}`);
    } catch (err: any) {
      results.push({ email: user.email || user.id, name: user.name, status: 'failed', error: err.message || String(err) });
      console.error(`[failed] ${user.email}: ${err.message || err}`);
    }
  }

  console.log('\n=== Summary ===');
  console.table(
    results.map((r) => ({ email: r.email, name: r.name, status: r.status, error: r.error ?? '' }))
  );

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    console.log(`\n${failed.length} account(s) failed to ban — re-run this script to retry just those.`);
    process.exitCode = 1;
  }
}

main();
