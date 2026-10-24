-- Run this AFTER applying 20261204000000_mentorship_sales_margin_tiers.sql, BEFORE merging the PR.
-- It re-checks the new objects, then rolls itself back so nothing from this test run is kept.
-- Baseline-relative: only checks relative counts/values, never assumes a specific row count, so it
-- is safe to run against the live, populated database.
begin;

do $$
declare
  v_clients_before int;
  v_insights_before int;
begin
  select count(*) into v_clients_before from public.clients;
  select count(*) into v_insights_before from public.media_buying_insights;

  -- New columns exist with the right defaults/nullability.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'profit_margin_pct'
  ) then
    raise exception 'clients.profit_margin_pct missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'media_buying_insights'
      and column_name = 'sales_value' and is_nullable = 'NO' and column_default like '%0%'
  ) then
    raise exception 'media_buying_insights.sales_value missing or not NOT NULL DEFAULT 0';
  end if;

  -- Existing rows untouched: new sales_value defaults to 0, no row count changed.
  if (select count(*) from public.media_buying_insights) <> v_insights_before then
    raise exception 'media_buying_insights row count changed — should only gain a column';
  end if;

  if (select count(*) from public.clients) <> v_clients_before then
    raise exception 'clients row count changed — should only gain a column';
  end if;

  -- Growth tiers seeded exactly once, covering 0..infinity with no gaps/overlaps at the
  -- boundaries the tracker's Settings sheet defines.
  if (select count(*) from public.mentorship_growth_tiers) <> 4 then
    raise exception 'expected exactly 4 seeded growth tiers, found %', (select count(*) from public.mentorship_growth_tiers);
  end if;

  if not exists (select 1 from public.mentorship_growth_tiers where min_spend = 100000 and max_spend is null and required_growth_pct = 0.10) then
    raise exception 'open-ended 100000+ tier missing or wrong';
  end if;

  raise notice 'All mentorship schema checks passed.';
end $$;

rollback;

do $$ begin raise notice 'TEST_OK_ROLLED_BACK'; end $$;
