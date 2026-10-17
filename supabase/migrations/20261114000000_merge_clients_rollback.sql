-- ROLLBACK for 20261114000000_merge_clients.sql.
--
-- Purely additive (two new functions; deletion_log is reused from 20261113000000_task_hard_delete.sql
-- and is NOT touched here — that table's own rollback owns it). Just drop both functions.
begin;

drop function if exists public.merge_clients_preview(text, text);
drop function if exists public.merge_clients(text, text);

commit;
