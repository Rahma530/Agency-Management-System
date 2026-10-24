-- Verification for 20261201000000_client_access_attachments.sql.
--
-- Scope: the 3 RPCs (insert/get/delete_client_access_attachment) and the direct-table lockdown
-- (no authenticated grant/policy at all). The storage.objects policies reuse the exact predicate
-- shape already shipped for client_contracts' own storage.objects policies and are left
-- unverified here, same precedent as 20261130000000_brief_attachments_tests.sql.
--
-- Single DO block, real personas, ends in a raised exception so every fabricated change is rolled
-- back regardless of outcome: TEST_OK_ROLLED_BACK on success, a descriptive
-- TEST_FAILED/TEST_SETUP_FAILED exception otherwise. Every RPC-denial scenario below expects the
-- RPC's own `raise exception` (not a silently-filtered empty result), so each is wrapped in its
-- own nested begin/exception, matching this schema's established pattern for RPC permission tests
-- (e.g. 20261120000000_auto_daily_log_from_delivered_task_tests.sql's scenario 12 setup note).
do $$
declare
  v_am_agent_id text; v_am_agent_auth uuid;              -- this test client's own am_agent
  v_other_am_agent_id text; v_other_am_agent_auth uuid;  -- a DIFFERENT client's am_agent
  v_exec_id text; v_exec_auth uuid;
  v_unrelated_id text; v_unrelated_auth uuid;
  v_client_id text := 'zz_cxa_c_' || substr(md5(random()::text), 1, 8);
  v_other_client_id text := 'zz_cxa_oc_' || substr(md5(random()::text), 1, 8);
  v_attachment_id text;
  v_count integer;
  v_log_count_before integer;
  v_log_count_after integer;
begin
  select id, auth_id into v_am_agent_id, v_am_agent_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null limit 1;
  select id, auth_id into v_other_am_agent_id, v_other_am_agent_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null and id <> v_am_agent_id limit 1;
  select id, auth_id into v_exec_id, v_exec_auth from public.users
  where role = 'executive' and auth_id is not null and deactivated_at is null limit 1;
  select id, auth_id into v_unrelated_id, v_unrelated_auth from public.users
  where role = 'social_media_agent' and auth_id is not null and deactivated_at is null limit 1;

  if v_am_agent_id is null or v_other_am_agent_id is null or v_exec_id is null or v_unrelated_id is null then
    raise exception 'TEST_SETUP_FAILED: need at least 2 distinct active am_agent personas, 1 executive, 1 social_media_agent.';
  end if;

  insert into public.clients (id, name, status, am_agent_id) values
    (v_client_id, 'ZZ Client Access Attachments Test Client', 'active', v_am_agent_id),
    (v_other_client_id, 'ZZ Client Access Attachments Other Client', 'active', v_other_am_agent_id);

  -- ==========================================================================
  -- Scenario 1: the client's own am_agent can insert an attachment via the RPC.
  -- ==========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' (scenario 1).';
  end if;
  select public.insert_client_access_attachment(v_client_id, v_client_id || '/id.jpg', 'id.jpg', 2048, 'image/jpeg', 'Ad account owner ID')
  into v_attachment_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_attachment_id is null then
    raise exception 'TEST_FAILED: scenario 1 — insert_client_access_attachment must return a new id for the client''s own am_agent.';
  end if;

  -- ==========================================================================
  -- Scenario 2: the direct table has NO authenticated access at all, even for the uploader —
  -- bypassing the RPC must fail outright (no grant: "permission denied for table"), not merely be
  -- filtered to zero rows by RLS.
  -- ==========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform 1 from public.client_access_attachments where id = v_attachment_id;
    raise exception 'TEST_FAILED: scenario 2 — a direct select against client_access_attachments must be denied outright (no table grant), not merely filtered by RLS.';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ==========================================================================
  -- Scenario 3: a DIFFERENT client's am_agent cannot read this client's attachments via the RPC —
  -- the RPC must raise, not return zero rows.
  -- ==========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_am_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform 1 from public.get_client_access_attachments(v_client_id);
    raise exception 'TEST_FAILED: scenario 3 — a different client''s am_agent must be denied by get_client_access_attachments, not silently succeed.';
  exception
    when others then
      if sqlerrm not like 'You do not have permission to view this client''s access attachments.%' then
        raise; -- a genuinely unexpected error — do not swallow it
      end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ==========================================================================
  -- Scenario 4: executive can list it, and the read is logged to client_access_log.
  -- ==========================================================================
  select count(*) into v_log_count_before from public.client_access_log where client_id = v_client_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_count from public.get_client_access_attachments(v_client_id);
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — executive must see exactly 1 attachment via the RPC, found %.', v_count;
  end if;

  select count(*) into v_log_count_after from public.client_access_log where client_id = v_client_id;
  if v_log_count_after <= v_log_count_before then
    raise exception 'TEST_FAILED: scenario 4 — get_client_access_attachments must log the read to client_access_log, before % after %.', v_log_count_before, v_log_count_after;
  end if;

  -- ==========================================================================
  -- Scenario 5: an unrelated employee (social_media_agent) cannot list it.
  -- ==========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_unrelated_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform 1 from public.get_client_access_attachments(v_client_id);
    raise exception 'TEST_FAILED: scenario 5 — an unrelated employee must be denied by get_client_access_attachments.';
  exception
    when others then
      if sqlerrm not like 'You do not have permission to view this client''s access attachments.%' then
        raise;
      end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ==========================================================================
  -- Scenario 6: the client's own am_agent can delete the attachment via the RPC.
  -- ==========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.delete_client_access_attachment(v_attachment_id);
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_count from public.get_client_access_attachments(v_client_id);
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 6 — the attachment must be gone after delete_client_access_attachment, found %.', v_count;
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all client_access_attachments scenarios passed; rolling back every fabricated change.';
exception when others then
  if sqlerrm like 'TEST_OK_ROLLED_BACK%' or sqlerrm like 'TEST_FAILED%' or sqlerrm like 'TEST_SETUP_FAILED%' then
    raise;
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);
  raise;
end $$;
