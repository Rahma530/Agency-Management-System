-- ============================================================================
-- POLICY TESTS for 20261211000000_mentorship_growth_tiers_role_swap.sql. NOT a migration — lives
-- outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. PERSONAS are REAL existing active
-- employees (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing). The
-- mentorship_growth_tiers row inserted is throwaway (an absurd, clearly-test min_spend so it can
-- never collide with a real tier). The final `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts
-- the implicit transaction wrapping this whole DO block, rolling back every single write above it
-- — nothing persists either way.
--
-- Coverage:
--   1. media_buying_team_lead can now insert a tier (previously blocked).
--   2. ai_engineer is now blocked from inserting a tier (previously allowed — this is the
--      correction itself, so it's the one regression this test exists to catch).
-- ============================================================================
do $$
declare
  v_tl_id text; v_tl_auth uuid;
  v_ai_id text; v_ai_auth uuid;
  v_insert_failed boolean;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  select id, auth_id into v_tl_id, v_tl_auth
    from public.users where role = 'media_buying_team_lead' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_tl_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active media_buying_team_lead with a linked auth account.';
  end if;

  select id, auth_id into v_ai_id, v_ai_auth
    from public.users where role = 'ai_engineer' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_ai_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active ai_engineer with a linked auth account.';
  end if;

  -- ======================================================================
  -- 1. media_buying_team_lead can insert a tier (previously would have raised).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth)::text, true);
  set local role authenticated;

  insert into public.mentorship_growth_tiers (min_spend, max_spend, required_growth_pct, active)
  values (987654321, null, 0.25, false);

  reset role;
  perform set_config('request.jwt.claims', '', true);
  raise notice 'media_buying_team_lead insert: OK';

  -- ======================================================================
  -- 2. ai_engineer is now blocked from inserting a tier (the correction itself).
  -- ======================================================================
  v_insert_failed := false;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ai_auth)::text, true);
  set local role authenticated;

  begin
    insert into public.mentorship_growth_tiers (min_spend, max_spend, required_growth_pct, active)
    values (987654322, null, 0.25, false);
  exception when others then
    v_insert_failed := true;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  if not v_insert_failed then
    raise exception 'TEST_FAILED: ai_engineer was still able to insert a growth tier — role swap did not take.';
  end if;
  raise notice 'ai_engineer insert: correctly blocked';

  raise exception 'TEST_OK_ROLLED_BACK: media_buying_team_lead can now manage growth tiers; ai_engineer no longer can.';
end $$;
