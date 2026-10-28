begin;

alter table public.tasks drop constraint if exists tasks_task_number_unique;
alter table public.tasks drop column if exists task_number;
drop sequence if exists public.tasks_task_number_seq;

commit;
