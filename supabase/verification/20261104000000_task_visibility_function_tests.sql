-- ============================================================================
-- FUNCTION TESTS — run AFTER 20261104000000_task_visibility_functions.sql, BEFORE
-- 20261104100000_task_visibility_cutover.sql. NOT a migration — lives outside
-- supabase/migrations/ so nothing ever applies it automatically.
--
-- Calls task_visible_v2()/task_closable() DIRECTLY as plain function calls (both are SECURITY
-- DEFINER, callable by any authenticated user regardless of which policies reference them yet —
-- so this works even though the old policies are still active at this point). Table-level
-- SELECT/INSERT/UPDATE under the REWRITTEN RLS is covered separately, after Migration B, by
-- 20261104100000_task_visibility_policy_tests.sql.
--
-- Fabricates ONLY tasks (and their task_assignees rows), a throwaway test department/custom role,
-- and temporarily repoints 2 real users' role/team at that test role (restored automatically by
-- the final rollback) — every OTHER persona below (team leads, admins, sales, am_agent,
-- marketing_manager, graphic_designer/video_editor, programming_agent) is a REAL existing active
-- employee, selected defensively: if a precondition isn't met by live data, this raises
-- TEST_SETUP_FAILED naming exactly what's missing, rather than silently skipping a check.
--
-- Nothing persists: the final `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit
-- transaction wrapping the whole block, rolling back every insert/update performed above it,
-- including the temporary am_agent/client pairing and the 2 users' role/team mutation.
-- ============================================================================
do $$
declare
  -- Admins
  v_exec_auth uuid; v_hot_auth uuid; v_ai_eng_auth uuid;
  -- Sales
  v_sales_auth uuid;
  -- SEO team
  v_seo_lead_id text; v_seo_lead_auth uuid; v_seo_lead_team text;
  v_seo_agent_a_id text; v_seo_agent_a_auth uuid;
  v_seo_agent_b_id text; v_seo_agent_b_auth uuid;
  -- A different team entirely, for "team lead sees own team only"
  v_other_agent_id text; v_other_agent_auth uuid; v_other_agent_team text;
  -- Programming (the seo_team_lead carve-out)
  v_programming_id text; v_programming_auth uuid;
  -- am_agent + a client to temporarily manage
  v_am_agent_id text; v_am_agent_auth uuid;
  v_test_client_id text; v_test_client_old_am_agent_id text;
  -- marketing_manager + a creative resource
  v_marketing_manager_auth uuid;
  v_creative_id text; v_creative_auth uuid;
  -- Custom role personas (role/team mutated on 2 real users, test department/role fabricated)
  v_custom_a_id text; v_custom_a_auth uuid; v_custom_a_old_role text; v_custom_a_old_team text;
  v_custom_b_id text; v_custom_b_auth uuid; v_custom_b_old_role text; v_custom_b_old_team text;

  v_task_id text;
  v_parent_id text;
  v_result boolean;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: select real personas (defensive — raise if a precondition is missing).
  -- ======================================================================
  select auth_id into v_exec_auth from public.users where role = 'executive' and auth_id is not null and deactivated_at is null limit 1;
  select auth_id into v_hot_auth from public.users where role = 'head_of_technical' and auth_id is not null and deactivated_at is null limit 1;
  select auth_id into v_ai_eng_auth from public.users where role = 'ai_engineer' and auth_id is not null and deactivated_at is null limit 1;
  if v_exec_auth is null or v_hot_auth is null or v_ai_eng_auth is null then
    raise exception 'TEST_SETUP_FAILED: need one active executive, head_of_technical, and ai_engineer, each with auth_id.';
  end if;

  select auth_id into v_sales_auth from public.users where role = 'sales' and auth_id is not null and deactivated_at is null limit 1;
  if v_sales_auth is null then
    raise exception 'TEST_SETUP_FAILED: need one active sales user with auth_id.';
  end if;

  select id, auth_id, team into v_seo_lead_id, v_seo_lead_auth, v_seo_lead_team
    from public.users where role = 'seo_team_lead' and auth_id is not null and deactivated_at is null limit 1;
  if v_seo_lead_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active seo_team_lead with auth_id.';
  end if;

  select id, auth_id into v_seo_agent_a_id, v_seo_agent_a_auth
    from public.users where role = 'seo_agent' and team = v_seo_lead_team and auth_id is not null and deactivated_at is null limit 1;
  if v_seo_agent_a_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active seo_agent on team %, with auth_id.', v_seo_lead_team;
  end if;

  select id, auth_id into v_seo_agent_b_id, v_seo_agent_b_auth
    from public.users
    where role = 'seo_agent' and team = v_seo_lead_team and auth_id is not null and deactivated_at is null and id <> v_seo_agent_a_id
    limit 1;
  if v_seo_agent_b_id is null then
    raise exception 'TEST_SETUP_FAILED: need 2 distinct active seo_agent users on team %, each with auth_id (for the "teammate cannot see it" check).', v_seo_lead_team;
  end if;

  select id, auth_id into v_programming_id, v_programming_auth
    from public.users where role = 'programming_agent' and auth_id is not null and deactivated_at is null limit 1;
  if v_programming_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active programming_agent with auth_id.';
  end if;

  select id, auth_id into v_am_agent_id, v_am_agent_auth
    from public.users where role = 'am_agent' and auth_id is not null and deactivated_at is null limit 1;
  if v_am_agent_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active am_agent with auth_id.';
  end if;

  -- Selected AFTER v_am_agent_id so it can be explicitly excluded. Also excludes
  -- marketing_manager/graphic_designer/video_editor: each of those holds an independent
  -- visibility door (client oversight, or creative-role oversight/being overseen) that could make
  -- a "must NOT see this" assertion pass or fail for the wrong reason if this persona happened to
  -- hold one of those roles by chance.
  select id, auth_id, team into v_other_agent_id, v_other_agent_auth, v_other_agent_team
    from public.users
    where auth_id is not null and deactivated_at is null and team is not null
      and team not in (v_seo_lead_team, 'Programming')
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'am_agent', 'marketing_manager', 'graphic_designer', 'video_editor')
      and role not like '%team_lead'
      and id <> v_am_agent_id
    limit 1;
  if v_other_agent_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active non-admin, non-team-lead, non-am_agent, non-marketing_manager, non-creative user on a team other than % or Programming, with auth_id.', v_seo_lead_team;
  end if;

  select id into v_test_client_id from public.clients limit 1;
  if v_test_client_id is null then
    raise exception 'TEST_SETUP_FAILED: need at least 1 client row.';
  end if;

  select auth_id into v_marketing_manager_auth from public.users where role = 'marketing_manager' and auth_id is not null and deactivated_at is null limit 1;
  if v_marketing_manager_auth is null then
    raise exception 'TEST_SETUP_FAILED: need one active marketing_manager with auth_id.';
  end if;

  select id, auth_id into v_creative_id, v_creative_auth
    from public.users where role in ('graphic_designer', 'video_editor') and auth_id is not null and deactivated_at is null limit 1;
  if v_creative_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active graphic_designer or video_editor with auth_id.';
  end if;

  select id, auth_id, role, team into v_custom_a_id, v_custom_a_auth, v_custom_a_old_role, v_custom_a_old_team
    from public.users
    where auth_id is not null and deactivated_at is null
      and id not in (v_seo_lead_id, v_seo_agent_a_id, v_seo_agent_b_id, v_other_agent_id, v_programming_id, v_am_agent_id, v_creative_id)
    order by id limit 1;
  select id, auth_id, role, team into v_custom_b_id, v_custom_b_auth, v_custom_b_old_role, v_custom_b_old_team
    from public.users
    where auth_id is not null and deactivated_at is null
      and id not in (v_seo_lead_id, v_seo_agent_a_id, v_seo_agent_b_id, v_other_agent_id, v_programming_id, v_am_agent_id, v_creative_id, v_custom_a_id)
    order by id limit 1;
  if v_custom_a_id is null or v_custom_b_id is null then
    raise exception 'TEST_SETUP_FAILED: need 2 more distinct active users with auth_id, beyond the personas already selected, to temporarily hold a test custom role.';
  end if;

  -- ======================================================================
  -- Fabricate a throwaway test department/custom role, never a real one, and repoint the 2
  -- custom-role personas' role/team at it. All rolled back at the end.
  -- ======================================================================
  insert into public.departments (id, label, is_shared_resource, is_active)
  values ('zz_test_dept', 'ZZ Test Department', false, true);
  insert into public.department_member_teams (department_id, team_value)
  values ('zz_test_dept', 'ZZ Test Team');
  insert into public.custom_roles (id, english_title, portal_title_en, portal_slug, team, department_id, is_active)
  values ('zz_test_role', 'ZZ Test Role', 'ZZ Test Role', 'zz-test-role', 'ZZ Test Team', 'zz_test_dept', true);

  update public.users set role = 'zz_test_role', team = 'ZZ Test Team' where id = v_custom_a_id;
  update public.users set role = 'zz_test_role', team = 'ZZ Test Team' where id = v_custom_b_id;

  -- Temporarily make v_am_agent the manager of v_test_client_id.
  select am_agent_id into v_test_client_old_am_agent_id from public.clients where id = v_test_client_id;
  update public.clients set am_agent_id = v_am_agent_id where id = v_test_client_id;

  -- ======================================================================
  -- Scenario 1: agent own task (creator == assignee).
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ scenario 1', 'own task', v_seo_agent_a_id, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_a_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 1 — agent should see their own task.'; end if;
  select public.task_closable(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 1 — creator+assignee should be able to close their own task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 2: agent's TEAMMATE must NOT see it (no team fallback for ordinary agents).
  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_b_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if v_result then raise exception 'TEST_FAILED: scenario 2 — a teammate (not creator/assignee) must NOT see this task.'; end if;
  select public.task_closable(v_task_id) into v_result;
  if v_result then raise exception 'TEST_FAILED: scenario 2 — a teammate must NOT be able to close this task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 3: team lead, OWN team — sees it via the creator's team.
  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_lead_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 3 — seo_team_lead should see a task on their own team.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 4: team lead, OTHER team — must NOT see a task entirely outside their team.
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ scenario 4', 'other team', v_other_agent_id, v_other_agent_id, v_other_agent_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_lead_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if v_result then raise exception 'TEST_FAILED: scenario 4 — seo_team_lead must NOT see a task on team % (not SEO, not Programming).', v_other_agent_team; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 5: seo_team_lead + programming_agent's task — the explicit carve-out.
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ scenario 5', 'programming', v_programming_id, v_programming_id, 'Programming', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_lead_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 5 — seo_team_lead should see a programming_agent''s task via the Programming carve-out.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 6: admins see everything — reuse scenario 4's task (otherwise invisible to seo_team_lead).
  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 6 — executive should see every task.'; end if;
  select public.task_closable(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 6 — executive should be able to close any task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_hot_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 6 — head_of_technical should see every task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_ai_eng_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 6 — ai_engineer should see every task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 7: sales sees NOTHING, unconditionally — probe the agent-own-task case too (scenario 1's style).
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ scenario 7', 'sales probe', v_seo_agent_a_id, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if v_result then raise exception 'TEST_FAILED: scenario 7 — sales must never see a task.'; end if;
  select public.task_closable(v_task_id) into v_result;
  if v_result then raise exception 'TEST_FAILED: scenario 7 — sales must never be able to close a task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 8: custom role, own task.
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ scenario 8', 'custom own', v_custom_a_id, v_custom_a_id, 'ZZ Test Team', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_custom_a_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 8 — a custom-role employee should see their own task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 8b: a same-department custom-role PEER must NOT see it (assignee-or-creator only, no
  -- department fallback for an ordinary custom role).
  perform set_config('request.jwt.claims', json_build_object('sub', v_custom_b_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if v_result then raise exception 'TEST_FAILED: scenario 8b — a same-department custom-role peer (not creator/assignee) must NOT see this task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 9: creator who is NOT an assignee.
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ scenario 9', 'creator not assignee', v_seo_agent_b_id, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_a_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 9 — the creator should see their task even when assigned to someone else.'; end if;
  select public.task_closable(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 9 — the creator should be able to close their task even when assigned to someone else.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 10: user removed from task_assignees loses visibility (bypassing the PR1 trigger
  -- directly, as admin, to isolate exactly this mechanic).
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ scenario 10', 'removed assignee', null, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_id, v_seo_agent_b_id, v_seo_agent_a_id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_b_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 10 — the assignee should see the task before being removed.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  delete from public.task_assignees where task_id = v_task_id and user_id = v_seo_agent_b_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_b_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if v_result then raise exception 'TEST_FAILED: scenario 10 — the removed assignee must no longer see the task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 11: task with ZERO assignees — visible to creator/admin/matching team lead, not to
  -- an uninvolved agent. (v_task_id from scenario 10 already has assigned_to = null and, after the
  -- delete above, zero task_assignees rows — reuse it directly.)
  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_a_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 11 — the creator should see a zero-assignee task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_lead_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 11 — a team lead whose team matches the creator should see a zero-assignee task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_other_agent_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if v_result then raise exception 'TEST_FAILED: scenario 11 — an uninvolved agent on an unrelated team must NOT see a zero-assignee task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 12: am_agent sees any task on a client they manage, independent of assignee/creator.
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ scenario 12', 'am oversight', v_seo_agent_a_id, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 12 — am_agent should see any task on a client they manage, regardless of assignee.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 13: marketing_manager sees a creative resource's task.
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ scenario 13', 'creative', v_creative_id, v_creative_id, 'Creative & Design', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_marketing_manager_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 13 — marketing_manager should see a graphic_designer/video_editor task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 14: subtask inherits parent visibility, even with no direct relation to the subtask.
  v_parent_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_parent_id, v_test_client_id, 'ZZ scenario 14 parent', 'parent', null, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');

  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority, parent_task_id)
  values (v_task_id, v_test_client_id, 'ZZ scenario 14 child', 'child', null, v_other_agent_id, v_other_agent_team, 'todo', current_date, 'low', v_parent_id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_a_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then raise exception 'TEST_FAILED: scenario 14 — the parent''s creator should see the child via parent-task inheritance, despite no direct relation to the child itself.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all task_visible_v2/task_closable function tests passed (14 scenarios, plus close-permission checks). Nothing persisted.';
end $$;
