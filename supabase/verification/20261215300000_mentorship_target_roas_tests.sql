-- ============================================================================
-- FUNCTION TESTS for 20261215300000_mentorship_target_roas.sql. NOT a migration — lives outside
-- supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. PERSONAS are REAL existing active
-- employees (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing). Every
-- client/assignment/insights row is throwaway (zz_test_ prefixed). The final
-- `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit transaction wrapping this whole
-- DO block, rolling back every single write above it — nothing persists either way.
--
-- Coverage:
--   1. A client with NO spend history at all (nothing in the 3 months strictly before the
--      selected month) gets target_roas = 1/Margin (breakeven ROAS), and status is the ORDINARY
--      Successful/Below Target fallback — NOT a 'Breakeven' status value (this migration
--      deliberately does not introduce one, correcting the never-merged PR #223 attempt).
--   2. A client WITH spend history gets target_roas = null, status/current_roas unaffected.
--   3. A client with no Margin set gets target_roas = null too (Setup Needed takes priority, and
--      1/margin would be meaningless with margin null).
-- ============================================================================
do $$
declare
  v_buyer_id text; v_buyer_auth uuid;

  v_reporting_month date := date_trunc('month', now())::date;
  v_m1 date; v_m2 date; v_m3 date;

  v_client_brandnew text := 'zz_test_client_targetroas_brandnew';
  v_client_hashistory text := 'zz_test_client_targetroas_hashistory';
  v_client_nomargin text := 'zz_test_client_targetroas_nomargin';

  v_status text; v_target numeric;
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
    -- margin 0.4 -> breakeven ROAS = 1/0.4 = 2.5
    (v_client_brandnew, 'ZZ Test TargetROAS BrandNew', array['media_buying'], 'active', 0.4, (v_reporting_month - interval '6 months')::date),
    (v_client_hashistory, 'ZZ Test TargetROAS HasHistory', array['media_buying'], 'active', 0.4, (v_reporting_month - interval '6 months')::date),
    (v_client_nomargin, 'ZZ Test TargetROAS NoMargin', array['media_buying'], 'active', null, (v_reporting_month - interval '6 months')::date);

  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id) values
    ('zz_test_assign_targetroas_brandnew', v_client_brandnew, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_targetroas_hashistory', v_client_hashistory, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_targetroas_nomargin', v_client_nomargin, 'media_buying', v_buyer_id, v_buyer_id);

  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, sales_value) values
    -- brandnew: no rows before this month; current month profit = 5000*.4-1000 = 1000 >= 0.
    ('zz_test_insight_targetroas_brandnew_cur', v_client_brandnew, 'salla', v_reporting_month, 1000, 5000),
    -- hashistory: real spend history (profitable: avg profit = 20000*.4-5000 = 3000, spend 5000 ->
    -- 30% tier -> bar = 3900). Current profit = 10000*.4-3000 = 1000 < 3900 -> Below Target.
    ('zz_test_insight_targetroas_hashistory_m3', v_client_hashistory, 'salla', v_m3, 5000, 20000),
    ('zz_test_insight_targetroas_hashistory_m2', v_client_hashistory, 'salla', v_m2, 5000, 20000),
    ('zz_test_insight_targetroas_hashistory_m1', v_client_hashistory, 'salla', v_m1, 5000, 20000),
    ('zz_test_insight_targetroas_hashistory_cur', v_client_hashistory, 'salla', v_reporting_month, 3000, 10000);
    -- nomargin: no rows at all (Setup Needed regardless).

  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer_auth)::text, true);
  set local role authenticated;

  select status, target_roas into v_status, v_target from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_brandnew;
  if v_status is distinct from 'Successful' or round(v_target, 4) is distinct from 2.5000 then
    raise exception 'TEST_FAILED: brand-new client — expected status=Successful (ordinary fallback, NOT Breakeven) target_roas=2.5, got status=% target_roas=%', v_status, v_target;
  end if;

  select status, target_roas into v_status, v_target from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_hashistory;
  if v_status is distinct from 'Below Target' or v_target is not null then
    raise exception 'TEST_FAILED: client with real spend history — expected status=Below Target (growth-vs-tier, unchanged) target_roas=null, got status=% target_roas=%', v_status, v_target;
  end if;

  select status, target_roas into v_status, v_target from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_nomargin;
  if v_status is distinct from 'Setup Needed' or v_target is not null then
    raise exception 'TEST_FAILED: client with no Margin set — expected status=Setup Needed target_roas=null, got status=% target_roas=%', v_status, v_target;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all Target ROAS scenarios passed; rolling back every fabricated row.';
end $$;
