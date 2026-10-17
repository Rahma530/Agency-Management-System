-- Verification for 20261114000000_merge_clients.sql — merge_clients() and its runtime FK
-- discovery.
--
-- Single DO block, distinct real personas for the role gate (am_agent and a *_team_lead both
-- rejected, same posture as delete_tasks), two brand-new fixture clients (so every count below is
-- exact — a fresh client id is guaranteed to start with zero related rows anywhere, no baseline
-- needed), ends in a raised exception so every fabricated row is rolled back: TEST_OK_ROLLED_BACK
-- on success, a descriptive TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
do $$
declare
  v_admin_id text;
  v_admin_auth uuid;
  v_nonadmin_id text;
  v_nonadmin_auth uuid;
  v_tl_id text;
  v_tl_auth uuid;

  v_keep_id text;
  v_dup_id text;
  v_dup_name text;
  v_task_id text;
  v_pc_keep_id text;
  v_pc_dup_conflict_id text;
  v_pc_dup_unique_id text;
  v_as_keep_id text;
  v_as_dup_conflict_id text;
  v_as_dup_unique_id text;

  v_discovered_tables text[];
  v_expected_tables text[] := array[
    'analytics_insights', 'assignments', 'briefs', 'campaigns', 'client_comparisons',
    'client_contracts', 'client_lifecycle_periods', 'client_portal_users', 'client_renewal_events',
    'daily_logs', 'media_buying_insights', 'meetings', 'platform_connections', 'report_source_items',
    'reports', 'seo_insights', 'social_insights', 'tasks'
  ];

  v_result jsonb;
  v_count integer;
  v_client_id_check text;
  v_log_row record;
