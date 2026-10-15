-- ============================================================================
-- FUNCTION TESTS for 20261108000000_task_platforms.sql. NOT a migration — lives outside
-- supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. Every scenario below fabricates only
-- throwaway clients/tasks/platforms/task_platform_links rows; every PERSONA is a REAL existing
-- active employee (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing,
-- rather than silently skipping a check), kept mutually exclusive by explicit id exclusions. The
-- final `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit transaction wrapping this
-- whole DO block, rolling back every single write performed above it — nothing persists either
-- way, pass or fail.
--
-- "Expect this call to fail" scenarios wrap the call in its own nested BEGIN/EXCEPTION block (a
-- real exception creates an implicit savepoint in plpgsql, so a caught failure doesn't abort the
-- rest of the test). If the call unexpectedly SUCCEEDS, it raises its own 'TEST_FAILED: ...' from
-- inside the try block, which the handler re-raises instead of swallowing — the `sqlerrm like
-- 'TEST_FAILED%'` check tells "the guard correctly raised" apart from "my own alarm fired".
--
-- Coverage: platforms table RLS (select for non-sales, write for the 3 admin roles only),
-- task_platform_links RLS (select gated by task_visible_v2; no direct write path at all — not
-- even for an admin), and set_task_platforms (the creator/am_agent doors succeed, an unrelated
-- employee/sales/marketing_manager are denied, an unknown/inactive platform id is rejected, a
-- platform deactivated out from under an existing link is NOT cascade-removed from
-- task_platform_links, the 10-platform cap is enforced, a second call fully replaces the first
-- call's set rather than unioning with it, and the migration's own seed insert is idempotent under
-- a second run. The gate itself is byte-identical to set_task_assignees' (verified against
-- 20261105000000_task_assignees_rpcs.sql — the only, and therefore latest, migration defining
-- that function, unchanged since PR #91) — already exhaustively tested per-branch in
-- 20261105000000_task_assignees_rpcs_tests.sql — so this file checks the creator/am_agent/
-- outsider/sales/marketing_manager shape of it once rather than re-deriving every team-lead
-- branch again.
-- ============================================================================
do $$
declare
  v_exec_id text; v_exec_auth uuid;
  v_hot_id text; v_hot_auth uuid;
  v_ai_eng_id text; v_ai_eng_auth uuid;
  v_sales_id text; v_sales_auth uuid;
  v_am_agent_id text; v_am_agent_auth uuid;
  v_creator_id text; v_creator_auth uuid;
  v_outsider_id text; v_outsider_auth uuid;
  v_marketing_mgr_id text; v_marketing_mgr_auth uuid;
  v_creative_id text; v_creative_auth uuid;

  v_client_id text;
  v_task_id text;
  v_fake_platform_id text;
  v_count integer;
  v_link_count integer;
  v_seed_count integer;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: select real personas defensively.
  -- ======================================================================
  select id, auth_id into v_exec_id, v_exec_auth
    from public.users where role = 'executive' and auth_id is not null and deactivated_at is null order by id limit 1;
  select id, auth_id into v_hot_id, v_hot_auth
    from public.users where role = 'head_of_technical' and auth_id is not null and deactivated_at is null order by id limit 1;
  select id, auth_id into v_ai_eng_id, v_ai_eng_auth
    from public.users where role = 'ai_engineer' and auth_id is not null and deactivated_at is null order by id limit 1;
  select id, auth_id into v_sales_id, v_sales_auth
    from public.users where role = 'sales' and auth_id is not null and deactivated_at is null order by id limit 1;
  if v_exec_id is null or v_hot_id is null or v_ai_eng_id is null or v_sales_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active executive, head_of_technical, ai_engineer, and sales user, each with auth_id.';
  end if;

  select id, auth_id into v_am_agent_id, v_am_agent_auth
    from public.users where role = 'am_agent' and auth_id is not null and deactivated_at is null order by id limit 1;
  if v_am_agent_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active am_agent with auth_id.';
  end if;

  select id, auth_id into v_creator_id, v_creator_auth
    from public.users
    where auth_id is not null and deactivated_at is null
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'am_agent')
      and role not like '%team_lead'
    order by id limit 1;
  if v_creator_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active ordinary (non-admin, non-sales, non-am_agent, non-team-lead) employee with auth_id to act as task creator.';
  end if;

  select id, auth_id into v_outsider_id, v_outsider_auth
    from public.users
    where auth_id is not null and deactivated_at is null
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'am_agent')
      and role not like '%team_lead'
      and id <> v_creator_id
    order by id limit 1;
  if v_outsider_id is null then
    raise exception 'TEST_SETUP_FAILED: need a second, distinct active ordinary employee with auth_id to act as an unrelated outsider.';
  end if;

  select id, auth_id into v_marketing_mgr_id, v_marketing_mgr_auth
    from public.users where role = 'marketing_manager' and auth_id is not null and deactivated_at is null order by id limit 1;
  if v_marketing_mgr_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active marketing_manager with auth_id.';
  end if;

  select id, auth_id into v_creative_id, v_creative_auth
    from public.users where role in ('graphic_designer', 'video_editor') and auth_id is not null and deactivated_at is null
      and id not in (v_creator_id, v_outsider_id)
    order by id limit 1;
  if v_creative_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active graphic_designer or video_editor with auth_id.';
  end if;

  -- ======================================================================
  -- Fabricate a throwaway client (am_agent = v_am_agent) and a throwaway task on it, created by
  -- v_creator, with no assignees — the creator door and the am_agent-manages-this-client door are
  -- the two things under test, independent of task_assignees membership.
  -- ======================================================================
  v_client_id := 'zz_platform_client_' || substr(md5(random()::text), 1, 8);
  insert into public.clients (id, name, services, status, sales_owner_id, am_agent_id)
  values (v_client_id, 'ZZ Task Platforms Test Client', array['seo'], 'active', v_creator_id, v_am_agent_id);

  v_task_id := 'zz_platform_task_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ task platforms test', 'task platforms test', null, v_creator_id, 'Technical', 'todo', current_date, 'low');

  -- ======================================================================
  -- Scenario 1: platforms_select_rls — any non-sales authenticated user can see the seeded rows;
  -- sales sees none (the policy's qual is simply false for them, not merely "no matching rows").
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.platforms where id in ('instagram', 'tiktok', 'snapchat');
  if v_count <> 3 then
    raise exception 'TEST_FAILED: scenario 1 — a non-sales employee should see all 3 seeded platforms, saw %.', v_count;
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_auth)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.platforms;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 1b — sales must see zero rows in platforms, saw %.', v_count;
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 2: platforms_write_rls/platforms_update_rls — only executive/head_of_technical/
  -- ai_engineer may insert/update; an ordinary employee may not, even though they can read.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_ai_eng_auth)::text, true);
  set local role authenticated;
  insert into public.platforms (id, name, sort_order, active) values ('zz_test_platform', 'ZZ Test Platform', 99, true);
  update public.platforms set sort_order = 100 where id = 'zz_test_platform';
  reset role; perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from public.platforms where id = 'zz_test_platform' and sort_order = 100) then
    raise exception 'TEST_FAILED: scenario 2 — ai_engineer should be able to insert and update a platform.';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth)::text, true);
  set local role authenticated;
  begin
    insert into public.platforms (id, name, sort_order, active) values ('zz_test_platform_2', 'ZZ Test Platform 2', 98, true);
    raise exception 'TEST_FAILED: scenario 2b — an ordinary employee must NOT be able to insert a platform.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  begin
    update public.platforms set active = false where id = 'zz_test_platform';
    if exists (select 1 from public.platforms where id = 'zz_test_platform' and active = false) then
      raise exception 'TEST_FAILED: scenario 2c — an ordinary employee must NOT be able to update a platform.';
    end if;
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 3: task_platform_links has no INSERT/UPDATE/DELETE policy at all — not even for an
  -- admin. Every write must go through set_task_platforms(). Attempted as ai_engineer (otherwise
  -- eligible under every other door) so a failure can only be this table's own lockdown.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_ai_eng_auth)::text, true);
  set local role authenticated;
  begin
    insert into public.task_platform_links (task_id, platform_id) values (v_task_id, 'instagram');
    raise exception 'TEST_FAILED: scenario 3 — a direct INSERT into task_platform_links must be rejected for everyone, admins included.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 4: set_task_platforms — the task's creator may set its platforms.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth)::text, true);
  set local role authenticated;
  perform public.set_task_platforms(v_task_id, array['instagram', 'tiktok']);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_link_count from public.task_platform_links where task_id = v_task_id;
  if v_link_count <> 2 then
    raise exception 'TEST_FAILED: scenario 4 — creator-set platforms should leave exactly 2 links, found %.', v_link_count;
  end if;
  if not exists (select 1 from public.task_platform_links where task_id = v_task_id and platform_id = 'instagram')
     or not exists (select 1 from public.task_platform_links where task_id = v_task_id and platform_id = 'tiktok') then
    raise exception 'TEST_FAILED: scenario 4b — expected links to instagram and tiktok were not both found.';
  end if;

  -- ======================================================================
  -- Scenario 5: set_task_platforms replaces the FULL set, rather than unioning with the previous
  -- call — calling again with just snapchat should drop instagram/tiktok.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth)::text, true);
  set local role authenticated;
  perform public.set_task_platforms(v_task_id, array['snapchat']);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_link_count from public.task_platform_links where task_id = v_task_id;
  if v_link_count <> 1 then
    raise exception 'TEST_FAILED: scenario 5 — the second call should fully replace the set, leaving exactly 1 link, found %.', v_link_count;
  end if;
  if not exists (select 1 from public.task_platform_links where task_id = v_task_id and platform_id = 'snapchat') then
    raise exception 'TEST_FAILED: scenario 5b — expected the remaining link to be snapchat.';
  end if;

  -- ======================================================================
  -- Scenario 6: an am_agent who manages the task's client may set its platforms, independent of
  -- being its creator or an assignee.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth)::text, true);
  set local role authenticated;
  perform public.set_task_platforms(v_task_id, array['instagram']);
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_platform_links where task_id = v_task_id and platform_id = 'instagram')
     or exists (select 1 from public.task_platform_links where task_id = v_task_id and platform_id = 'snapchat') then
    raise exception 'TEST_FAILED: scenario 6 — the managing am_agent''s call should have replaced the set with just instagram.';
  end if;

  -- ======================================================================
  -- Scenario 7: an unrelated employee (no relation to this task or its client at all) may not set
  -- its platforms.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_platforms(v_task_id, array['tiktok']);
    raise exception 'TEST_FAILED: scenario 7 — an unrelated employee must NOT be able to set this task''s platforms.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 8: sales is excluded explicitly, even on a task they could otherwise touch (sales
  -- can never see or manage any task per task_visible_v2/task_closable, so this also proves the
  -- gate's own explicit `app_user_role() = 'sales'` exclusion fires rather than relying solely on
  -- task_closable's structural exclusion).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_platforms(v_task_id, array['tiktok']);
    raise exception 'TEST_FAILED: scenario 8 — sales must NEVER be able to set a task''s platforms.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 9: an unknown platform id is rejected, and leaves the existing set untouched.
  -- ======================================================================
  v_fake_platform_id := 'zz_nonexistent_' || substr(md5(random()::text), 1, 8);
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_platforms(v_task_id, array[v_fake_platform_id]);
    raise exception 'TEST_FAILED: scenario 9 — an unknown platform id must be rejected.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_platform_links where task_id = v_task_id and platform_id = 'instagram')
     or (select count(*) from public.task_platform_links where task_id = v_task_id) <> 1 then
    raise exception 'TEST_FAILED: scenario 9b — a rejected call must leave the existing platform set untouched.';
  end if;

  -- ======================================================================
  -- Scenario 10: an INACTIVE platform id is rejected (deactivated via the admin-only write path
  -- tested in scenario 2, so this also exercises active=false end to end).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_ai_eng_auth)::text, true);
  set local role authenticated;
  update public.platforms set active = false where id = 'zz_test_platform';
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_platforms(v_task_id, array['zz_test_platform']);
    raise exception 'TEST_FAILED: scenario 10 — an inactive platform id must be rejected.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 11: more than 10 platform ids is rejected.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_platforms(v_task_id, array[
      'instagram', 'tiktok', 'snapchat', 'zz_a', 'zz_b', 'zz_c', 'zz_d', 'zz_e', 'zz_f', 'zz_g', 'zz_h'
    ]);
    raise exception 'TEST_FAILED: scenario 11 — more than 10 platform ids must be rejected.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 12: task_platform_links_select_rls — gated by task_visible_v2, same as every other
  -- task-scoped table. The creator sees the link; the unrelated outsider sees nothing for this
  -- task even though the row exists.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth)::text, true);
  set local role authenticated;
  if not exists (select 1 from public.task_platform_links where task_id = v_task_id) then
    raise exception 'TEST_FAILED: scenario 12 — the task''s creator should see its platform link(s).';
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider_auth)::text, true);
  set local role authenticated;
  if exists (select 1 from public.task_platform_links where task_id = v_task_id) then
    raise exception 'TEST_FAILED: scenario 12b — an unrelated outsider must NOT see this task''s platform link(s).';
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 13: marketing_manager is rejected, even on a task task_visible_v2 itself makes
  -- visible to them (via the creative-role door: creator or any assignee holds role
  -- graphic_designer/video_editor). Being able to SEE a task is not the same permission as being
  -- able to manage its platforms — the same distinction set_task_assignees' own gate draws (see
  -- 20261105000000_task_assignees_rpcs.sql's header comment) and byte-identically inherits here.
  -- Assigns the creative employee directly (bypassing RLS, as the unprivileged superuser context)
  -- so the visibility door is real, not merely assumed.
  -- ======================================================================
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_id, v_creative_id, v_creator_id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_marketing_mgr_auth)::text, true);
  set local role authenticated;
  if not exists (select 1 from public.tasks where id = v_task_id and public.task_visible_v2(id)) then
    raise exception 'TEST_SETUP_FAILED: scenario 13 — marketing_manager should be able to SEE this task via the creative-role door; the setup assumption is wrong.';
  end if;
  begin
    perform public.set_task_platforms(v_task_id, array['tiktok']);
    raise exception 'TEST_FAILED: scenario 13 — marketing_manager must NOT be able to set this task''s platforms, even though they can see it.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  delete from public.task_assignees where task_id = v_task_id and user_id = v_creative_id;

  -- ======================================================================
  -- Scenario 14: a platform deactivated out from under an existing link is NOT cascade-removed
  -- from task_platform_links (only a future set_task_platforms call is affected) — "rejected on a
  -- new set, but kept on existing links".
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_ai_eng_auth)::text, true);
  set local role authenticated;
  insert into public.platforms (id, name, sort_order, active) values ('zz_test_platform_3', 'ZZ Test Platform 3', 97, true);
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth)::text, true);
  set local role authenticated;
  perform public.set_task_platforms(v_task_id, array['zz_test_platform_3']);
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_platform_links where task_id = v_task_id and platform_id = 'zz_test_platform_3') then
    raise exception 'TEST_FAILED: scenario 14 — expected a link to zz_test_platform_3 before deactivating it.';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_ai_eng_auth)::text, true);
  set local role authenticated;
  update public.platforms set active = false where id = 'zz_test_platform_3';
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_platform_links where task_id = v_task_id and platform_id = 'zz_test_platform_3') then
    raise exception 'TEST_FAILED: scenario 14b — deactivating a platform must NOT remove it from task_platform_links rows that already reference it.';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_platforms(v_task_id, array['zz_test_platform_3']);
    raise exception 'TEST_FAILED: scenario 14c — re-submitting a now-inactive platform id in a new set_task_platforms call must be rejected, even though it was already linked.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 15: the migration's own seed insert (on conflict (name) do nothing) is idempotent —
  -- running it again creates no duplicate rows. Run as the unprivileged superuser context, same
  -- as the migration itself runs.
  -- ======================================================================
  insert into public.platforms (id, name, sort_order, active)
  values
    ('instagram', 'Instagram', 0, true),
    ('tiktok', 'TikTok', 1, true),
    ('snapchat', 'Snapchat', 2, true)
  on conflict (name) do nothing;

  select count(*) into v_seed_count from public.platforms where name in ('Instagram', 'TikTok', 'Snapchat');
  if v_seed_count <> 3 then
    raise exception 'TEST_FAILED: scenario 15 — re-running the seed insert must leave exactly 3 rows (Instagram/TikTok/Snapchat), found %.', v_seed_count;
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all task platforms scenarios passed; rolling back every fabricated row.';
end $$;
