/**
 * Fails if any of the three App.tsx sites that build a notification recipient list by filtering
 * `users` by ROLE (not a specific known id) is missing its `usersLoadedFromSupabase` guard:
 *   1. The renewal-alert effect (renewalAlertsCheckedRef) -- early-return condition AND dependency
 *      array.
 *   2. notifyOnClientRegistration's per-service team-lead loop.
 *   3. handleSubmitBrief's team-lead notification block.
 *
 * Why: `users` state starts as the INITIAL_USERS demo seed (src/App.tsx) and loadData's own error
 * path never replaces it on a failed/slow fetch, so a role-filter over `users` that runs before
 * the real Supabase fetch resolves can produce demo user ids and violate
 * notifications_user_id_fkey (23503) on insert. usersLoadedFromSupabase is the same guard this
 * file already uses elsewhere for the identical reason (the testing-mode/impersonation selectors).
 * A direct-id notification (client.am_team_lead_id, an explicit agentId parameter, or a freshly
 * re-queried recipient) is not a role filter and is not covered by this check.
 *
 * Run via `npm run lint` (chained after tsc --noEmit) or directly:
 * `npx tsx scripts/checkNotificationUsersLoadedGuard.ts`.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_TSX = join(ROOT, 'src', 'App.tsx');

const source = readFileSync(APP_TSX, 'utf8');

function sliceBetween(startMarker: string, endMarker: string, label: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`Could not find start marker for ${label}: ${JSON.stringify(startMarker)}`);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error(`Could not find end marker for ${label}: ${JSON.stringify(endMarker)}`);
  return source.slice(start, end);
}

// 1. Renewal-alert effect.
{
  const block = sliceBetween(
    'const renewalAlertsCheckedRef = useRef(false);',
    '}, [clients, users, supabaseActive, usersLoadedFromSupabase]);',
    'renewal-alert effect'
  );
  if (!block.includes('!usersLoadedFromSupabase')) {
    throw new Error('Renewal-alert effect is missing its !usersLoadedFromSupabase early-return guard.');
  }
}

// 2. notifyOnClientRegistration's team-lead loop.
{
  const block = sliceBetween(
    'const notifyOnClientRegistration = async',
    'notif-client-registered-service-',
    'notifyOnClientRegistration team-lead loop'
  );
  if (!block.includes('if (!usersLoadedFromSupabase)')) {
    throw new Error('notifyOnClientRegistration\'s team-lead loop is missing its usersLoadedFromSupabase guard.');
  }
}

// 3. handleSubmitBrief's team-lead notification block.
{
  const block = sliceBetween(
    'Notify the relevant department\'s Team Leader only',
    'notif-brief-submitted-',
    'brief-submission team-lead notification'
  );
  if (!block.includes('!usersLoadedFromSupabase')) {
    throw new Error('The brief-submission team-lead notification block is missing its usersLoadedFromSupabase guard.');
  }
}

// Regression: the unrelated fix (notification table/column choice) must stay untouched -- this
// check only ever gates WHEN the role-filter notification code runs, never WHAT it sends.
if (!source.includes("if (error && error.code !== '23505') throw error;")) {
  throw new Error('The existing duplicate-notification (23505) suppression must remain unchanged.');
}

console.log('OK: all three role-filter notification sites in App.tsx are guarded by usersLoadedFromSupabase, and the 23505 suppression is unchanged.');