begin
  -- ======================================================================
  -- Scenario 1: dynamic FK discovery covers exactly the expected table set. Checked directly
  -- against pg_constraint — the same catalog, same predicate (contype = 'f', confrelid =
  -- clients) merge_clients() itself uses — independent of calling the function at all.
  -- ======================================================================
  select array_agg(distinct conrelid::regclass::text order by conrelid::regclass::text)
    into v_discovered_tables
  from pg_constraint
  where contype = 'f' and confrelid = 'public.clients'::regclass;

  if v_discovered_tables is distinct from (select array_agg(t order by t) from unnest(v_expected_tables) as t) then
    raise exception 'TEST_FAILED: scenario 1 — discovered FK tables %, expected %.', v_discovered_tables, v_expected_tables;
  end if;

  -- Distinct real personas for the role gate.
  select id, auth_id into v_admin_id, v_admin_auth from public.users
  where role in ('executive', 'head_of_technical', 'ai_engineer') and auth_id is not null and deactivated_at is null
  limit 1;
  if v_admin_id is null then
    raise exception 'TEST_SETUP_FAILED: no active executive/head_of_technical/ai_engineer persona found.';
  end if;

  select id, auth_id into v_nonadmin_id, v_nonadmin_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null and id <> v_admin_id
  limit 1;
  if v_nonadmin_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_agent persona found.';
  end if;

  select id, auth_id into v_tl_id, v_tl_auth from public.users
  where role like '%\_team\_lead' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_nonadmin_id
  limit 1;
  if v_tl_id is null then
    raise exception 'TEST_SETUP_FAILED: no active *_team_lead persona found.';
  end if;

  -- Fresh fixture clients — guaranteed zero pre-existing related rows anywhere.
  v_keep_id := 'zz_merge_keep_' || substr(md5(random()::text), 1, 8);
  v_dup_id := 'zz_merge_dup_' || substr(md5(random()::text), 1, 8);
  v_dup_name := 'ZZ Merge Duplicate Co';

  insert into public.clients (id, name, services, status)
  values
    (v_keep_id, 'ZZ Merge Keep Co', array['seo'], 'active'),
    (v_dup_id, v_dup_name, array['seo', 'social_media'], 'active');

  -- Generic-pass fixture: one task on the duplicate client (must simply move).
  v_task_id := 'zz_merge_task_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task_id, v_dup_id, 'ZZ merge task', 'test', v_admin_id, 'Technical', 'todo', current_date + 5, 'low');

  -- platform_connections: a real unique (client_id, platform_name) constraint — the keep and
  -- duplicate client both have a 'facebook' row (must collide -> duplicate's row deleted), while
  -- the duplicate's 'instagram' row has no counterpart at keep (must simply move).
  v_pc_keep_id := 'zz_merge_pc_keep_' || substr(md5(random()::text), 1, 8);
  v_pc_dup_conflict_id := 'zz_merge_pc_dupc_' || substr(md5(random()::text), 1, 8);
  v_pc_dup_unique_id := 'zz_merge_pc_dupu_' || substr(md5(random()::text), 1, 8);
  insert into public.platform_connections (id, client_id, platform_category, platform_name)
  values
    (v_pc_keep_id, v_keep_id, 'social_media', 'facebook'),
    (v_pc_dup_conflict_id, v_dup_id, 'social_media', 'facebook'),
    (v_pc_dup_unique_id, v_dup_id, 'social_media', 'instagram');

  -- assignments: no unique constraint at all, but the duplicate's 'seo' row collides with the
  -- keep client's own 'seo' row at the business-rule level (must be deleted, not moved); the
  -- duplicate's 'social_media' row has no counterpart at keep (must simply move).
  v_as_keep_id := 'zz_merge_as_keep_' || substr(md5(random()::text), 1, 8);
  v_as_dup_conflict_id := 'zz_merge_as_dupc_' || substr(md5(random()::text), 1, 8);
  v_as_dup_unique_id := 'zz_merge_as_dupu_' || substr(md5(random()::text), 1, 8);
  insert into public.assignments (id, client_id, service_type, team_lead_id, agent_id)
  values
    (v_as_keep_id, v_keep_id, 'seo', v_admin_id, v_admin_id),
    (v_as_dup_conflict_id, v_dup_id, 'seo', v_admin_id, v_admin_id),
    (v_as_dup_unique_id, v_dup_id, 'social_media', v_admin_id, v_admin_id);

  -- ======================================================================
  -- Scenario 2: am_agent (ordinary employee) is rejected — nothing moved, nothing deleted.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_nonadmin_auth)::text, true);
  set local role authenticated;
  begin
    perform public.merge_clients(v_keep_id, v_dup_id);
    raise exception 'TEST_FAILED: scenario 2 — am_agent must be rejected by merge_clients.';
  exception when others then
    if sqlerrm not like '%executive%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 3: a *_team_lead is rejected too — not in the allowed role list.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth)::text, true);
  set local role authenticated;
  begin
    perform public.merge_clients(v_keep_id, v_dup_id);
    raise exception 'TEST_FAILED: scenario 3 — a team lead must be rejected by merge_clients.';
  exception when others then
    if sqlerrm not like '%executive%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.clients where id = v_dup_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: the two rejected calls above must not have deleted the duplicate client.';
  end if;

  -- ======================================================================
  -- Scenario 3b: merge_clients_preview() — non-admin rejected (nothing to preview), then the
  -- admin's preview must report exact integer counts, read-only (nothing moved/deleted by it).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_nonadmin_auth)::text, true);
  set local role authenticated;
  begin
    perform public.merge_clients_preview(v_keep_id, v_dup_id);
    raise exception 'TEST_FAILED: scenario 3b — am_agent must be rejected by merge_clients_preview.';
  exception when others then
    if sqlerrm not like '%executive%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth)::text, true);
  set local role authenticated;
  select public.merge_clients_preview(v_keep_id, v_dup_id) into v_result;
  reset role; perform set_config('request.jwt.claims', '', true);

  if (v_result -> 'assignments' ->> 'moved')::int <> 1 or (v_result -> 'assignments' ->> 'deleted_duplicates')::int <> 1 then
    raise exception 'TEST_FAILED: scenario 3b — preview assignments mismatch: %.', v_result -> 'assignments';
  end if;
  if (v_result -> 'platform_connections' ->> 'count')::int <> 2 then
    raise exception 'TEST_FAILED: scenario 3b — preview platform_connections.count expected 2, got %.', v_result -> 'platform_connections' ->> 'count';
  end if;
  if (v_result -> 'tasks' ->> 'count')::int <> 1 then
    raise exception 'TEST_FAILED: scenario 3b — preview tasks.count expected 1, got %.', v_result -> 'tasks' ->> 'count';
  end if;

  -- Read-only: the preview call(s) above must not have moved or deleted any fixture row.
  select count(*) into v_count from public.tasks where id = v_task_id and client_id = v_dup_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 3b — merge_clients_preview must not mutate anything (task moved unexpectedly).';
  end if;
  select count(*) into v_count from public.assignments where client_id = v_dup_id;
  if v_count <> 2 then
    raise exception 'TEST_FAILED: scenario 3b — merge_clients_preview must not mutate anything (assignments row count changed).';
  end if;

  -- ======================================================================
  -- Scenario 4: the admin persona merges. Verify every fixture row's fate.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth)::text, true);
  set local role authenticated;
  v_result := public.merge_clients(v_keep_id, v_dup_id);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.clients where id = v_dup_id;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 4 — the duplicate client must be gone after the merge.';
  end if;

  select client_id into v_client_id_check from public.tasks where id = v_task_id;
  if v_client_id_check <> v_keep_id then
    raise exception 'TEST_FAILED: scenario 4 — the task must have moved to the keep client, got %.', v_client_id_check;
  end if;

  select client_id into v_client_id_check from public.platform_connections where id = v_pc_dup_unique_id;
  if v_client_id_check <> v_keep_id then
    raise exception 'TEST_FAILED: scenario 4 — the non-conflicting platform_connections row must have moved.';
  end if;
  select count(*) into v_count from public.platform_connections where id = v_pc_dup_conflict_id;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 4 — the conflicting duplicate platform_connections row must be deleted, not moved.';
  end if;
  select count(*) into v_count from public.platform_connections where id = v_pc_keep_id and client_id = v_keep_id and platform_name = 'facebook';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — the keep client''s own platform_connections row must be untouched.';
  end if;

  select client_id into v_client_id_check from public.assignments where id = v_as_dup_unique_id;
  if v_client_id_check <> v_keep_id then
    raise exception 'TEST_FAILED: scenario 4 — the non-conflicting assignments row (social_media) must have moved.';
  end if;
  select count(*) into v_count from public.assignments where id = v_as_dup_conflict_id;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 4 — the duplicate-service_type assignments row (seo) must be deleted, not moved.';
  end if;
  select count(*) into v_count from public.assignments where id = v_as_keep_id and client_id = v_keep_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — the keep client''s own assignments row must be untouched.';
  end if;

  -- ======================================================================
  -- Scenario 5: deletion_log got the right row, with the right related_counts.
  -- ======================================================================
  select * into v_log_row from public.deletion_log where entity_type = 'client' and entity_id = v_dup_id;
  if v_log_row.entity_id is null then
    raise exception 'TEST_FAILED: scenario 5 — no deletion_log row found for the merged-away client.';
  end if;
  if v_log_row.entity_name <> v_dup_name then
    raise exception 'TEST_FAILED: scenario 5 — entity_name mismatch: %.', v_log_row.entity_name;
  end if;
  if v_log_row.deleted_by <> v_admin_id then
    raise exception 'TEST_FAILED: scenario 5 — deleted_by mismatch: %.', v_log_row.deleted_by;
  end if;
  if (v_log_row.snapshot ->> 'id') <> v_dup_id then
    raise exception 'TEST_FAILED: scenario 5 — snapshot.id mismatch: %.', v_log_row.snapshot ->> 'id';
  end if;
  if (v_log_row.related_counts -> 'assignments' ->> 'moved')::int <> 1
     or (v_log_row.related_counts -> 'assignments' ->> 'deleted_duplicates')::int <> 1 then
    raise exception 'TEST_FAILED: scenario 5 — related_counts.assignments mismatch: %.', v_log_row.related_counts -> 'assignments';
  end if;
  if (v_log_row.related_counts -> 'platform_connections' ->> 'moved')::int <> 1
     or (v_log_row.related_counts -> 'platform_connections' ->> 'deleted_duplicates')::int <> 1 then
    raise exception 'TEST_FAILED: scenario 5 — related_counts.platform_connections mismatch: %.', v_log_row.related_counts -> 'platform_connections';
  end if;
  if (v_log_row.related_counts -> 'tasks' ->> 'moved')::int <> 1 then
    raise exception 'TEST_FAILED: scenario 5 — related_counts.tasks mismatch: %.', v_log_row.related_counts -> 'tasks';
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all merge_clients scenarios passed; rolling back every fabricated row.';
end $$;
