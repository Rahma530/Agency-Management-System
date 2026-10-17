-- ROLLBACK for 20261116000000_task_events.sql.
--
-- Order: triggers first, then their functions, then the table — a function can't be dropped while
-- a trigger still references it, and nothing else in the schema depends on task_events (no FK
-- points at it, by this migration's own design).
begin;

drop trigger if exists task_assignees_log_events_trigger on public.task_assignees;
drop trigger if exists tasks_log_events_trigger on public.tasks;

drop function if exists public.task_assignees_log_events();
drop function if exists public.tasks_log_events();

drop table if exists public.task_events;

commit;
