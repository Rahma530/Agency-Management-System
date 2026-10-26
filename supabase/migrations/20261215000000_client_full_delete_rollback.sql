-- Rollback for 20261215000000_client_full_delete.sql — drops delete_clients() only.
-- deletion_log already existed before this migration (created in 20261113000000 for tasks, with
-- entity_type deliberately allowing 'client' from the start) and is left untouched; any 'client'
-- rows already written to it by delete_clients() are an audit trail of real deletions and are not
-- removed by this rollback either.
begin;

drop function if exists public.delete_clients(text[]);

commit;
