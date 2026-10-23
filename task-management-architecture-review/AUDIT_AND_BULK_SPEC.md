# Trusted Audit and Mutation Contract

## Identity envelope

Every mutation event records the effective employee (`actor_id`), the original authenticated supervisor (`original_actor_id`), an optional server-owned `impersonation_session_id`, a request key and database timestamp. The client supplies only the opaque session reference already issued by the impersonation workflow; `resolve_task_audit_identity` derives both identities from `auth.uid()`, `app_user_id()` and the open `impersonation_sessions` row. Missing, mismatched or ambiguous impersonation context fails closed.

Audit metadata is allowlisted. It contains identifiers, changed-field names, safe reasons and presence flags; it does not store task descriptions, report text, signed URLs, secrets or file contents. Events and completion records are append-only and ordinary roles have SELECT-only access through RLS.

## Concurrency and idempotency

- Task and Daily Activity rows use server-maintained `row_version` and `updated_at` triggers.
- Every mutation locks its target and compares `expected_row_version` before writing.
- `(actor_id, request_key)` plus a SHA-256 payload hash prevents a retry key from being reused with different input.
- Daily Activity normalized links are unique by `(user_id, report_date, task_id)`.
- Bulk item results are immutable after their one pending-to-final transition.

## Secured write surface

`transition_task_v2`, `mutate_task_v2`, `archive_task_v2`, `create_task_bulk_v2`, `remove_user_from_open_tasks_v2`, and the three Daily Activity v2 RPCs are the protected mutation boundary. Assignment membership continues through the existing `set_task_assignees` RPC. Migration 004 revokes table-level and column-level direct writes only after frontend cutover, backfill parity and disposable-database tests pass.
