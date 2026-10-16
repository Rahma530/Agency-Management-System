-- ============================================================================
-- ROLLBACK for 20261109000000_task_done_link_backfill.sql.
--
-- This migration is a plain data UPDATE with no snapshot of the prior values (it didn't need
-- one: every row it touched had done_link null/blank by definition of its own WHERE clause, so
-- "the prior value" is simply null). Rollback is therefore: set done_link back to null on every
-- row that currently looks like this migration touched it.
--
-- CAVEAT — read before running: a row is identified as "touched by the migration" if
-- done_link = drive_link (non-blank) right now. This is exactly reversible UNLESS someone
-- manually set a task's done_link to the SAME value as its drive_link after the migration ran —
-- an extremely unlikely coincidence, and even then the only effect is that row's done_link goes
-- back to blank (drive_link itself is never touched by the migration or this rollback, so no
-- data is lost; the value is still sitting in drive_link and could be re-entered into done_link
-- by hand). Use only to intentionally revert; not needed for normal operation, and the frontend
-- change in this same PR (removing Drive Link from the UI) is NOT reverted by running this —
-- that is a separate, ordinary code revert if you need one.
-- ============================================================================
begin;

update public.tasks
set done_link = null
where drive_link is not null
  and btrim(drive_link) <> ''
  and done_link = drive_link;

commit;
