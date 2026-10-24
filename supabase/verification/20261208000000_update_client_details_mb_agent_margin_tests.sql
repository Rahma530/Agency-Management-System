-- Run this AFTER applying 20261208000000_update_client_details_mb_agent_margin.sql, BEFORE
-- merging. Baseline-relative: picks a real media_buying_agent with a real assigned client (via
-- public.assignments, service_type = 'media_buying'), confirms they can set profit_margin_pct on
-- THAT client (margin-only patch), confirms a mixed patch is rejected outright, and confirms they
-- CANNOT set it on a client they are not assigned to as media buyer. Rolls itself back.
begin;

do $$
declare
  v_mb_agent_id text;
  v_mb_agent_auth_id text;
  v_own_client_id text;
  v_other_client_id text;
  v_before numeric;
  v_after numeric;
  v_rejected boolean := false;
begin
  select a.agent_id, a.client_id into v_mb_agent_id, v_own_client_id
    from public.assignments a
    join public.users u on u.id = a.agent_id and u.role = 'media_buying_agent'
    where a.service_type = 'media_buying'
    limit 1;

  if v_mb_agent_id is null then
    raise exception 'Need at least one media_buying_agent with an assigned media_buying client — none found.';
  end if;

  select auth_id into v_mb_agent_auth_id from public.users where id = v_mb_agent_id;
  if v_mb_agent_auth_id is null then
    raise exception 'The media_buying_agent has no auth_id — cannot impersonate.';
  end if;

  -- a client NOT assigned to this agent as media buyer, to prove the scoping actually checks
  -- assignment and isn't just role-based
  select c.id into v_other_client_id
    from public.clients c
    where c.id <> v_own_client_id
      and not exists (
        select 1 from public.assignments a2
        where a2.client_id = c.id and a2.service_type = 'media_buying' and a2.agent_id = v_mb_agent_id
      )
    limit 1;

  select profit_margin_pct into v_before from public.clients where id = v_own_client_id;

  -- own client, margin-only patch: must succeed
  perform set_config('request.jwt.claims', json_build_object('sub', v_mb_agent_auth_id)::text, true);
  set local role authenticated;

  perform public.update_client_details(v_own_client_id, jsonb_build_object('profit_margin_pct', 0.25));

  reset role;
  perform set_config('request.jwt.claims', '', true);

  select profit_margin_pct into v_after from public.clients where id = v_own_client_id;
  if v_after is distinct from 0.25 then
    raise exception 'media_buying_agent margin-only patch on own client did not save as 0.25 (got %)', v_after;
  end if;

  -- own client, mixed patch: must be rejected outright
  v_rejected := false;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mb_agent_auth_id)::text, true);
  set local role authenticated;

  begin
    perform public.update_client_details(
      v_own_client_id,
      jsonb_build_object('profit_margin_pct', 0.4, 'contract_value', 999999)
    );
  exception when others then
    v_rejected := true;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  if not v_rejected then
    raise exception 'media_buying_agent was allowed to patch a field other than profit_margin_pct';
  end if;

  if (select profit_margin_pct from public.clients where id = v_own_client_id) is distinct from 0.25 then
    raise exception 'the rejected mixed patch leaked a partial write to profit_margin_pct';
  end if;

  -- a client this agent is NOT assigned to as media buyer: must be rejected, even margin-only
  if v_other_client_id is not null then
    v_rejected := false;
    perform set_config('request.jwt.claims', json_build_object('sub', v_mb_agent_auth_id)::text, true);
    set local role authenticated;

    begin
      perform public.update_client_details(v_other_client_id, jsonb_build_object('profit_margin_pct', 0.3));
    exception when others then
      v_rejected := true;
    end;

    reset role;
    perform set_config('request.jwt.claims', '', true);

    if not v_rejected then
      raise exception 'media_buying_agent was allowed to set profit_margin_pct on a client they are not assigned to';
    end if;
  end if;

  update public.clients set profit_margin_pct = v_before where id = v_own_client_id;

  raise notice 'All media_buying_agent profit_margin_pct scoping checks passed.';
end $$;

rollback;

do $$ begin raise notice 'TEST_OK_ROLLED_BACK'; end $$;
