# Task Management and Daily Activity Architecture Review

## Final approved implementation update (2026-10-15)

The five previously open product decisions are binding and implemented in drafts 001–004 and the
frontend cutover. Shared completion is first authorized-assignee evidence; All Clients is the
server-resolved active/authorized snapshot; bulk creation is per-item partial success; archive and
restore are creator/current-assignee/leadership actions; and mutation audit derives original plus
effective identities from the trusted impersonation session.

Status: **READY FOR DISPOSABLE-DB TESTING**, not production. Static checks cannot prove PostgreSQL
syntax, grants, RLS behavior, concurrent requests or rollback semantics. The explicit draft guard
remains in every migration.

Status: **proposal only — NOT EXECUTED**
Repository snapshot reviewed: local branch `claude/report-archive-delete-ui`, including its existing modified and untracked work.

## Scope and evidence

This package is based on static repository inspection only. No database connection was made, so it does not assert which migrations are applied or what production data contains. The read-only SQL files in this directory are the required next evidence-gathering step.

Primary evidence:

- `src/types/database.ts:114-120,383-451` — current task statuses and task/assignee shapes.
- `src/lib/taskLifecycle.ts:6-53` — done semantics, close UI gates, and multi-assignee fallback.
- `src/App.tsx:3798-4083` — direct status/detail writes, client-side `completed_at`, multi-client creation and recovery.
- `src/lib/taskOperations.ts:78-143` — sequential per-client `create_task_copy` calls and per-copy failure reporting.
- `src/components/CrossTeamTaskBoard.tsx:797-924,1066-1099,2301-2617` — create/edit/status UX.
- `src/lib/dailyActivity.ts` and `src/components/DailyLogEditModal.tsx` — current UTC/date/client/link validation.
- `supabase/migrations/20261103000000_task_assignees_foundation.sql` — assignment membership and append-only assignment log.
- `supabase/migrations/20261104000000_task_visibility_functions.sql` and `20261104100000_task_visibility_cutover.sql` — current task visibility/update/close policies.
- `supabase/migrations/20261105000000_task_assignees_rpcs.sql` — assignee RPC, batch/client uniqueness and idempotent single-copy RPC.
- `supabase/migrations/20261107300000_report_workspace_lifecycle_hardening.sql:136-171` — report task evidence depends on daily-log task links.

## Confirmed current behavior

### Daily Activity

- Creation/editing uses UTC `completed_at` calendar dates.
- `task_assignees` is authoritative when rows exist; `tasks.assigned_to` is legacy fallback only.
- The current local edit validation checks employee, completion state/date, exact client, duplicate IDs, and links in other logs for the same employee/date.
- Shared tasks are not automatically offered as individual work because the schema has no individual completion actor.
- `daily_logs.linked_task_ids` remains a `text[]`; there is no database uniqueness contract for `(employee, report date, task)` and no atomic submission RPC.

### Task lifecycle

Current states are `todo`, `in_progress`, `in_review`, `completed`, `blocked`, and `closed`. `completed` and `closed` are both treated as done by KPIs/capacity/overdue logic. `closed` is described as manual confirmation after completion.

`completed_at` is generated in browser code and cleared whenever the task returns to a non-done state. Reopening therefore destroys the task row's prior completion timestamp. There is no completion-event history.

The UI requires a `done_link` before Close, but the database update policy only checks `task_closable(id)` when the resulting status is `closed`; it does not enforce the prior status or `done_link`. A direct API update can therefore bypass the UI prerequisite.

`task_closable` accepts any real assignee, creator, Executive, Head of Technical or AI Engineer. The UI `canCloseTask` still reads legacy `assigned_to`, so a non-primary co-assignee can be allowed by SQL but denied by the UI.

### Multi-client creation

- Explicit multiple client selection already creates independent tasks with independent IDs/lifecycles.
- Tasks share `batch_id`; `(batch_id, client_id)` is unique when batch is non-null.
- `create_task_copy` is retry-safe per client.
- The frontend calls the RPC sequentially, so the batch is not atomic. Local recovery records expose partial success rather than claiming total success.
- The New Task picker has no explicit All Clients command and does not define active-client eligibility. It uses the RLS-filtered `clients` prop.

### Audit and deletion

- `task_assignee_log` reliably records assignment membership changes made through the controlled RPC; legacy trigger entries can attribute the creator rather than the true editor.
- `activities` is append-only under RLS but is client-authored: the caller supplies action, target, details and timestamp. It is useful UI telemetry, not a trusted task audit ledger.
- No task DELETE grant/policy/action exists. Comment soft deletion and attachment-reference deletion do exist.
- Hard task deletion would conflict with comments/attachments and erase assignment membership; arrays in historical daily logs and immutable report snapshots would retain opaque task IDs.

### Overdue and Blocked

- Overdue already exists as a derived UI condition: due date before the browser-local current date and status not completed/closed. Blocked tasks can also be overdue.
- Blocked is an explicit status, but the reason is prepended into description text and optionally copied into `extra_notes`. There is no structured blocker lifecycle or resolution event.

## Confirmed defects

1. **Concurrent daily-log duplicate risk:** two requests can link the same task for the same employee/date.
2. **No trusted individual completion evidence:** task assignment and task-level completion cannot prove which co-assignee completed work.
3. **Completion history loss:** reopening clears `completed_at`; repeated completion overwrites the only task-level event.
4. **Direct mutation/audit gap:** task status/details are updated directly from the browser and audit insertion is best-effort and separate.
5. **Close invariant gap:** database does not enforce completed -> closed or non-empty `done_link`.
6. **Co-assignee UI/SQL mismatch:** SQL permits any assignee to close; UI checks only legacy primary assignee.
7. **No atomic multi-client batch:** individual copies are idempotent, but the complete batch may partially succeed.
8. **No explicit All Clients semantics:** current multi-select has no server-resolved active-client snapshot.
9. **No complete task history:** only assignment changes are structurally audited.
10. **No task delete/archive lifecycle:** consequently no safe recovery or retention behavior exists.

