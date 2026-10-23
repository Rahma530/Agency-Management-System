# Final SQL, Security, and Data-Consistency Review

## Resolution addendum (2026-10-15)

The product blockers recorded below are resolved in the current drafts: generic edits use
allowlisted optimistic RPCs; active and historical visibility are separate; shared completion uses
individual evidence and first-assignee completion; All Clients is active-only with partial item
results; archive/restore uses the approved actor set; and impersonation audit derives both
identities server-side. Remaining BLOCKED gates are runtime-only: production-lineage evidence and
disposable-database compilation, RLS/role, concurrency, rollback and retry tests.

Package status: **READY FOR DISPOSABLE-DB TESTING**; explicitly **NOT READY FOR PRODUCTION**.

Final status: **READY FOR DISPOSABLE-DB TESTING**. Nothing in this package has been executed, and
production remains blocked until the runtime gates pass.

## Defect register

| Severity | Defect and evidence | Required resolution | Current disposition |
|---|---|---|---|
| Critical | Direct `authenticated` UPDATE on `tasks` remains in the latest repository policy/grant (`20261104100000_task_visibility_cutover.sql`, `tasks_update_rls`). A trigger can increment a version but cannot make an unversioned direct UPDATE reject stale input. | Add audited expected-`row_version` RPCs for every editable field, cut the frontend over, then revoke both table- and column-level direct UPDATE. | **BLOCKER; not invented in this review.** |
| Critical | Adding `archived_at` alone does not hide archived rows: current `tasks_select_rls` and `task_visible_v2` do not inspect it, while Report Workspace SECURITY DEFINER sources intentionally need historical rows. | Approve archive/restore actors; introduce active-task policies and dedicated historical visibility; audit every board/capacity/notification query; preserve report snapshots. | **BLOCKER.** No archive RPC is created. |
| Critical | Shared-task task-level completion has no approved rule. Assignment does not prove completion. | Approve all-current-assignees, one-assignee, or coordinator rule. Recommendation: every current assignee must record the current cycle, with an explicit coordinator override audited separately. | **Business blocker.** Draft records individual evidence but leaves shared task status unchanged. |
| High | Original draft did not update `updated_at`/`row_version` on legacy paths. | Server BEFORE UPDATE triggers now overwrite both values on every task/log update. RPCs use expected `row_version`. | Fixed statically in 001/002; runtime test required. |
| High | Original completion evidence was not tied to a task reopen cycle, and mutable revocation columns contradicted append-only history. | `lifecycle_cycle` is incremented on reopen; completion rows bind to `task_cycle`; revocations are separate append-only rows. | Fixed statically; runtime test required. |
| High | Original Daily Activity RPC accepted weak JSON shapes, duplicates and unbounded payloads. | Validate object keys/types, non-empty values, maximum 50 entries/100 tasks/5,000 text characters, duplicate IDs and accessible clients before data writes. | Fixed statically in 002. Limits need product confirmation. |
| High | Direct create/edit/delete of `daily_logs` could desynchronize the array and normalized table. | Atomic v2 create/edit/delete RPCs maintain both; 003 preserves historical claims; 004 removes table- and column-level direct writes only after parity and frontend cutover. | Fixed in proposal; frontend cutover/runtime verification still required. |
| High | Original `SECURITY DEFINER` code could bypass client RLS and ignored legacy `assigned_to`. | Private helpers mirror current `clients_select_rls`; normalized assignees are authoritative with legacy fallback only when zero normalized rows exist. Foundation aborts on sync drift. | Fixed statically; every role needs RLS tests. |
| High | Existing table-level task INSERT/UPDATE would automatically expose newly added system columns (`row_version`, cycle and archive identity) to direct callers. | 001 replaces table-level writes with an explicit legacy-column allowlist; system columns remain owner/RPC-only. | Fixed statically; compare effective column privileges in test DB. |
| High | Original audit accepted arbitrary payloads and completion evidence and allowed service-role mutation. | JSON key allowlists, size bounds, sanitized event construction, and UPDATE/DELETE rejection triggers on event/evidence/revocation ledgers. | Fixed statically. Database owner can still deliberately alter schema, which is outside the application trust boundary. |
| High | All Clients and bulk RPCs are absent. Existing `create_task_copy` is only idempotent per client and frontend iteration can partially succeed. | Approve eligibility and partial-success semantics, then add server snapshot/batch RPC and per-task bulk results using the same predicates. | **BLOCKER for those features.** |
| Medium | `mark_task_viewed` and assignment reverse-sync update `tasks`, so the proposed universal trigger increments `row_version` for those changes. | Treat them as real conflicts or split content/lifecycle and observational versions. Recommendation: keep one version initially; refresh on conflict. | Intentional conservative behavior; performance/UX test required. |
| Medium | `IF NOT EXISTS` cannot prove an existing object's shape. | 001 validates prerequisite columns, proposal-column types, explicit task FKs, required proposal-table columns, concurrency keys and payload/snapshot checks; post-migration verification still inspects all definitions. | Hardened statically, but test database lineage comparison remains mandatory. |
| Medium | Historical arrays can contain duplicates, orphans, wrong clients/dates or ambiguous shared-task attribution. | Run conflict SQL, resolve explicitly, then 003 copies only exact surviving claims with `historical_unknown`; it creates no completion actor/event. | No production evidence gathered; gate remains open. |
| Medium | Current broad visibility-based task UPDATE allows roles such as Marketing Manager to mutate tasks they can merely view. | Preserve current behavior only for initial compatibility or approve a narrower action matrix. Recommendation: narrow mutations to creator, assignee, managing lead/AM, and leadership. | Business decision required before generic mutation RPC. |
| High | `app_user_id()` resolves the user attached to the current `auth.uid()`. Employee impersonation signs in as the employee; `impersonation_sessions` records the originating admin separately, but task events have no session/admin foreign key. An event therefore proves the effective employee identity, not necessarily the human who initiated the action. | Decide whether the audit contract needs both effective actor and originating admin. If yes, add a server-derived `impersonation_session_id`/initiator reference and test that there is at most one qualifying open session; never accept either ID from the client. | **BLOCKER for a human-actor audit claim.** Existing effective-actor authorization remains fail-closed. |
| High | A completed idempotent retry originally returned the resource's latest state, which could misrepresent an earlier successful payload after a later edit. | 002 now stores the committed row version(s), validates ID/version set equality on retry, and requires the caller to reload when the resource subsequently changed. | Fixed statically; concurrent PostgreSQL test required. |
| High | `block`/`unblock` originally inherited broad visibility-based mutation without an approved action matrix. | Those actions were removed from the SECURITY DEFINER transition RPC. Existing legacy behavior is unchanged until a role matrix and structured blocker contract are approved. | Fixed fail-closed in the proposal; feature remains a business blocker. |
| Medium | A same-named prerequisite could fail after a drift query dereferenced it, and batch snapshots accepted blank/duplicate IDs or arbitrary hashes. | 001 now checks required tables/functions/legacy columns before DDL, validates batch client arrays with an ungranted immutable helper, and constrains hashes to SHA-256 hex. | Fixed statically; incompatible-object and re-run tests required. |

