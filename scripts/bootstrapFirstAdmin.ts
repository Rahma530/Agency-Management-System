/**
 * ONE-TIME BOOTSTRAP: inserts the very first public.users row directly,
 * bypassing RLS with the service-role key. Needed once per database
 * (fresh project, or after a canonical-schema rebuild that empties
 * public.users) — never part of ongoing operation.
 *
 * THE PROBLEM THIS SOLVES
 * ------------------------
 * Every RLS policy in this schema resolves the caller's identity via
 * app_user_id()/app_user_role(), both of which do:
 *   select id/role from public.users where auth_id = auth.uid()
 * With public.users empty, that returns null for ANY real authenticated
 * person, no matter who they are — there is no row yet linking their
 * auth.uid() to a role, so users_insert_admin_rls (which requires
 * app_user_role() in ('executive','head_of_technical')) can never pass.
 * A real login alone cannot break this cycle — someone has to insert the
 * first row from outside the app's normal RLS-gated path.
 *
 * WHAT IT DOES
 * -------------
 * Inserts exactly one public.users row (auth_id null — "pending", the
 * same state an Add-Employee-created row is in) and stops. It does NOT
 * create a Supabase Auth account or a password. Run
 * scripts/provisionAuthUsers.ts immediately after this — it sweeps every
 * pending row (auth_id is null), so it will pick this one up and print a
 * one-time password-recovery link exactly like it does for any other
 * newly-added employee.
 *
 * NOT part of the app bundle — run manually:
 *   npx tsx scripts/bootstrapFirstAdmin.ts "Full Name" "email@example.com" [role]
 * [role] defaults to "executive"; pass "head_of_technical" if that fits
 * better. Uses the Supabase service-role key — never import or reference
 * this from anything that ships to the browser.
 *
 * REFUSES TO RUN IF public.users IS NOT EMPTY
 * ----------------------------------------------
 * This script's entire reason to exist is the empty-table chicken-and-egg
 * problem. Once any row exists, the normal paths take over: an existing
 * executive/head_of_technical can add people through the app's "Add
 * Employee" screen (single form or bulk upload), and
 * scripts/provisionAuthUsers.ts links real Auth accounts to whatever's
 * pending. If you're looking at a table that already has orphaned pending
 * rows from before this script existed, handle those by hand (or via the
 * app once someone has a working session) — don't run this here.
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

const BOOTSTRAP_ROLES = ['executive', 'head_of_technical'] as const;
type BootstrapRole = (typeof BOOTSTRAP_ROLES)[number];

// Matches AGENCY_ROLES' team value for each of these two roles exactly
// (src/data/roles.ts) — kept in sync by hand since this script can't
// import frontend modules.
const TEAM_BY_ROLE: Record<BootstrapRole, string> = {
  executive: 'Executive',
  head_of_technical: 'Technical',
};

const [, , rawName, rawEmail, rawRole] = process.argv;

if (!rawName || !rawEmail) {
  console.error(
    'Usage: npx tsx scripts/bootstrapFirstAdmin.ts "Full Name" "email@example.com" [executive|head_of_technical]\n' +
      '  role defaults to "executive" if omitted.'
  );
  process.exit(1);
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
  console.error(`"${rawEmail}" doesn't look like a valid email address.`);
  process.exit(1);
}

const role = (rawRole || 'executive') as BootstrapRole;
if (!BOOTSTRAP_ROLES.includes(role)) {
  console.error(`Invalid role "${rawRole}" — must be one of: ${BOOTSTRAP_ROLES.join(', ')}`);
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { count, error: countErr, status, statusText } = await supabaseAdmin
    .from('users')
    .select('*', { count: 'exact', head: true });
  if (countErr) {
    console.error('Unable to check public.users — full error details:');
    console.error(
      JSON.stringify(
        {
          message: countErr.message,
          details: countErr.details,
          hint: countErr.hint,
          code: countErr.code,
          status,
          statusText,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
  if (count && count > 0) {
    console.error(
      `public.users already has ${count} row(s) — refusing to run. This script only exists to break the ` +
        `empty-table chicken-and-egg problem; once any row exists, add people through the app's "Add Employee" ` +
        `screen (as executive/head_of_technical) or scripts/provisionAuthUsers.ts, never this script.`
    );
    process.exit(1);
  }

  const id = `usr-${Date.now().toString().slice(-4)}-${Math.random().toString(36).slice(2, 6)}`;

  const { error: insertErr } = await supabaseAdmin.from('users').insert([
    {
      id,
      name: rawName,
      email: rawEmail.toLowerCase(),
      role,
      team: TEAM_BY_ROLE[role],
      auth_id: null,
      created_at: new Date().toISOString(),
    },
  ]);
  if (insertErr) {
    console.error('Unable to insert the first admin row:', insertErr.message);
    process.exit(1);
  }

  console.log(`Inserted the first admin row: ${rawName} <${rawEmail}> (${role}), id=${id}.`);
  console.log(
    '\nNext step: run scripts/provisionAuthUsers.ts (or `npm run provision-auth-users`) — it will pick this row ' +
      'up (auth_id is null) and print a one-time password-recovery link for this account, exactly like it does ' +
      'for any other newly-added employee. No password is set here.'
  );
}

main();
