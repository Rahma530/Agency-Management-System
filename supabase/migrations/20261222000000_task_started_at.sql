-- Adds tasks.started_at: set once, the first time a task's status becomes 'in_progress' —
-- same "first time only, never overwritten" bookkeeping already used for tasks.completed_at (see
-- handleUpdateTaskStatus/handleUpdateTask in src/App.tsx). Needed so actual_hours can be computed
-- automatically as the elapsed wall-clock time between started_at and completed_at, instead of
-- being hand-typed by the employee (the "Quick time logging" box this replaces).
--
-- No RLS/grant change needed: public.tasks already has a whole-table
-- `grant select, insert, update on public.tasks to authenticated` (20260907090000_table_grants.sql)
-- and no column-level grant restriction, same as completed_at before it.
begin;

alter table public.tasks add column if not exists started_at timestamptz;

commit;
