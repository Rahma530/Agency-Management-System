-- ============================================================================
-- FUNCTION TESTS for 20261212000000_mentorship_status_month_only.sql. NOT a migration — lives
-- outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. PERSONAS are REAL existing active
-- employees (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing). Every
-- client/assignment/insights row is throwaway (zz_test_ prefixed). The final
-- `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit transaction wrapping this whole
-- DO block, rolling back every single write above it — nothing persists either way.
--
-- Coverage: the new flat 4-branch status (Successful / Below Target / No Data / Setup Needed)
-- against hand-computed expected numbers, specifically proving start_date no longer matters:
--   - a brand-new client (start_date = today, i.e. would have been "Onboarding" under the old
--     rule) with a positive current-month profit and NO prior-month history at all (would have
--     been "No Baseline" under the old rule once past onboarding) is now Successful.
--   - a long-standing client (start_date 2 years ago) with a negative current-month profit is
--     Below Target purely off this month's numbers, regardless of history.
--   - a client with no sales logged for the selected month is No Data.
--   - a client with no profit_margin_pct set is Setup Needed, even with a start_date.
-- ============================================================================
do $$
declare
  v_buyer_id text; v_buyer_auth uuid;

  v_reporting_month date := date_trunc('month', now())::date;

  v_client_newclient text := 'zz_test_client_statusfix_newclient';
  v_client_longstanding text := 'zz_test_client_statusfix_longstanding';
  v_client_nodata text := 'zz_test_client_statusfix_nodata';
  v_client_setup text := 'zz_test_client_statusfix_setup';

  v_status text;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: a real persona.
  -- ======================================================================
  select id, auth_id into v_buyer_id, v_buyer_auth
    from public.users where role = 'media_buying_agent' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_buyer_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active media_buying_agent with a linked auth account.';
  end if;

  -- ======================================================================
  -- Fabricate clients — one per status branch, deliberately picking start_date values that
  -- would have driven a DIFFERENT status under the old start_date-dependent rule.
  -- ======================================================================
  insert into public.clients (id, name, services, status, profit_margin_pct, start_date) values
    -- brand-new client (joined today) — old rule: p_reporting_month = start month => NOT before
    -- first_full.month, so not actually "Onboarding" here; but it also has NO prior 3 months of
    -- data at all, so old rule would have hit avg3.avg_sales is null => 'No Baseline' once past
    -- month 1. New rule only looks at this month's own numbers: profit = 10000*.5-3000 = 2000 >= 0.
    (v_client_newclient, 'ZZ Test StatusFix NewClient', array['media_buying'], 'active', 0.5, v_reporting_month),
    -- long-standing client (joined 2 years ago), no prior-month history logged (consistent with
    -- "real logging only started in October"), negative profit this month.
    (v_client_longstanding, 'ZZ Test StatusFix Longstanding', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '2 years')::date),
    -- no sales logged this month at all.
    (v_client_nodata, 'ZZ Test StatusFix NoData', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '2 years')::date),
    -- margin not set, but DOES have a start_date — proves Setup Needed no longer needs start_date
    -- to also be missing (and isn't accidentally bypassed by having one).
    (v_client_setup, 'ZZ Test StatusFix Setup', array['media_buying'], 'active', null, (v_reporting_month - interval '2 years')::date);

  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id) values
    ('zz_test_assign_statusfix_newclient', v_client_newclient, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_statusfix_longstanding', v_client_longstanding, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_statusfix_nodata', v_client_nodata, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_statusfix_setup', v_client_setup, 'media_buying', v_buyer_id, v_buyer_id);

  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, sales_value) values
    -- newclient: profit = 10000*.5-3000 = 2000 >= 0 -> Successful. No prior-month rows at all.
    ('zz_test_insight_statusfix_newclient_cur', v_client_newclient, 'tiktok', v_reporting_month, 3000, 10000),
    -- longstanding: profit = 10000*.5-6000 = -1000 < 0 -> Below Target. No prior-month rows.
    ('zz_test_insight_statusfix_longstanding_cur', v_client_longstanding, 'tiktok', v_reporting_month, 6000, 10000);
    -- nodata and setup: no insights rows for the current month at all.

  -- ======================================================================
  -- Verify as the media buyer themself.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer_auth)::text, true);
  set local role authenticated;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_newclient;
  if v_status is distinct from 'Successful' then
    raise exception 'TEST_FAILED: brand-new client with positive current-month profit and no history — expected Successful (old rule would have said Onboarding/No Baseline), got %', v_status;
  end if;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_longstanding;
  if v_status is distinct from 'Below Target' then
    raise exception 'TEST_FAILED: long-standing client with negative current-month profit — expected Below Target purely off this month''s numbers, got %', v_status;
  end if;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_nodata;
  if v_status is distinct from 'No Data' then
    raise exception 'TEST_FAILED: client with no sales logged this month — expected No Data, got %', v_status;
  end if;

  select status into v_status from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_setup;
  if v_status is distinct from 'Setup Needed' then
    raise exception 'TEST_FAILED: client with no profit_margin_pct (despite having a start_date) — expected Setup Needed, got %', v_status;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all simplified status scenarios passed; rolling back every fabricated row.';
end $$;
