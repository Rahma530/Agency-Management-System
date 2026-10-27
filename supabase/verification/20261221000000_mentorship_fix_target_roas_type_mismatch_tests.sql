-- ============================================================================
-- FUNCTION TESTS for 20261221000000_mentorship_fix_target_roas_type_mismatch.sql. NOT a
-- migration — lives outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. PERSONAS are REAL existing active
-- employees (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing). Every
-- client/assignment/insights row is throwaway (zz_test_ prefixed). The final
-- `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit transaction wrapping this whole
-- DO block, rolling back every single write above it — nothing persists either way.
--
-- Coverage: the bug this fixes ("structure of query does not match function result type") only
-- surfaces when the function is actually INVOKED, not at CREATE time — so simply calling
-- get_mentorship_snapshot() for a client that hits the target_roas=0 branch, without it raising,
-- IS the test. No separate CREATE-succeeds check needed; if the type mismatch were still present,
-- this whole script would fail on the very first select from get_mentorship_snapshot() below.
-- ============================================================================
do $$
declare
  v_buyer_id text; v_buyer_auth uuid;

  v_reporting_month date := date_trunc('month', now())::date;

  v_client_brandnew text := 'zz_test_client_roastypefix_brandnew';

  v_target numeric;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  select id, auth_id into v_buyer_id, v_buyer_auth
    from public.users where role = 'media_buying_agent' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_buyer_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active media_buying_agent with a linked auth account.';
  end if;

  insert into public.clients (id, name, services, status, profit_margin_pct, start_date) values
    (v_client_brandnew, 'ZZ Test ROASTypeFix BrandNew', array['media_buying'], 'active', 0.3, (v_reporting_month - interval '6 months')::date);

  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id) values
    ('zz_test_assign_roastypefix_brandnew', v_client_brandnew, 'media_buying', v_buyer_id, v_buyer_id);

  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, sales_value) values
    ('zz_test_insight_roastypefix_brandnew_cur', v_client_brandnew, 'salla', v_reporting_month, 6000, 3000);

  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer_auth)::text, true);
  set local role authenticated;

  -- If the int4-vs-numeric mismatch were still present, this select itself would raise
  -- "structure of query does not match function result type" right here.
  select target_roas into v_target
    from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_brandnew;

  if v_target is distinct from 0 then
    raise exception 'TEST_FAILED: expected target_roas=0 for a no-history client, got %', v_target;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: get_mentorship_snapshot() called without a type-mismatch error; rolling back every fabricated row.';
end $$;
