-- Backfills tasks.done_link from the now-deprecated tasks.drive_link for existing rows, so a task
-- that already had a Drive Link keeps showing SOMETHING in the one surviving link field (Done
-- Link) after the frontend stops reading/writing drive_link entirely (see
-- src/components/CrossTeamTaskBoard.tsx and DailyOperationsModule.tsx, same PR).
--
-- ONLY copies where done_link is currently null or blank (whitespace-only) — never overwrites an
-- existing done_link, even if it differs from drive_link. drive_link itself is left completely
-- untouched (column NOT dropped, value NOT cleared) — this is a one-time copy, not a rename or
-- migration-away; see the column's own comment in src/types/database.ts for why it's kept.
--
-- Idempotent: re-running this is a no-op the second time, since by then every row it would have
-- touched already has a non-blank done_link (including the exact value this migration just set).
--
-- Trigger audit (every trigger ever attached to public.tasks, across the full migration
-- history — `grep -n "create trigger\|drop trigger" supabase/migrations/*.sql` plus a check for
-- any bare/generic "on public.tasks" UPDATE trigger, an updated_at column, or an audit/activity-
-- log/notifications trigger tied to a plain UPDATE): there are exactly two, and BOTH are
-- column-scoped, neither naming done_link:
--   1. tasks_enforce_nesting_depth — `before insert or update OF parent_task_id`
--      (20260908150000_task_subtasks_and_comments.sql, carried through the canonical_schema
--      v2-v4 rebuilds).
--   2. sync_legacy_assigned_to_to_task_assignees_trigger — `after insert or update OF
--      assigned_to, assignee_viewed_at` (20261103000000_task_assignees_foundation.sql) — this is
--      the one that would fire a "New Task Assigned" notification or touch task_assignees/
--      tasks.assigned_to, were it to fire.
-- public.tasks also has no updated_at column at all (nothing to bump) and no audit/activity-log
-- trigger of any kind.
--
-- Postgres only fires an "UPDATE OF <cols>" trigger when the UPDATE statement's own SET list
-- includes one of those named columns — not when the row's other columns happen to change in the
-- same statement. The UPDATE below sets ONLY done_link, so its SET list is `{done_link}`, which
-- intersects with neither trigger's column list (`{parent_task_id}` / `{assigned_to,
-- assignee_viewed_at}`). CONCLUSION: neither trigger fires. No notification is sent, no
-- assignee/task_assignees row is touched, no nesting-depth re-check runs, and there is no
-- updated_at or audit row to bump — this UPDATE has zero side effects beyond the done_link column
-- itself, with NO additional trigger-suppression needed.
--
-- Because nothing needs suppressing, `session_replication_role = replica` was deliberately NOT
-- used (and would have been the wrong tool even if something did): it silently disables EVERY
-- trigger on the session, including FK-enforcement triggers and the OTHER tasks trigger that has
-- nothing to do with this change (tasks_enforce_nesting_depth) — a much larger blast radius than
-- "don't fire these specific side effects," with no way to scope it to just the two triggers
-- above. Had a real side effect existed, the correct, targeted tool would have been `alter table
-- public.tasks disable trigger <name>` / `enable trigger <name>` for that ONE trigger, inside
-- this same transaction (so a failure or early exit can never leave it disabled) — not a
-- session-wide switch that also suspends referential-integrity checks.
begin;

update public.tasks
set done_link = drive_link
where (done_link is null or btrim(done_link) = '')
  and drive_link is not null
  and btrim(drive_link) <> '';

commit;
