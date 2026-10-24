-- Rollback for 20261209000000_grant_profit_margin_pct_select.sql
-- Do NOT run this as part of normal testing — this would re-break every client fetch in the app
-- (see the forward migration's comment). Only here for consistency with this project's
-- migration/rollback convention.
begin;

revoke select (profit_margin_pct) on public.clients from authenticated;

commit;
