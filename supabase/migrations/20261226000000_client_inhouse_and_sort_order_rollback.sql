-- Rollback for 20261226000000_client_inhouse_and_sort_order.sql

begin;

revoke select (is_inhouse, sort_order) on public.clients from authenticated;

alter table public.clients
  drop column if exists sort_order;

alter table public.clients
  drop column if exists is_inhouse;

commit;
