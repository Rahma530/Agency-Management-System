-- ============================================================================
-- FUNCTION TESTS for 20261214000000_mentorship_store_platforms_only.sql. NOT a migration — lives
-- outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. PERSONAS are REAL existing active
-- employees (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing). Every
-- client/assignment/insights row is throwaway (zz_test_ prefixed). The final
-- `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit transaction wrapping this whole
-- DO block, rolling back every single write above it — nothing persists either way.
--
-- Coverage: the exact opposite of 20261213000000's ad-platform-only test —
--   1. A client logged only on tiktok+meta+google+snapchat (the new active/inactive zero-value
--      marker rows) shows up as "No Data" for the selected month even though
--      media_buying_insights rows exist for it.
--   2. A client logged only on salla+zid has those numbers summed into Current Sales/Spent.
--   3. A client logged on salla (counts) AND tiktok (zero-value marker, excluded) sums ONLY the
--      salla amounts into Current Sales/Spent.
-- ============================================================================
do $$
declare
  v_buyer_id text; v_buyer_auth uuid;

  v_reporting_month date := date_trunc('month', now())::date;

  v_client_adonly text := 'zz_test_client_storeonly_adonly';
  v_client_storeonly text := 'zz_test_client_storeonly_storeonly';
  v_client_mixed text := 'zz_test_client_storeonly_mixed';

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

  insert into public.clients (id, name, services, status, profit_margin_pct, start_date) values
    (v_client_adonly, 'ZZ Test StorePlatformsOnly AdOnly', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_storeonly, 'ZZ Test StorePlatformsOnly StoreOnly', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date),
    (v_client_mixed, 'ZZ Test StorePlatformsOnly Mixed', array['media_buying'], 'active', 0.5, (v_reporting_month - interval '6 months')::date);

  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id) values
    ('zz_test_assign_storeonly_adonly', v_client_adonly, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_storeonly_storeonly', v_client_storeonly, 'media_buying', v_buyer_id, v_buyer_id),
    ('zz_test_assign_storeonly_mixed', v_client_mixed, 'media_buying', v_buyer_id, v_buyer_id);

  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, sales_value) values
    -- adonly: only ad-platform zero-value marker rows -> must be excluded entirely -> No Data.
    ('zz_test_insight_storeonly_adonly_tiktok', v_client_adonly, 'tiktok', v_reporting_month, 0, 0),
    ('zz_test_insight_storeonly_adonly_meta', v_client_adonly, 'meta', v_reporting_month, 0, 0),
    -- storeonly: salla + zid real numbers -> both counted.
    ('zz_test_insight_storeonly_storeonly_salla', v_client_storeonly, 'salla', v_reporting_month, 500, 2000),
    ('zz_test_insight_storeonly_storeonly_zid', v_client_storeonly, 'zid', v_reporting_month, 500, 2000),
    -- mixed: salla (counts) + tiktok marker (excluded) in the same month.
    ('zz_test_insight_storeonly_mixed_salla', v_client_mixed, 'salla', v_reporting_month, 1000, 5000),
    ('zz_test_insight_storeonly_mixed_tiktok', v_client_mixed, 'tiktok', v_reporting_month, 0, 0);

  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer_auth)::text, true);
  set local role authenticated;

  select status, current_sales into v_status, v_sales from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_adonly;
  if v_status is distinct from 'No Data' or v_sales is not null then
    raise exception 'TEST_FAILED: client logged only on tiktok+meta (ad-platform markers) — expected status=No Data current_sales=null, got status=% current_sales=%', v_status, v_sales;
  end if;

  select current_sales, current_spent into v_sales, v_spend from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_storeonly;
  if v_sales is distinct from 4000 or v_spend is distinct from 1000 then
    raise exception 'TEST_FAILED: client logged on salla+zid — expected current_sales=4000 current_spent=1000 (both summed), got sales=% spent=%', v_sales, v_spend;
  end if;

  select current_sales, current_spent into v_sales, v_spend from public.get_mentorship_snapshot(v_reporting_month) where client_id = v_client_mixed;
  if v_sales is distinct from 5000 or v_spend is distinct from 1000 then
    raise exception 'TEST_FAILED: salla+tiktok logged together — expected current_sales=5000 current_spent=1000 (tiktok marker excluded), got sales=% spent=%', v_sales, v_spend;
  end if;

  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all store-platforms-only scenarios passed; rolling back every fabricated row.';
end $$;
