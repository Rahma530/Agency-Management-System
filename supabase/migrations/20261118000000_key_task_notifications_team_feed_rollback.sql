-- ROLLBACK for 20261118000000_key_task_notifications_team_feed.sql.
--
-- Order: trigger first (it references the function), then the functions, then the index. The
-- index is harmless to leave, but dropped anyway since nothing else in this migration depends on
-- it either. No table, column, or existing grant/policy was ever touched by the forward
-- migration, so there is nothing else to restore here.
begin;

drop trigger if exists task_events_notify_key_status_changes_trigger on public.task_events;

drop function if exists public.team_task_activity_feed(int, timestamptz);
drop function if exists public.notify_key_task_status_changes();
drop function if exists public.task_supervisor_role(text);

drop index if exists public.idx_task_events_created_at;

commit;
