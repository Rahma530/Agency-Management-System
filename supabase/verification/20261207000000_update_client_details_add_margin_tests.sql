-- Run this AFTER applying 20261207000000_update_client_details_add_margin.sql, BEFORE merging.
-- Baseline-relative: picks a real existing client (no hardcoded id), impersonates the client's
-- own am_agent (or an executive if none has clients assigned), writes profit_margin_pct through
-- the RPC, checks it landed and the range guard works, then checks the scoped
-- media_buying_team_lead permission (margin-only patches allowed, anything else on the same patch
-- rejected), then rolls itself back.
begin;

do $$
declare
  v_client_id text;
  v_am_agent_id text;
  v_am_agent_auth_id text;
  v_executive_auth_id text;
  v_mb_tl_auth_id text;
  v_before numeric;
  v_after numeric;
  v_rejected boolean := false;
begin
  select c.id, c.am_agent_id into v_client_id, v_am_agent_id
    from public.clients c where c.am_agent_id is not null limit 1;

  if v_client_id is null then
    raise exception 'Need at least one client with an am_agent_id assigned to test against — none found.';
  end if;

  select auth_id into v_am_agent_auth_id from public.users where id = v_am_agent_id;

  if v_am_agent_auth_id is null then
    raise exception 'The am_agent assigned to the test client has no auth_id — cannot impersonate.';
  end if;

  select profit_margin_pct into v_before from public.clients where id = v_client_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth_id)::text, true);
  set local role authenticated;

  perform public.update_client_details(v_client_id, jsonb_build_object('profit_margin_pct', 0.3));

  reset role;
  perform set_config('request.jwt.claims', '', true);

  select profit_margin_pct into v_after from public.clients where id = v_client_id;
  if v_after is distinct from 0.3 then
    raise exception 'profit_margin_pct did not save as 0.3 (got %)', v_after;
  end if;

  -- out-of-range value (>1, i.e. not a fraction) must be rejected
  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth_id)::text, true);
  set local role authenticated;

  begin
    perform public.update_client_details(v_client_id, jsonb_build_object('profit_margin_pct', 1.5));
  exception when others then
    v_rejected := true;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  if not v_rejected then
    raise exception 'update_client_details accepted profit_margin_pct = 1.5, which should be rejected (must be 0..1)';
  end if;

  -- media_buying_team_lead: margin-only patch must succeed
  select auth_id into v_mb_tl_auth_id from public.users where role = 'media_buying_team_lead' limit 1;

  if v_mb_tl_auth_id is null then
    raise exception 'Need at least one media_buying_team_lead in users to test against — none found.';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_mb_tl_auth_id)::text, true);
  set local role authenticated;

  perform public.update_client_details(v_client_id, jsonb_build_object('profit_margin_pct', 0.2));

  reset role;
  perform set_config('request.jwt.claims', '', true);

  select profit_margin_pct into v_after from public.clients where id = v_client_id;
  if v_after is distinct from 0.2 then
    raise exception 'media_buying_team_lead margin-only patch did not save as 0.2 (got %)', v_after;
  end if;

  -- media_buying_team_lead: a patch that ALSO touches another field must be rejected outright
  -- (not partially applied)
  v_rejected := false;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mb_tl_auth_id)::text, true);
  set local role authenticated;

  begin
    perform public.update_client_details(
      v_client_id,
      jsonb_build_object('profit_margin_pct', 0.1, 'sales_brief', 'should not be allowed')
    );
  exception when others then
    v_rejected := true;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  if not v_rejected then
    raise exception 'media_buying_team_lead was allowed to patch a field other than profit_margin_pct';
  end if;

  if (select profit_margin_pct from public.clients where id = v_client_id) is distinct from 0.2 then
    raise exception 'the rejected mixed patch leaked a partial write to profit_margin_pct';
  end if;

  -- restore to the pre-test value (null-safe) so the baseline check below is meaningful even
  -- though the whole block rolls back anyway
  update public.clients set profit_margin_pct = v_before where id = v_client_id;

  raise notice 'All update_client_details profit_margin_pct checks passed.';
end $$;

rollback;

do $$ begin raise notice 'TEST_OK_ROLLED_BACK'; end $$;
