-- ============================================================================
-- Emergency rollback for 20261103000000_task_assignees_foundation.sql.
-- NOT a migration — lives outside supabase/migrations/ on purpose so no tool ever applies it
-- automatically. Run manually, statement by statement if you want to stop partway, only if the
-- foundation migration needs to be undone. Reverses section-by-section, in the opposite order
-- from the migration (triggers/functions first, since they write to the tables dropped last).
--
-- This does NOT touch tasks.assigned_to, tasks.assignee_viewed_at, or any pre-existing table,
-- function, or policy — none of those were changed by the migration, so there's nothing to
-- restore on them.
-- ============================================================================

begin;

-- 5. Trigger + function
drop trigger if exists sync_legacy_assigned_to_to_task_assignees_trigger on public.tasks;
drop function if exists public.sync_legacy_assigned_to_to_task_assignees();

-- 3. batch_id column (drops its index automatically)
alter table public.tasks drop column if exists batch_id;

-- 2. task_assignee_log (policy + table; grants drop automatically with the table)
drop policy if exists "task_assignee_log_select_rls" on public.task_assignee_log;
drop table if exists public.task_assignee_log;

-- 1. task_assignees (policy + table; grants drop automatically with the table)
drop policy if exists "task_assignees_select_rls" on public.task_assignees;
drop table if exists public.task_assignees;

commit;
