-- Adds tasks.task_number: a global, sequential, human-facing task number ("#42"), shown next to
-- the title everywhere a task appears across the system (Kanban cards, tables, Task Details).
-- Deliberately global (one counter for the whole system, not per-client) and a plain integer
-- rather than a formatted code like "TSK-0042" — simple "#N" is all the UI needs to render.
--
-- Implementation: public.tasks.id is `text`, not a serial/identity-compatible type, so this is a
-- separate integer column backed by its own sequence (rather than `generated always as
-- identity`, which can't be backfilled with explicit values without `overriding system value`
-- on every statement). New tasks get their number automatically from the column default; no
-- app-code change is needed for insert.
--
-- No RLS/grant change needed: public.tasks already has a whole-table
-- `grant select, insert, update on public.tasks to authenticated` (20260907090000_table_grants.sql)
-- and no column-level grant restriction, same as every other column added here before it.
begin;

create sequence if not exists public.tasks_task_number_seq;

alter table public.tasks
  add column if not exists task_number integer;

alter table public.tasks
  alter column task_number set default nextval('public.tasks_task_number_seq');

alter sequence public.tasks_task_number_seq owned by public.tasks.task_number;

-- Backfill existing tasks in a stable order — oldest first, so older tasks keep the lower,
-- more "senior" numbers rather than getting numbered arbitrarily.
with ordered as (
  select id, row_number() over (order by created_at asc, id asc) as rn
  from public.tasks
  where task_number is null
)
update public.tasks t
set task_number = o.rn
from ordered o
where t.id = o.id;

-- Move the sequence past every backfilled number so the next real insert doesn't collide.
select setval('public.tasks_task_number_seq', coalesce((select max(task_number) from public.tasks), 0));

-- Now that every row has a value, lock it in: never null, never duplicated.
alter table public.tasks
  alter column task_number set not null;

alter table public.tasks
  add constraint tasks_task_number_unique unique (task_number);

commit;
