-- ============================================================================
-- FUNCTION TESTS for 20261213000000_mentorship_growth_status_ad_platforms.sql. NOT a migration —
-- lives outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. PERSONAS are REAL existing active
-- employees (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing). Every
-- client/assignment/insights row is throwaway (zz_test_ prefixed). The final
-- `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit transaction wrapping this whole
-- DO block, rolling back every single write above it — nothing persists either way.
--
-- Coverage:
--   1. A client WITH a valid Avg 3M baseline must now clear Avg3M Profit * (1 + Required Growth)
--      to be Successful, not just >= 0 (the owner's exact numeric example: Avg 3M Profit 12,000,
--      Required Growth 30% => bar is 15,600; a client profiting only 998 is Below Target).
--   2. The same client WOULD have been Below the bar but clears it exactly (bar hit precisely) ->
--      Successful (boundary case, >= not >).
--   3. A client with NO baseline (nothing in the 3 prior months) still falls back to the plain
--      current-month-profit->=0 rule (unchanged from 20261212000000).
--   4. Salla and Zid insights rows are excluded from Avg 3M / Current Sales, Spent, Profit — a
--      client logged only on salla+zid shows up as "No Data" for the selected month even though
--      media_buying_insights rows exist, and a client logged on tiktok+salla only sums the tiktok
--      half into Current Sales/Spent.
-- ============================================================================
do $$
declare
  v_buyer_id text; v_buyer_auth uuid;

  v_reporting_month date := date_trunc('month', now())::date;
  v_m1 date; v_m2 date; v_m3 date;

  v_client_belowbar text := 'zz_test_client_growthfix_belowbar';
  v_client_hitsbar text := 'zz_test_client_growthfix_hitsbar';
  v_client_nobaseline text := 'zz_test_client_growthfix_nobaseline';
  v_client_storeonly text := 'zz_test_client_growthfix_storeonly';
  v_client_mixedplatform text := 'zz_test_client_growthfix_mixedplatform';

  v_status text; v_sales numeric; v_spend numeric;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  select id, auth_id into v_buyer_id, v_buyer_auth
    from public.users where role = 'media_buying_agent' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_buyer_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active media_buying_agent with a linked auth account.';
  end if;

  v_m1 := (v_reporting_month - interval '1 month')::date;
  v_m2 := (v_reporting_month - interval '2 months')::date;
  v_m3 := (v_reporting_month - interval '3 months')::date;

  insert into public.clients (id, name, services, status, profit_margin_pct, start_date) values
    (v_client_belowbar, 'ZZ Test GrowthFix BelowBar', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_hitsbar, 'ZZ Test GrowthFix HitsBar', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_nobaseline, 'ZZ Test GrowthFix NoBaseline', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_storeonly, 'ZZ Test GrowthFix StoreOnly', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_mixedplatform, 'ZZ Test GrowthFix MixedPlatform', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date);

  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id) values
    ('zz_test_assign_growthfix_belowbar', v_client_belowbar, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_growthfix_hitsbar', v_client_hitsbar, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_growthfix_nobaseline', v_client_nobaseline, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_growthfix_storeonly', v_client_storeonly, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_growthfix_mixedplatform', v_client_mixedplatform, 'media_buying', v_buyer_id, v_buyer_id);

  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, sales_value) values
    -- belowbar: baseline sales 20000/month, spend 5000/month -> avg_profit = 20000*.5-5000 = 5000,
    -- spend 5000 < 10000 -> required_growth 30% -> bar = 5000*1.30 = 6500.
    -- current: sales 3996, spend 1000 -> profit = 3996*.5-1000 = 998 < 6500 -> Below Target.
    ('zz_test_insight_growthfix_belowbar_m3', v_client_belowbar, 'tiktok', v_m3, 5000, 20000),
    ('zz_test_insight_growthfix_belowbar_m2', v_client_belowbar, 'tiktok', v_m2, 5000, 20000),
    ('zz_test_insight_growthfix_belowbar_m1', v_client_belowbar, 'tiktok', v_m1, 5000, 20000),
    ('zz_test_insight_growthfix_belowbar_cur', v_client_belowbar, 'tiktok', v_reporting_month, 1000, 3996),
    -- hitsbar: same baseline (avg_profit 5000, bar 6500); current profit exactly 6500
    -- (sales 15000, spend 1000 -> 15000*.5-1000 = 6500) -> Successful (boundary, >= not >).
    ('zz_test_insight_growthfix_hitsbar_m3', v_client_hitsbar, 'tiktok', v_m3, 5000, 20000),
    ('zz_test_insight_growthfix_hitsbar_m2', v_client_hitsbar, 'tiktok', v_m2, 5000, 20000),
    ('zz_test_insight_growthfix_hitsbar_m1', v_client_hitsbar, 'tiktok', v_m1, 5000, 20000),
    ('zz_test_insight_growthfix_hitsbar_cur', v_client_hitsbar, 'tiktok', v_reporting_month, 1000, 15000),
    -- nobaseline: no rows at all in the 3 prior months; current profit 600 >= 0 -> Successful
    -- (plain fallback rule, unaffected by this migration).
    ('zz_test_insight_growthfix_nobaseline_cur', v_client_nobaseline, 'meta', v_reporting_month, 1000, 4000),
    -- storeonly: ONLY salla/zid rows for the current month -> must be excluded entirely ->
    -- Current Sales null -> status No Data.
    ('zz_test_insight_growthfix_storeonly_cur_salla', v_client_storeonly, 'salla', v_reporting_month, 500, 2000),
    ('zz_test_insight_growthfix_storeonly_cur_zid', v_client_storeonly, 'zid', v_reporting_month, 500, 2000),
    -- mixedplatform: tiktok (ad platform, counts) + salla (store, excluded) in the same month ->
    -- Current Sales/Spent must reflect ONLY the tiktok row.
    ('zz_test_insight_growthfix_mixed_cur_tiktok', v_client_mixedplatform, 'tiktok', v_reporting_month, 1000, 5000),
    ('zz_test_insight_growthfix_mixed_cur_salla', v_client_mixedplatform, 'salla', v_reporting_month, 9000, 90000);

  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer_auth)::text, true);
  set local role authenticated;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_belowbar;
  if v_status is distinct from 'Below Target' then
    raise exception 'TEST_FAILED: profit 998 under a 6500 growth bar — expected Below Target, got %', v_status;
  end if;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_hitsbar;
  if v_status is distinct from 'Successful' then
    raise exception 'TEST_FAILED: profit exactly meeting the 6500 growth bar — expected Successful (boundary), got %', v_status;
  end if;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_nobaseline;
  if v_status is distinct from 'Successful' then
    raise exception 'TEST_FAILED: no baseline, current profit 600 >= 0 — expected Successful (plain fallback), got %', v_status;
  end if;

  select status, current_sales into v_status, v_sales from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_storeonly;
  if v_status is distinct from 'No Data' or v_sales is not null then
    raise exception 'TEST_FAILED: client logged only on salla+zid — expected status=No Data current_sales=null, got status=% current_sales=%', v_status, v_sales;
  end if;

  select current_sales, current_spent into v_sales, v_spend from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_mixedplatform;
  if v_sales is distinct from 5000 or v_spend is distinct from 1000 then
    raise exception 'TEST_FAILED: tiktok+salla logged together — expected current_sales=5000 current_spent=1000 (salla excluded), got sales=% spent=%', v_sales, v_spend;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all growth-bar-status and ad-platform-only scenarios passed; rolling back every fabricated row.';
end $$;
