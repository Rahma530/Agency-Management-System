-- ============================================================================
-- FUNCTION/POLICY TESTS for 20261210000000_media_buying_insights_admin_emergency_write.sql. NOT a
-- migration — lives outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. PERSONAS are REAL existing active
-- employees (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing). The
-- media_buying_insights row inserted is throwaway (zz_test_ prefixed id) against a REAL existing
-- client (no new client created). The final `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts
-- the implicit transaction wrapping this whole DO block, rolling back every single write above it
-- — nothing persists either way.
--
-- Coverage:
--   1. executive can now insert a media_buying_insights row for ANY client (previously blocked).
--   2. head_of_technical can now insert a media_buying_insights row for ANY client (previously
--      blocked).
--   3. media_buying_agent with NO assignment to the client is still blocked (unchanged negative
--      case — confirms this migration only widened the admin roles, not the agent scoping).
-- ============================================================================
do $$
declare
  v_exec_id text; v_exec_auth uuid;
  v_hot_id text; v_hot_auth uuid;
  v_unassigned_agent_id text; v_unassigned_agent_auth uuid;
  v_client_id text;
  v_insert_failed boolean;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: real personas + a real existing client.
  -- ======================================================================
  select id, auth_id into v_exec_id, v_exec_auth
    from public.users where role = 'executive' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_exec_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active executive with a linked auth account.';
  end if;

  select id, auth_id into v_hot_id, v_hot_auth
    from public.users where role = 'head_of_technical' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_hot_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active head_of_technical with a linked auth account.';
  end if;

  select id, auth_id into v_unassigned_agent_id, v_unassigned_agent_auth
    from public.users where role = 'media_buying_agent' and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_unassigned_agent_id is null then
    raise exception 'TEST_SETUP_FAILED: need a real active media_buying_agent with a linked auth account.';
  end if;

  select id into v_client_id
    from public.clients c
    where not exists (
      select 1 from public.assignments a
      where a.client_id = c.id and a.agent_id = v_unassigned_agent_id and a.service_type = 'media_buying'
    )
    limit 1;
  if v_client_id is null then
    raise exception 'TEST_SETUP_FAILED: need at least one client the test media_buying_agent is NOT assigned to.';
  end if;

  -- ======================================================================
  -- 1. executive can insert for this client (previously would have raised).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth)::text, true);
  set local role authenticated;

  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, source, created_by)
  values ('zz_test_mbi_exec_emergency', v_client_id, 'tiktok', date_trunc('month', now())::date, 100, 'manual', v_exec_id);

  reset role;
  perform set_config('request.jwt.claims', '', true);
  raise notice 'executive insert: OK';

  -- ======================================================================
  -- 2. head_of_technical can insert for this client (previously would have raised).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_hot_auth)::text, true);
  set local role authenticated;

  insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, source, created_by)
  values ('zz_test_mbi_hot_emergency', v_client_id, 'meta', date_trunc('month', now())::date, 100, 'manual', v_hot_id);

  reset role;
  perform set_config('request.jwt.claims', '', true);
  raise notice 'head_of_technical insert: OK';

  -- ======================================================================
  -- 3. An unassigned media_buying_agent is still blocked from this client (unchanged).
  -- ======================================================================
  v_insert_failed := false;
  perform set_config('request.jwt.claims', json_build_object('sub', v_unassigned_agent_auth)::text, true);
  set local role authenticated;

  begin
    insert into public.media_buying_insights (id, client_id, platform, week_start_date, spend, source, created_by)
    values ('zz_test_mbi_unassigned_agent', v_client_id, 'snapchat', date_trunc('month', now())::date, 100, 'manual', v_unassigned_agent_id);
  exception when others then
    v_insert_failed := true;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  if not v_insert_failed then
    raise exception 'TEST_FAILED: unassigned media_buying_agent was able to insert — scoping regressed.';
  end if;
  raise notice 'unassigned media_buying_agent insert: correctly blocked';

  raise exception 'TEST_OK_ROLLED_BACK: executive + head_of_technical can now log media buying data for any client; unassigned agent still blocked.';
end $$;
