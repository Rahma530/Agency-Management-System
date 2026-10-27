-- ============================================================================
-- FUNCTION TESTS for 20261215000000_mentorship_required_roas_breakeven.sql. NOT a migration —
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
--   1. A client with genuinely NO spend history (nothing in the 3 months strictly before the
--      selected month) -> required_roas = 0, status = 'Breakeven', REGARDLESS of whether this
--      month's own profit is positive or negative (two clients, one each way).
--   2. A client WITH spend history (even if last month was a loss) keeps the existing fallback
--      logic (Successful if this month's profit >= 0, else Below Target) and required_roas = null
--      — proving the Breakeven branch is scoped to avg3.avg_sales is null specifically, not the
--      broader "no valid baseline" condition.
--   3. A client with a valid positive Avg 3M baseline keeps the existing growth-vs-tier logic and
--      required_roas = null, current_roas computed as always.
-- ============================================================================
do $$
declare
  v_buyer_id text; v_buyer_auth uuid;

  v_reporting_month date := date_trunc('month', now())::date;
  v_m1 date; v_m2 date; v_m3 date;

  v_client_brandnew_profit text := 'zz_test_client_reqroas_brandnew_profit';
  v_client_brandnew_loss text := 'zz_test_client_reqroas_brandnew_loss';
  v_client_pastloss text := 'zz_test_client_reqroas_pastloss';
  v_client_growthbar text := 'zz_test_client_reqroas_growthbar';

  v_status text; v_reqroas numeric; v_curroas numeric;
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
    (v_client_brandnew_profit, 'ZZ Test ReqROAS BrandNewProfit', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_brandnew_loss, 'ZZ Test ReqROAS BrandNewLoss', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_pastloss, 'ZZ Test ReqROAS PastLoss', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_growthbar, 'ZZ Test ReqROAS GrowthBar', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date);

  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id) values
    ('zz_test_assign_reqroas_brandnew_profit', v_client_brandnew_profit, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_reqroas_brandnew_loss', v_client_brandnew_loss, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_reqroas_pastloss', v_client_pastloss, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_reqroas_growthbar', v_client_growthbar, 'media_buying', v_buyer_id, v_buyer_id);

  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, sales_value) values
    -- brandnew_profit: NO rows before this month at all; current month profitable (5000*.5-1000=1500).
    ('zz_test_insight_reqroas_brandnew_profit_cur', v_client_brandnew_profit, 'salla', v_reporting_month, 1000, 5000),
    -- brandnew_loss: NO rows before this month at all; current month a loss (2000*.5-2000=-1000).
    ('zz_test_insight_reqroas_brandnew_loss_cur', v_client_brandnew_loss, 'salla', v_reporting_month, 2000, 2000),
    -- pastloss: HAS spend history (3 prior months), but it was a loss (avg profit = 5000*.5-4000 = -1500).
    -- Current month profit = 3000*.5-1000 = 500 >= 0 -> fallback rule -> Successful (unchanged behavior).
    ('zz_test_insight_reqroas_pastloss_m3', v_client_pastloss, 'salla', v_m3, 4000, 5000),
    ('zz_test_insight_reqroas_pastloss_m2', v_client_pastloss, 'salla', v_m2, 4000, 5000),
    ('zz_test_insight_reqroas_pastloss_m1', v_client_pastloss, 'salla', v_m1, 4000, 5000),
    ('zz_test_insight_reqroas_pastloss_cur', v_client_pastloss, 'salla', v_reporting_month, 1000, 3000),
    -- growthbar: valid positive baseline (avg profit = 20000*.5-5000 = 5000, spend 5000 -> 30% tier
    -- -> bar = 6500). Current profit = 25000*.5-6000 = 6500 -> meets bar exactly -> Successful.
    ('zz_test_insight_reqroas_growthbar_m3', v_client_growthbar, 'salla', v_m3, 5000, 20000),
    ('zz_test_insight_reqroas_growthbar_m2', v_client_growthbar, 'salla', v_m2, 5000, 20000),
    ('zz_test_insight_reqroas_growthbar_m1', v_client_growthbar, 'salla', v_m1, 5000, 20000),
    ('zz_test_insight_reqroas_growthbar_cur', v_client_growthbar, 'salla', v_reporting_month, 6000, 25000);

  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer_auth)::text, true);
  set local role authenticated;

  select status, required_roas into v_status, v_reqroas from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_brandnew_profit;
  if v_status is distinct from 'Breakeven' or v_reqroas is distinct from 0 then
    raise exception 'TEST_FAILED: brand-new client (profitable this month) — expected status=Breakeven required_roas=0, got status=% required_roas=%', v_status, v_reqroas;
  end if;

  select status, required_roas into v_status, v_reqroas from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_brandnew_loss;
  if v_status is distinct from 'Breakeven' or v_reqroas is distinct from 0 then
    raise exception 'TEST_FAILED: brand-new client (loss this month) — expected status=Breakeven required_roas=0 regardless of profit sign, got status=% required_roas=%', v_status, v_reqroas;
  end if;

  select status, required_roas into v_status, v_reqroas from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_pastloss;
  if v_status is distinct from 'Successful' or v_reqroas is not null then
    raise exception 'TEST_FAILED: client with real (if unprofitable) spend history — expected status=Successful (fallback rule, unchanged) required_roas=null, got status=% required_roas=%', v_status, v_reqroas;
  end if;

  select status, required_roas, current_roas into v_status, v_reqroas, v_curroas from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_growthbar;
  if v_status is distinct from 'Successful' or v_reqroas is not null or v_curroas is null then
    raise exception 'TEST_FAILED: client with valid positive baseline — expected status=Successful (growth-vs-tier, unchanged) required_roas=null current_roas computed, got status=% required_roas=% current_roas=%', v_status, v_reqroas, v_curroas;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all Required ROAS / Breakeven scenarios passed; rolling back every fabricated row.';
end $$;
