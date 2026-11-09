-- Rollback for 20270105000000_head_of_sales_client_registration.sql — simply drops the one policy
-- it added. No other object touched, so nothing else to restore.

begin;

drop policy if exists "clients_insert_head_of_sales_rls" on public.clients;

commit;
