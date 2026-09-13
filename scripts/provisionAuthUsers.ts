/**
 * Ongoing provisioning tool: create real Supabase Auth accounts for every
 * "pending" employee in the LIVE public.users table (auth_id is null), and
 * link each one back to their row. Re-run this any time new employees are
 * added — via the "Add Employee" admin screen (single form or bulk CSV/
 * Excel upload) or by any other means — it always sweeps whatever is
 * currently pending, not a fixed list.
 *
 * NOT part of the app bundle — run manually from the terminal with
 * `npx tsx scripts/provisionAuthUsers.ts` (or `npm run provision-auth-users`).
 * Uses the Supabase service-role key, which bypasses RLS entirely — never
 * import or reference this script from anything that ships to the browser.
 *
 * WHY IT READS THE LIVE TABLE, NOT A FIXED SEED LIST
 * -----------------------------------------------------
 * This script originally provisioned Auth accounts for the one-time
 * src/data/initialData.ts seed roster. Now that "Add Employee" can create
 * pending public.users rows (auth_id null) at any time — one at a time or
 * by the dozen via a spreadsheet — there is no fixed list to iterate
 * anymore. Querying `auth_id is null` directly is also naturally
 * idempotent: a row that already has a real auth_id (whether provisioned
 * by an earlier run of this script, or otherwise) simply never comes back,
 * no separate "already done" bookkeeping needed.
 *
 * WHY NO PASSWORD IS EVER PRINTED OR STORED
 * -------------------------------------------
 * Each account is created with a random, immediately-discarded password
 * (never logged, never written anywhere) and email_confirm: true so it can
 * sign in right away. Instead of handing that password to anyone, this
 * script also generates a one-time Supabase password-RECOVERY link per user
 * via admin.generateLink() and prints only that. Whoever owns each account
 * clicks their link once, sets their own real password, and the temporary
 * one is never used or seen by anyone.
 *
 * SAFE TO RE-RUN
 * ----------------
 * Each user is handled in its own try/catch so one failure doesn't abort
 * the run — re-running only touches whatever is still pending (either rows
 * that failed last time, or genuinely new ones added since). If an Auth
 * account for the email already exists (e.g. a prior run created the Auth
 * account but failed before the public.users UPDATE), it's looked up and
 * reused instead of erroring out on "already registered".
 */

import { createClient, type User } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { UserRecord } from '../src/types/database';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// Every Supabase Auth account is created with a password this random -
// no one ever needs to know or use it; a recovery link is generated instead.
const randomDiscardedPassword = () => randomBytes(24).toString('base64url');

async function findAuthUserByEmail(email: string) {
  // supabase-js v2's admin API has no direct getUserByEmail; page through
  // listUsers() and match client-side.
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    // supabase-js's listUsers() return type isn't cleanly discriminated on
    // `error`, so `data.users` doesn't narrow past `never[]` here without
    // this cast — the runtime shape is correct regardless.
    const users = data.users as User[];
    const match = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match;
    if (users.length < perPage) return null;
    page += 1;
  }
}

interface ResultRow {
  email: string;
  name: string;
  status: 'provisioned' | 'failed';
  recoveryLink?: string;
  error?: string;
}

async function provisionOne(pendingUser: UserRecord): Promise<ResultRow> {
  const base = { email: pendingUser.email!, name: pendingUser.name };

  // Find-or-create the Auth account.
  let authUser = await findAuthUserByEmail(pendingUser.email!);
  if (!authUser) {
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: pendingUser.email!,
      password: randomDiscardedPassword(),
      email_confirm: true,
      user_metadata: { app_user_id: pendingUser.id, name: pendingUser.name, role: pendingUser.role },
    });
    if (createErr) throw createErr;
    authUser = created.user;
  }

  // One-time password-recovery link — this is what actually gets handed to
  // the employee, never a password.
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery',
    email: pendingUser.email!,
  });
  if (linkErr) throw linkErr;

  // Link the real auth_id back onto the existing public.users row (it was
  // already inserted, pending, by the Add Employee screen — nothing to
  // create here, just complete it).
  const { error: updateErr } = await supabaseAdmin
    .from('users')
    .update({ auth_id: authUser.id })
    .eq('id', pendingUser.id);
  if (updateErr) throw updateErr;

  return { ...base, status: 'provisioned', recoveryLink: linkData.properties.action_link };
}

async function main() {
  const { data: pendingUsers, error: queryErr } = await supabaseAdmin
    .from('users')
    .select('*')
    .is('auth_id', null);
  if (queryErr) {
    console.error('Unable to query pending employees:', queryErr.message);
    process.exit(1);
  }

  if (!pendingUsers || pendingUsers.length === 0) {
    console.log('No pending employees found — every public.users row already has a real auth_id.');
    return;
  }

  console.log(`Found ${pendingUsers.length} pending employee(s). Provisioning...\n`);

  const results: ResultRow[] = [];
  for (const pendingUser of pendingUsers as UserRecord[]) {
    try {
      const result = await provisionOne(pendingUser);
      results.push(result);
      console.log(`[${result.status}] ${result.email}`);
    } catch (err: any) {
      results.push({ email: pendingUser.email || pendingUser.id, name: pendingUser.name, status: 'failed', error: err.message || String(err) });
      console.error(`[failed] ${pendingUser.email}: ${err.message || err}`);
    }
  }

  console.log('\n=== Summary ===');
  console.table(
    results.map((r) => ({
      email: r.email,
      name: r.name,
      status: r.status,
      recovery_link: r.recoveryLink ?? '',
      error: r.error ?? '',
    }))
  );

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    console.log(`\n${failed.length} user(s) failed — re-run this script to retry just those (everyone else will be skipped).`);
    process.exitCode = 1;
  }

  const provisioned = results.filter((r) => r.status === 'provisioned');
  if (provisioned.length > 0) {
    console.log(
      `\n${provisioned.length} account(s) newly provisioned. Send each person their own recovery_link above ` +
        `(each is single-use and lets them set their own real password) — none of them have a usable password yet.`
    );
  }
}

main();
