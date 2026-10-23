# Regression, Security and Concurrency Test Plan

## Approved-contract update

The prior deferred decisions are resolved. Disposable-database tests must now prove first-assignee
shared completion, active-only All Clients, per-item partial success and retry, approved archive and
restore actors, active/history separation, trusted impersonation identity, and legacy
`assigned_to` fallback only when no normalized assignee rows exist. None is marked passed until it
runs against a disposable Supabase/PostgreSQL database.

## Tests runnable without production

1. Existing TypeScript/static checks.
2. Pure tests for UTC completion date, client/date edit reconciliation, stable task IDs and shared-assignee exclusion.
3. UI tests for inline conflict/loading/error states, filtered select-all and per-item bulk results.
4. Contract tests confirming all task writes use RPCs before direct grants are revoked.

## PostgreSQL integration tests required

Run against a disposable database with transactions rolled back where possible.

### Daily Activity

- Two simultaneous requests for the same employee/date/task: exactly one committed link; retry receives deterministic prior result.
- Same task for different employees is allowed only with distinct individual completion events.
- Same employee/task on a later genuine completion cycle requires an approved rule; default unique daily date permits a later date.
- Wrong actor, assignee, client, UTC date, unfinished task, orphan ID and ambiguous shared task are rejected without partial rows.
- A multi-client daily submission with one invalid item writes nothing.
- Invalid JSON shapes, unknown keys, non-string/duplicate/oversized task IDs and oversized batches
  fail before persistent writes.
- Edit and delete enforce own-row, seven-day and expected-version rules; delete blocks on parity gaps.
- A completion event from a previous lifecycle cycle cannot support a current link.

### Lifecycle and audit

- Every successful mutation produces exactly one matching event.
- A retry with identical key produces no duplicate event; changed payload is rejected.
- Ordinary users cannot insert/update/delete events.
- Close rejects todo/in-progress/in-review/blocked tasks, empty done link, unauthorized actor and stale version.
- Reopen retains previous completion events and creates a new cycle.
- `block`/`unblock` is rejected by `transition_task_v2` until its actor matrix and structured
  blocker contract are approved; later implementation must prove durable history and independent overdue derivation.
- `mark_task_viewed`, reassignment and legacy direct updates increment the version; stale RPC input fails.
- Append-only mutation fails even under service role (database owner/schema changes excluded).

### Batch/bulk

These are required runtime cases for `create_task_bulk_v2`.

- Concurrent All Clients requests with the same key create one batch and one task per snapshot client.
- Different payload with reused key fails.
- RLS-invisible explicit items fail independently; All Clients never snapshots inactive clients and
  revalidates active status under a row lock.
- Bulk partial mode returns an accurate item result for every requested task.
- Bulk duplicate never copies history or Daily Activity links.

### Identity and impersonation

- A normal request records `app_user_id()` and never a payload-supplied actor.
- An impersonated mutation records both identities from the matching open server-owned session;
  omission, substitution and ambiguous open-session cases fail closed.

### Delete/restore

- Soft-deleted tasks disappear from active board queries but remain available to authorized historical viewers.
- Daily-log normalized links, report snapshots and task events remain intact.
- Unauthorized delete/restore fails server-side.
- Storage cleanup never removes an object with another attachment reference.

## Release gates

- Historical conflict queries reviewed and signed off.
- Schema/RPC migrations compile in a disposable PostgreSQL/Supabase environment.
- RLS matrix tests pass for every listed principal.
- Frontend uses only new RPCs for protected columns.
- Direct-write lockdown applied only after a successful real create/edit/complete/close/daily-log smoke test.
- Report source parity is demonstrated before switching away from legacy arrays.