## Archived-task query inventory

- `src/App.tsx:1554` loads all RLS-visible tasks; an active-only `tasks_select_rls` would remove
  archived rows from every board fed by this collection without frontend-only filtering.
- `task_visible_v2`, task comment/attachment policies, storage policies, `employee_visible`, and
  the task-derived branches of `clients_select_rls` all read task relationships. A final archive
  migration must decide which use active-only visibility and which preserve historical access.
- `get_capacity_snapshot` must exclude archived tasks explicitly because it is SECURITY DEFINER.
- Report source functions in migrations 072/073 read task evidence under SECURITY DEFINER. They
  should retain immutable historical/report evidence, while new active-work calculations must not
  treat an archived unfinished task as active capacity.
- `set_task_assignees`, `mark_task_viewed`, task-copy lookup, comments, attachments, notifications
  and client visibility need explicit archived-task tests. Changing `task_visible_v2` globally is
  unsafe because it would also remove authorized access to archived history.

This inventory is why the package does not create a superficial `archived_at is null` filter in a
single helper. The safe design needs separate `task_active_visible_v2` and
`task_history_visible_v2` contracts and a reviewed cutover of each caller.

## Proposed migration order and dependencies

1. `historical_conflicts_READ_ONLY.sql` — no writes. Review every non-empty result.
2. `001_task_integrity_foundation_NOT_EXECUTED.sql` — depends on migrations 030/040/041/050,
   synchronized `task_assignees`, current clients policy lineage, canonical task/daily-log columns,
   and PostgreSQL `sha256(bytea)`. Its early prerequisite checks run before drift scans.
