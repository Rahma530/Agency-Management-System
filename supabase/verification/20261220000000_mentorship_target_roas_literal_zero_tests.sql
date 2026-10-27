-- ============================================================================
-- FUNCTION TESTS for 20261220000000_mentorship_target_roas_literal_zero.sql. NOT a migration —
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
--   1. A client with NO spend history (brand-new, Margin set) gets target_roas = 0 (a literal
--      number, not the old breakeven 1/Margin value), and required_growth_pct stays null.
--   2. A client WITH spend history still gets target_roas = null and required_growth_pct set,
--      unaffected (exactly one of the two columns populated, same as before).
--   3. A client with no Margin set gets target_roas = null too (Setup Needed takes priority).
-- ============================================================================
do $$
declare
  v_buyer_id text; v_buyer_auth uuid;

  v_reporting_month date := date_trunc('month', now())::date;
  v_m1 date; v_m2 date; v_m3 date;

  v_client_brandnew text := 'zz_test_client_roaszero_brandnew';
  v_client_hashistory text := 'zz_test_client_roaszero_hashistory';
  v_client_nomargin text := 'zz_test_client_roaszero_nomargin';

  v_required_growth numeric; v_target numeric;
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
    (v_client_brandnew, 'ZZ Test ROASZero BrandNew', array['media_buying'], 'active', 0.3, (v_reporting_month - interval '6 months')::date),
    (v_client_hashistory, 'ZZ Test ROASZero HasHistory', array['media_buying'], 'active', 0.3, (v_reporting_month - interval '6 months')::date),
    (v_client_nomargin, 'ZZ Test ROASZero NoMargin', array['media_buying'], 'active', null, (v_reporting_month - interval '6 months')::date);

  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id) values
    ('zz_test_assign_roaszero_brandnew', v_client_brandnew, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_roaszero_hashistory', v_client_hashistory, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_roaszero_nomargin', v_client_nomargin, 'media_buying', v_buyer_id, v_buyer_id);

  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, sales_value) values
    -- brandnew: no rows before this month; has activity this month, still no baseline.
    ('zz_test_insight_roaszero_brandnew_cur', v_client_brandnew, 'salla', v_reporting_month, 6000, 3000),
    -- hashistory: real spend history.
    ('zz_test_insight_roaszero_hashistory_m3', v_client_hashistory, 'salla', v_m3, 5000, 20000),
    ('zz_test_insight_roaszero_hashistory_m2', v_client_hashistory, 'salla', v_m2, 5000, 20000),
    ('zz_test_insight_roaszero_hashistory_m1', v_client_hashistory, 'salla', v_m1, 5000, 20000),
    ('zz_test_insight_roaszero_hashistory_cur', v_client_hashistory, 'salla', v_reporting_month, 3000, 10000);
    -- nomargin: no rows at all (Setup Needed regardless).

  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer_auth)::text, true);
  set local role authenticated;

  select required_growth_pct, target_roas into v_required_growth, v_target
    from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_brandnew;
  if v_required_growth is not null or v_target is distinct from 0 then
    raise exception 'TEST_FAILED: brand-new client — expected required_growth_pct=null target_roas=0 (literal, not breakeven), got required_growth_pct=% target_roas=%', v_required_growth, v_target;
  end if;

  select required_growth_pct, target_roas into v_required_growth, v_target
    from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_hashistory;
  if v_required_growth is null or v_target is not null then
    raise exception 'TEST_FAILED: client with real spend history — expected required_growth_pct set target_roas=null, got required_growth_pct=% target_roas=%', v_required_growth, v_target;
  end if;

  select target_roas into v_target
    from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_nomargin;
  if v_target is not null then
    raise exception 'TEST_FAILED: client with no Margin set — expected target_roas=null, got target_roas=%', v_target;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all target_roas=0 scenarios passed; rolling back every fabricated row.';
end $$;
