-- ROLLBACK for 20261117000000_activities_task_participants_select.sql.
--
-- Drops only the one new policy this migration added. activities_select_rls, activities_insert_rls,
-- and every grant on public.activities are untouched by either file, so there is nothing else to
-- restore here.
begin;

drop policy if exists "activities_select_task_participants" on public.activities;

commit;
