# All Clients and Partial-Success Batch Contract

## Approved behavior

- `all_clients` is mutually exclusive with explicit client IDs.
- The server resolves the immutable snapshot from `public.clients` where `status = 'active'` and `client_visible_for_task_rpc(id)` is true.
- Each client row is revalidated and locked `FOR KEY SHARE` while its task is created, so a concurrent status change cannot make a stale active-client decision.
- Explicit requests preserve input ordinality, including invalid and duplicate items. All Clients uses deterministic client-ID order.
- Each item runs in a PL/pgSQL exception subtransaction. One failed item rolls back its task, assignments and event only; unrelated successful items remain eligible to commit.
- `task_batch_items(batch_id,item_ordinal)` stores a stable result. A retry with the same actor, request key and payload returns stored results; a changed payload is rejected.
- Every created task has an independent ID and lifecycle. Batch membership never couples later status, completion, archive or restore actions.

## Frontend contract

The Create Task form exposes an explicit All active clients option. It does not send the currently loaded client IDs in that mode. The UI calls `create_task_bulk_v2` once and displays item-level failures without reporting total success. The existing local recovery record retains the same UUID request key for safe retry.

Attachments remain a post-database workflow because Storage cannot share the PostgreSQL transaction. A confirmed task row is never deleted merely because a later attachment step fails.
