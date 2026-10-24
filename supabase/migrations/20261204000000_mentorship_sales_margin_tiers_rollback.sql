-- Rollback for 20261204000000_mentorship_sales_margin_tiers.sql
begin;

drop table if exists public.mentorship_growth_tiers;

alter table public.media_buying_insights
  drop column if exists sales_value;

alter table public.clients
  drop column if exists profit_margin_pct;

commit;