3. `002_transactional_rpc_contracts_NOT_EXECUTED.sql` — depends on 001. Adds bounded/idempotent
   Daily Activity create/edit/delete and limited task lifecycle RPCs.
4. `003_daily_link_backfill_NOT_EXECUTED.sql` — depends on zero duplicate/orphan conflicts. Copies
   legacy links exactly as `historical_unknown`; it does not rewrite the source arrays. It takes
   bounded `SHARE ROW EXCLUSIVE` locks on both mirror tables and fails after five seconds rather
   than waiting indefinitely.
5. Frontend cutover and test-database validation — not present in this planning package.
6. `004_daily_activity_write_lockdown_NOT_EXECUTED.sql` — only after full parity and successful
   smoke tests. Run it immediately after 003 in the same controlled write-free release window. It
   locks both mirror tables for the final parity check, then revokes table- and column-level direct
   Daily Activity writes. The two files are separate transactions, so operational write quiescence
   is required across their boundary.
7. A future task-mutation/archive/batch migration — blocked by the decisions below. Only after it
   and frontend cutover may direct task UPDATE be revoked.

The proposal migrations use one transaction and an explicit session flag so accidental execution
fails before DDL. Re-running an exact successful migration is intended to be harmless where objects
are replaced/dropped and recreated; a partial or differently shaped lineage must fail rather than be
treated as compatible merely because a name exists.

## Backfill rules

- Never create historical `task_completion_events`, actors, cycles, or task events from status,
  assignment, `completed_at`, or log ownership.
- A legacy array link may be copied to the normalized table only after duplicates and orphans are
  resolved. Its owner/date/client are copied from the existing Daily Log as historical facts, while
  attribution remains `historical_unknown`.
- Wrong date/client/assignment findings require owner/business review. No automatic correction,
  merge, deletion or reassignment is proposed.
- New v2 links are `confirmed` only when a non-revoked completion event for the same employee,
  task, UTC date and current task cycle exists.
- Reopening never modifies or deletes an earlier completion event or Daily Activity link.

## Permission matrix

| Actor | View | Ordinary edit | Individual complete | Close/reopen | Assign | Archive/restore | Batch/All Clients |
|---|---|---|---|---|---|---|---|
| Executive / Head of Technical / AI Engineer | Current broad visibility | Current SQL permits; future RPC required | Only if assignee recommended | Current `task_closable` allows close/reopen | Existing assignment RPC | Decision required | Create allowed; eligibility decision required |
| Creator, non-Sales | Own task | Current policy allows | Only if assignee | Allowed by current close predicate | Existing RPC allows | Archive recommended; restore decision required | Create allowed |
| Current assignee | Assigned task | Current policy allows | Yes, own current cycle | SQL allows | Existing RPC allows with safeguards | Decision required | Create allowed if non-Sales |
| Matching team lead | Team-visible | Current policy allows | Only if assignee | Only creator/assignee/admin currently | Existing scoped RPC | Leadership policy decision | Create allowed |
| Managing AM agent | Client-visible | Current policy allows | Only if assignee | Only creator/assignee/admin | Existing scoped RPC | Decision required | Accessible clients only |
| Marketing Manager | Narrow creative visibility | Current SQL also permits UPDATE; likely too broad | Only if assignee | Only creator/assignee | Assignment RPC denies management-only visibility | No recommendation without approval | Accessible clients only |
| Custom/non-lead agent | Creator/assigned/parent-derived only | Current policy allows visible tasks | Only if assignee | Creator/assignee | Existing RPC rules | Decision required | Non-Sales create rule |
| Sales | No task access | No | No | No | No | No | No |

