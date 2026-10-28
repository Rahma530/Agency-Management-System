begin;

alter table public.tasks drop column if exists started_at;

commit;