## Proposed architecture

### Shared foundation

Use one trusted `task_events` ledger for task creation, field/status changes, assignment references, completion events, blockers, archive/restore and batch operations. Ordinary users receive SELECT only through task visibility; writes occur only from controlled functions/triggers.

Use `task_completion_events` for individual completion evidence. Assignment alone never creates an event. Reopening does not delete prior events; a new completion cycle gets a new sequence.

Because the proposed Daily Activity RPC is `SECURITY DEFINER`, it must not rely on caller RLS being applied inside the function. The foundation draft therefore proposes an ungranted `client_visible_for_task_rpc(text)` helper that mirrors the current `clients_select_rls` lineage, and the RPC checks it even for manual, task-less entries. The helper and the client policy become one authorization contract and must be reviewed and changed together. The RPC also rechecks current assignment, task-level done state, UTC completion date, exact client, and an unrevoked individual completion event before inserting a normalized link.

Normalize daily-log links into `daily_log_task_links`, preserving `linked_task_ids` temporarily as a compatibility mirror. Uniqueness on `(user_id, report_date, task_id)` supplies the missing concurrency guarantee.

### Mutation boundary

Introduce controlled RPCs for create batch, task mutation, lifecycle transitions, blocker transitions, daily-activity submission and bulk actions. Each accepts a caller-generated request key and stores/validates a payload hash. The effective database actor always comes from `app_user_id()`; it is never accepted from the payload. During the repository's impersonation flow that identity is the impersonated employee, while the originating admin exists only in `impersonation_sessions`. A trusted human-initiator audit therefore needs a separate server-derived session/initiator reference before cutover.

After frontend cutover and runtime verification, revoke direct UPDATE privileges on lifecycle/audited task columns. This must be a separate lockdown step, analogous to Report Workspace migration 074.

### Daily Activity atomicity

One batch RPC accepts all client-specific rows for a day. It validates all items before writing anything. Default behavior is all-or-nothing because silent partial daily reports are unsafe. On retry with the same key and identical payload it returns the prior rows; a different payload for the same key is rejected.

### Shared-task completion

Recommend a dedicated per-employee completion-event model rather than `tasks.completed_by`. A single column cannot represent multiple employees, repeated completion cycles, reopenings, evidence, or revocation. Historical tasks remain `attribution_unknown`; no actor is inferred.

### Delete

Recommend soft archive/delete on the task row (`archived_at`, `archived_by`, `archive_reason`) with a trusted event. Do not hard-delete task rows while daily logs, reports, audit events, comments, attachments or batch relationships reference them. Archive/restore RPCs remain blocked on the approved actor matrix. A later retention job may clean storage only after proving zero references and preserving a tombstone.

## Compatibility rules

- Existing `linked_task_ids` remains readable during migration; reports continue using it until the normalized source function is released and verified.
- Existing historical task completion remains task-level only. It is not copied into individual completion events.
- KPI formulas remain unchanged. A later approved KPI migration may switch employee metrics to completion events.
- Existing task rows are not converted, duplicated, archived or deleted automatically.
- Existing report source snapshots remain immutable.

## Implementation order

1. Run `historical_conflicts_READ_ONLY.sql`; resolve or explicitly waive conflicts.
2. Review the product decisions listed below.
3. Apply a schema-foundation migration in a test environment: trusted event ledger, completion events, normalized daily links, request/idempotency tables and soft-delete columns.
4. Backfill only provable relationships. Duplicate/orphan/ambiguous rows go to a review table or exported conflict report, never silently merged.
5. Release transactional daily-activity and task-mutation RPCs while retaining legacy reads.
6. Cut frontend writes to RPCs; add task history UI, explicit All Clients snapshot, inline editing and bulk result reporting.
7. Run concurrency/RLS/rollback tests.
8. Switch report source collection to normalized links and verify parity.
9. After duplicate/orphan conflicts are resolved and the frontend uses v2, quiesce legacy Daily
   Activity writes and apply `003_daily_link_backfill_NOT_EXECUTED.sql`.
10. In the same controlled write-free release window, immediately apply
    `004_daily_activity_write_lockdown_NOT_EXECUTED.sql`. Their locks are bounded, but the files are
    separate transactions; do not allow old direct writers between them.
11. Do not lock down task writes until generic audited task mutation and archive/batch RPCs exist.

## Risks

- Current production lineage is unknown until the read-only prerequisite query is run.
- Backfilling normalized links can fail on duplicates that arrays currently allow.
- Introducing FK `RESTRICT` against tasks changes future deletion behavior intentionally.
- Switching employee KPIs to individual events is a product change and is not included.
- Full batch atomicity changes today's recoverable partial-success behavior; approval is required.

## Remaining non-blocking product choices

- A future hard-purge retention period is still undefined; this release implements archive/restore only.
- Due-date Overdue remains browser-local while completion evidence uses the established UTC date.
- Payload bounds are 50 Daily Activity rows, 100 links and 5,000 summary characters pending usage data.

## Release readiness

**READY FOR DISPOSABLE-DB TESTING.** Production is still blocked by historical-conflict review and
runtime PostgreSQL/RLS/concurrency/rollback tests. The SQL drafts deliberately fail closed unless a
review-only session flag is set; they were not executed or runtime-tested.