No new approval stage is proposed. `completed` remains task completion and `closed` remains the
existing final manual state with `done_link` enforced server-side.

## Required PostgreSQL/Supabase tests (not executed)

- Compile all four files from a repository-equivalent schema inside a disposable Supabase project.
- Assert every role above against real JWT claims, including custom roles and impersonation.
- Two sessions submit the same employee/date/task: one commit, one deterministic conflict/retry,
  no extra log/event/request rows.
- Concurrent identical request keys return one result; different payload reuse fails; a statement
  error rolls back request, logs, links and events together.
- After a successful request, mutate/delete one returned row and replay the same key: the RPC must
  reject the stale replay rather than present current content as the original result.
- Concurrent stale task/log versions reject the loser after `mark_task_viewed`, assignment changes,
  content changes and lifecycle transitions.
- Invalid JSON scalar/object keys, non-string task IDs, duplicates, oversized requests, invisible
  clients/tasks, wrong client/date/status/cycle, revoked evidence and archived tasks all write zero.
- Edit changes date/client/tasks atomically; unchanged historical links remain untouched; delete is
  rejected until array/normalized parity exists.
- Reopen increments the cycle while prior evidence remains readable; old-cycle evidence cannot
  support a new Daily Activity link.
- Append-only UPDATE/DELETE fails for authenticated, anon and service role; unauthorized SELECT
  follows task/log visibility.
- Migration re-run succeeds on exact shape and rolls back on a deliberately conflicting shape.
- 003 aborts on duplicates/orphans and achieves exact two-way parity on a clean fixture.
- A concurrent legacy Daily Activity writer cannot slip through either 003's snapshot or 004's
  final parity/revoke boundary; lock timeout aborts cleanly with no partial backfill.
- 004 removes effective table and column write privileges while RPCs still succeed.
- Archived-task active/historical behavior cannot be tested until the blocked policy/RPC design is approved.
- An ordinary employee session and an impersonated employee session must be distinguished in the
  audit expectations. If originating-admin attribution is required, tests remain blocked until the
  event schema has a server-derived impersonation-session reference.

## Approved business decisions

1. **All Clients:** `status='active'`, server-resolved and revalidated.
2. **Shared completion:** first authorized assignee evidence completes the task.
3. **Ordinary mutation scope:** creator, assignee, managing team lead/AM, and Executive/Head/AI;
   view-only exceptions do not imply edit authority.
4. **Archive/restore:** creator, current responsible assignee, or Executive/Head/AI.
5. **Bulk task creation:** per-item partial results; Daily Activity remains one atomic submission.
6. **Overdue timezone:** recommend `Africa/Cairo` business date for due-date UI; keep completion
   evidence on the established UTC calendar-date convention.
7. **Payload limits:** recommend 50 Daily Activity rows, 100 task links and 5,000 characters per
   summary unless measured production usage proves these insufficient.
8. **Impersonation attribution:** store both effective employee and original supervisor from the
   trusted server-owned session.

## Remaining gate

The architecture is complete enough for a disposable database. Production remains blocked until
historical conflicts are reviewed and PostgreSQL syntax, RLS, role scope, concurrent completion,
partial-item rollback, idempotent retry and migration recovery are executed successfully.
