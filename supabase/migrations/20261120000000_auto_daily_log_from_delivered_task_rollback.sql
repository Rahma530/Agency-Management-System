-- Rollback for 20261120000000_auto_daily_log_from_delivered_task.sql.
-- Drops the trigger/function/index/constraint/columns added by that migration, in reverse order.
-- No data cleanup: any auto_task rows already inserted by the trigger are left in place (same
-- "no backfill, no destructive cleanup" posture as the forward migration — this only removes the
-- mechanism, never rows it already created).
begin;

drop trigger if exists tasks_auto_daily_log_from_delivered_trigger on public.tasks;
drop function if exists public.auto_daily_log_from_delivered_task();

drop index if exists idx_daily_logs_task_user_date;

alter table public.daily_logs
  drop constraint if exists daily_logs_source_check;

alter table public.daily_logs
  drop column if exists source,
  drop column if exists task_id;

commit;
