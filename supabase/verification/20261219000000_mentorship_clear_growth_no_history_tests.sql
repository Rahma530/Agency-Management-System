-- ============================================================================
-- FUNCTION TESTS for 20261219000000_mentorship_clear_growth_no_history.sql. NOT a migration —
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
--   1. A client with NO spend history (brand-new) gets required_growth_pct = null (blank) —
--      their only applicable target is target_roas, not a 30%-tier growth figure.
--   2. A client WITH spend history still gets required_growth_pct from the matching tier,
--      unaffected (and target_roas stays null for them, unchanged from before).
-- ============================================================================
do $$
declare
  v_buyer_id text; v_buyer_auth uuid;

  v_reporting_month date := date_trunc('month', now())::date;
  v_m1 date; v_m2 date; v_m3 date;

  v_client_brandnew text := 'zz_test_client_clrgrowth_brandnew';
  v_client_hashistory text := 'zz_test_client_clrgrowth_hashistory';

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
    (v_client_brandnew, 'ZZ Test ClrGrowth BrandNew', array['media_buying'], 'active', 0.4, (v_reporting_month - interval '6 months')::date),
    (v_client_hashistory, 'ZZ Test ClrGrowth HasHistory', array['media_buying'], 'active', 0.4, (v_reporting_month - interval '6 months')::date);

  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id) values
    ('zz_test_assign_clrgrowth_brandnew', v_client_brandnew, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_clrgrowth_hashistory', v_client_hashistory, 'media_buying', v_buyer_id, v_buyer_id);

  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, sales_value) values
    -- brandnew: no rows before this month at all.
    ('zz_test_insight_clrgrowth_brandnew_cur', v_client_brandnew, 'salla', v_reporting_month, 1000, 5000),
    -- hashistory: real spend history (spend 5000/mo -> matches some active tier).
    ('zz_test_insight_clrgrowth_hashistory_m3', v_client_hashistory, 'salla', v_m3, 5000, 20000),
    ('zz_test_insight_clrgrowth_hashistory_m2', v_client_hashistory, 'salla', v_m2, 5000, 20000),
    ('zz_test_insight_clrgrowth_hashistory_m1', v_client_hashistory, 'salla', v_m1, 5000, 20000),
    ('zz_test_insight_clrgrowth_hashistory_cur', v_client_hashistory, 'salla', v_reporting_month, 3000, 10000);

  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer_auth)::text, true);
  set local role authenticated;

  select required_growth_pct, target_roas into v_required_growth, v_target
    from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_brandnew;
  if v_required_growth is not null or round(v_target, 4) is distinct from 2.5000 then
    raise exception 'TEST_FAILED: brand-new client — expected required_growth_pct=null target_roas=2.5, got required_growth_pct=% target_roas=%', v_required_growth, v_target;
  end if;

  select required_growth_pct, target_roas into v_required_growth, v_target
    from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_hashistory;
  if v_required_growth is null or v_target is not null then
    raise exception 'TEST_FAILED: client with real spend history — expected required_growth_pct set (not null) target_roas=null, got required_growth_pct=% target_roas=%', v_required_growth, v_target;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: both scenarios passed; rolling back every fabricated row.';
end $$;
