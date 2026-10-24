-- ============================================================================
-- FUNCTION TESTS for 20261206000000_get_mentorship_snapshot.sql. NOT a migration — lives outside
-- supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. PERSONAS are REAL existing active
-- employees (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing). Every
-- client/assignment/insights/oversight row is throwaway (zz_test_ prefixed). The final
-- `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit transaction wrapping this whole
-- DO block, rolling back every single write above it — nothing persists either way.
--
-- Coverage: the 6 status branches (Successful / Below Target / No Data / Onboarding / Setup
-- Needed / No Baseline) against hand-computed expected numbers, and the visibility gate
-- (self-view, an unrelated employee sees nothing, an overseer sees nothing until added via
-- add_mentorship_oversight, sees it after, loses it again after remove_mentorship_oversight).
-- ============================================================================
do $$
declare
  v_buyer_id text; v_buyer_auth uuid;
  v_overseer_id text; v_overseer_auth uuid;
  v_outsider_id text; v_outsider_auth uuid;

  v_reporting_month date := date_trunc('month', now())::date;
  v_m1 date; v_m2 date; v_m3 date;

  v_client_success text := 'zz_test_client_mentorship_success';
  v_client_below text := 'zz_test_client_mentorship_below';
  v_client_nodata text := 'zz_test_client_mentorship_nodata';
  v_client_onboarding text := 'zz_test_client_mentorship_onboarding';
  v_client_setup text := 'zz_test_client_mentorship_setup';
  v_client_nobaseline text := 'zz_test_client_mentorship_nobaseline';

  v_status text; v_cur_profit numeric; v_avg_profit numeric; v_growth numeric;
  v_count integer;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: real personas.
  -- ======================================================================
  select id, auth_id into v_buyer_id, v_buyer_auth
    from public.users where role = 'media_buying_agent' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_buyer_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active media_buying_agent with a linked auth account.';
  end if;

  select id, auth_id into v_overseer_id, v_overseer_auth
    from public.users
    where role in ('executive', 'head_of_technical', 'media_buying_team_lead')
      and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_overseer_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active executive/head_of_technical/media_buying_team_lead with a linked auth account.';
  end if;

  select id, auth_id into v_outsider_id, v_outsider_auth
    from public.users
    where auth_id is not null and deactivated_at is null
      and id not in (v_buyer_id, v_overseer_id)
      and role <> 'media_buying_agent'
      and role not in ('executive', 'head_of_technical', 'media_buying_team_lead')
    order by id limit 1;
  if v_outsider_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active, unrelated employee (not the test buyer/overseer) with a linked auth account.';
  end if;

  v_m1 := (v_reporting_month - interval '1 month')::date;
  v_m2 := (v_reporting_month - interval '2 months')::date;
  v_m3 := (v_reporting_month - interval '3 months')::date;

  -- ======================================================================
  -- Fabricate clients — one per status branch.
  -- ======================================================================
  insert into public.clients (id, name, services, status, profit_margin_pct, start_date) values
    (v_client_success, 'ZZ Test Mentorship Success', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_below, 'ZZ Test Mentorship Below', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_nodata, 'ZZ Test Mentorship NoData', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_onboarding, 'ZZ Test Mentorship Onboarding', array['media_buying'], 'active', 0.5, (v_reporting_month + interval '10 days')::date),
    (v_client_setup, 'ZZ Test Mentorship Setup', array['media_buying'], 'active', null, null),
    (v_client_nobaseline, 'ZZ Test Mentorship NoBaseline', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date);

  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id) values
    ('zz_test_assign_success', v_client_success, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_below', v_client_below, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_nodata', v_client_nodata, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_onboarding', v_client_onboarding, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_setup', v_client_setup, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_nobaseline', v_client_nobaseline, 'media_buying', v_buyer_id, v_buyer_id);

  -- Baseline (3 prior months) + current month insights. margin 0.5 throughout.
  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, sales_value) values
    -- success: avg profit = 20000*.5-5000 = 5000 (tier <10000 spend -> 30% required);
    -- current profit = 25000*.5-6000 = 6500; growth = 6500/5000-1 = 0.30 (meets 0.30 exactly).
    ('zz_test_insight_success_m3', v_client_success, 'tiktok', v_m3, 5000, 20000),
    ('zz_test_insight_success_m2', v_client_success, 'tiktok', v_m2, 5000, 20000),
    ('zz_test_insight_success_m1', v_client_success, 'tiktok', v_m1, 5000, 20000),
    ('zz_test_insight_success_cur', v_client_success, 'tiktok', v_reporting_month, 6000, 25000),
    -- below: same baseline; current profit = 22000*.5-6000 = 5000; growth = 0 < 0.30.
    ('zz_test_insight_below_m3', v_client_below, 'tiktok', v_m3, 5000, 20000),
    ('zz_test_insight_below_m2', v_client_below, 'tiktok', v_m2, 5000, 20000),
    ('zz_test_insight_below_m1', v_client_below, 'tiktok', v_m1, 5000, 20000),
    ('zz_test_insight_below_cur', v_client_below, 'tiktok', v_reporting_month, 6000, 22000),
    -- nodata: baseline only, nothing for the current month.
    ('zz_test_insight_nodata_m3', v_client_nodata, 'tiktok', v_m3, 5000, 20000),
    ('zz_test_insight_nodata_m2', v_client_nodata, 'tiktok', v_m2, 5000, 20000),
    ('zz_test_insight_nodata_m1', v_client_nodata, 'tiktok', v_m1, 5000, 20000),
    -- nobaseline: current month only, nothing in the 3 prior months.
    ('zz_test_insight_nobaseline_cur', v_client_nobaseline, 'tiktok', v_reporting_month, 5000, 20000);

  -- ======================================================================
  -- Scenario set 1: self-view (the media buyer calling about their own clients).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer_auth)::text, true);
  set local role authenticated;

  select status, current_profit, avg_3m_profit, profit_growth_pct
    into v_status, v_cur_profit, v_avg_profit, v_growth
    from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_success;
  if v_status is distinct from 'Successful' or round(v_avg_profit, 2) <> 5000 or round(v_cur_profit, 2) <> 6500 or round(v_growth, 4) <> 0.3000 then
    raise exception 'TEST_FAILED: success-branch client — expected status=Successful avg_profit=5000 cur_profit=6500 growth=0.30, got status=% avg_profit=% cur_profit=% growth=%', v_status, v_avg_profit, v_cur_profit, v_growth;
  end if;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_below;
  if v_status is distinct from 'Below Target' then
    raise exception 'TEST_FAILED: below-target-branch client — expected status=Below Target, got %', v_status;
  end if;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_nodata;
  if v_status is distinct from 'No Data' then
    raise exception 'TEST_FAILED: no-data-branch client — expected status=No Data, got %', v_status;
  end if;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_onboarding;
  if v_status is distinct from 'Onboarding' then
    raise exception 'TEST_FAILED: onboarding-branch client — expected status=Onboarding, got %', v_status;
  end if;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_setup;
  if v_status is distinct from 'Setup Needed' then
    raise exception 'TEST_FAILED: setup-needed-branch client — expected status=Setup Needed, got %', v_status;
  end if;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_nobaseline;
  if v_status is distinct from 'No Baseline' then
    raise exception 'TEST_FAILED: no-baseline-branch client — expected status=No Baseline, got %', v_status;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario set 2: an unrelated employee (not the buyer, not an overseer) sees none of these.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider_auth)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.get_mentorship_snapshot(v_reporting_month)
    where client_id in (v_client_success, v_client_below, v_client_nodata, v_client_onboarding, v_client_setup, v_client_nobaseline);
  if v_count <> 0 then
    raise exception 'TEST_FAILED: unrelated employee should see 0 of the test clients, saw %', v_count;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario set 3: oversight gate — overseer sees nothing until added, sees it after, loses it
  -- again after removal.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_overseer_auth)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_success;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: overseer should see 0 test clients before being added to mentorship_oversight, saw %', v_count;
  end if;

  perform public.add_mentorship_oversight(v_overseer_id, v_buyer_id);

  select count(*) into v_count from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_success;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: overseer should see the test client after add_mentorship_oversight, saw %', v_count;
  end if;

  perform public.remove_mentorship_oversight(v_overseer_id, v_buyer_id);

  select count(*) into v_count from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_success;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: overseer should see 0 test clients again after remove_mentorship_oversight, saw %', v_count;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all get_mentorship_snapshot scenarios passed; rolling back every fabricated row.';
end $$;
