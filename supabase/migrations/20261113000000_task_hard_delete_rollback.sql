-- ROLLBACK for 20261113000000_task_hard_delete.sql.
--
-- Purely additive forward migration (new table, new function, nothing existing touched) — the
-- rollback is just dropping both. No column/trigger/policy on any pre-existing table to restore.
begin;

drop function if exists public.delete_tasks(text[]);
drop table if exists public.deletion_log;

commit;
