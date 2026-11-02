-- Rollback for 20261227000000_task_sort_order.sql

begin;

alter table public.tasks
  drop column if exists sort_order;

commit;
