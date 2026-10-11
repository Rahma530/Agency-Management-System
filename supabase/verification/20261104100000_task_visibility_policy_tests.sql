-- ============================================================================
-- POST-CUTOVER policy tests — run AFTER 20261104100000_task_visibility_cutover.sql (fixed
-- version, with the inline creator carve-out on tasks_select_rls/tasks_update_rls) is applied.
-- NOT a migration — lives outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Exercises the rewritten policies end-to-end via real SELECT/INSERT/UPDATE under RLS (not direct
-- function calls — that's 20261104000000_task_visibility_function_tests.sql). Same
-- persona-selection and rollback discipline as every other verification file in this project:
-- real existing users only, defensive TEST_SETUP_FAILED if a precondition is missing, nothing
-- persists (the final `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the whole transaction).
-- ============================================================================
do $$
declare
  v_exec_auth uuid; v_hot_auth uuid; v_ai_eng_auth uuid;
  v_sales_id text; v_sales_auth uuid;
  v_seo_lead_id text; v_seo_lead_auth uuid; v_seo_lead_team text;
  v_seo_agent_a_id text; v_seo_agent_a_auth uuid;
  v_seo_agent_b_id text; v_seo_agent_b_auth uuid;
  v_other_agent_id text; v_other_agent_auth uuid; v_other_agent_team text;
  v_marketing_manager_auth uuid;
  v_creative_id text; v_creative_auth uuid;
  v_test_client_id text;
  v_task_id text;
  v_parent_id text;
  v_count int;
  v_viewed_at timestamptz;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: real personas, defensive.
  -- ======================================================================
  select auth_id into v_exec_auth from public.users where role = 'executive' and auth_id is not null and deactivated_at is null limit 1;
  select auth_id into v_hot_auth from public.users where role = 'head_of_technical' and auth_id is not null and deactivated_at is null limit 1;
  select auth_id into v_ai_eng_auth from public.users where role = 'ai_engineer' and auth_id is not null and deactivated_at is null limit 1;
  if v_exec_auth is null or v_hot_auth is null or v_ai_eng_auth is null then
    raise exception 'TEST_SETUP_FAILED: need one active executive, head_of_technical, and ai_engineer, each with auth_id.';
  end if;

  select id, auth_id into v_sales_id, v_sales_auth from public.users where role = 'sales' and auth_id is not null and deactivated_at is null limit 1;
  if v_sales_auth is null then raise exception 'TEST_SETUP_FAILED: need one active sales user with auth_id.'; end if;

  select id, auth_id, team into v_seo_lead_id, v_seo_lead_auth, v_seo_lead_team
    from public.users where role = 'seo_team_lead' and auth_id is not null and deactivated_at is null limit 1;
  if v_seo_lead_id is null then raise exception 'TEST_SETUP_FAILED: need one active seo_team_lead with auth_id.'; end if;

  select id, auth_id into v_seo_agent_a_id, v_seo_agent_a_auth
    from public.users where role = 'seo_agent' and team = v_seo_lead_team and auth_id is not null and deactivated_at is null limit 1;
  if v_seo_agent_a_id is null then raise exception 'TEST_SETUP_FAILED: need one active seo_agent on team %.', v_seo_lead_team; end if;

  select id, auth_id into v_seo_agent_b_id, v_seo_agent_b_auth
    from public.users
    where role = 'seo_agent' and team = v_seo_lead_team and auth_id is not null and deactivated_at is null and id <> v_seo_agent_a_id
    limit 1;
  if v_seo_agent_b_id is null then raise exception 'TEST_SETUP_FAILED: need 2 distinct active seo_agent users on team %.', v_seo_lead_team; end if;

  -- Excludes am_agent/marketing_manager/graphic_designer/video_editor too: each of those holds an
  -- independent visibility door (client oversight, or creative-role oversight/being overseen) that
  -- could make a "must NOT see this" assertion pass or fail for the wrong reason if this persona
  -- happened to hold one of those roles by chance.
  select id, auth_id, team into v_other_agent_id, v_other_agent_auth, v_other_agent_team
    from public.users
    where auth_id is not null and deactivated_at is null and team is not null
      and team not in (v_seo_lead_team, 'Programming')
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'am_agent', 'marketing_manager', 'graphic_designer', 'video_editor')
      and role not like '%team_lead'
    limit 1;
  if v_other_agent_id is null then raise exception 'TEST_SETUP_FAILED: need one active non-admin, non-team-lead, non-am_agent, non-marketing_manager, non-creative user on a different team.'; end if;

  select auth_id into v_marketing_manager_auth from public.users where role = 'marketing_manager' and auth_id is not null and deactivated_at is null limit 1;
  if v_marketing_manager_auth is null then raise exception 'TEST_SETUP_FAILED: need one active marketing_manager with auth_id.'; end if;

  select id, auth_id into v_creative_id, v_creative_auth
    from public.users where role in ('graphic_designer', 'video_editor') and auth_id is not null and deactivated_at is null limit 1;
  if v_creative_id is null then raise exception 'TEST_SETUP_FAILED: need one active graphic_designer or video_editor with auth_id.'; end if;

  select id into v_test_client_id from public.clients limit 1;
  if v_test_client_id is null then raise exception 'TEST_SETUP_FAILED: need at least 1 client row.'; end if;

  -- ======================================================================
  -- 1. Creator inserts a task assigned to ANOTHER user and gets the row back via
  --    INSERT ... RETURNING (the exact scenario the inline creator carve-out exists for).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_a_auth)::text, true);
  set local role authenticated;

  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ policy 1', 'creator, assigned elsewhere', v_seo_agent_b_id, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low')
  returning id into v_task_id;
  if v_task_id is null then
    raise exception 'TEST_FAILED: policy 1 — INSERT ... RETURNING should return the new row to its creator even when assigned to someone else.';
  end if;

  -- A separate, later SELECT in the same persona must also see it (not just the RETURNING clause).
  select count(*) into v_count from public.tasks where id = v_task_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: policy 1 — the creator should also SELECT the task back afterward (got % rows).', v_count;
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- 2. Subtask insert under a VISIBLE parent succeeds; under an INVISIBLE parent is rejected.
  -- ======================================================================
  v_parent_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_parent_id, v_test_client_id, 'ZZ policy 2 parent (visible)', 'parent', null, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_lead_auth)::text, true);
  set local role authenticated;

  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  begin
    insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority, parent_task_id)
    values (v_task_id, v_test_client_id, 'ZZ policy 2 subtask (ok)', 'subtask', null, v_seo_lead_id, v_seo_lead_team, 'todo', current_date, 'low', v_parent_id);
  exception when others then
    raise exception 'TEST_FAILED: policy 2 — inserting a subtask under a VISIBLE parent should succeed; got: %', sqlerrm;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- An invisible parent: owned by, and only visible to, v_other_agent (a different team, not an
  -- admin/team-lead/am_agent/marketing_manager relation to v_seo_agent_b at all).
  v_parent_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_parent_id, v_test_client_id, 'ZZ policy 2 parent (invisible)', 'parent', null, v_other_agent_id, v_other_agent_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_b_auth)::text, true);
  set local role authenticated;

  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  begin
    insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority, parent_task_id)
    values (v_task_id, v_test_client_id, 'ZZ policy 2 subtask (rejected)', 'subtask', null, v_seo_agent_b_id, v_seo_lead_team, 'todo', current_date, 'low', v_parent_id);
    raise exception 'TEST_FAILED: policy 2 — inserting a subtask under an INVISIBLE parent should be rejected, but it succeeded.';
  exception when insufficient_privilege then
    null; -- expected: RLS rejects the WITH CHECK
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- 3. Assignee updates assignee_viewed_at on their own task.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ policy 3', 'viewed_at', v_seo_agent_b_id, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_b_auth)::text, true);
  set local role authenticated;
  update public.tasks set assignee_viewed_at = now() where id = v_task_id;
  if not found then
    raise exception 'TEST_FAILED: policy 3 — the assignee should be able to update assignee_viewed_at on their own task.';
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  select assignee_viewed_at into v_viewed_at from public.tasks where id = v_task_id;
  if v_viewed_at is null then
    raise exception 'TEST_FAILED: policy 3 — assignee_viewed_at did not persist.';
  end if;

  -- ======================================================================
  -- 4. An agent cannot read a TEAMMATE's task (same team, not creator, not assignee).
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ policy 4', 'teammate', v_seo_agent_a_id, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_b_auth)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.tasks where id = v_task_id;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: policy 4 — a teammate (not creator/assignee) must NOT SELECT this task (got % rows).', v_count;
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- 5. Zero-assignee task: visible to creator, the creator's team lead, and admins — NOT to an
  --    uninvolved agent.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ policy 5', 'zero assignees', null, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_a_auth)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.tasks where id = v_task_id;
  if v_count <> 1 then raise exception 'TEST_FAILED: policy 5 — the creator should SELECT a zero-assignee task (got % rows).', v_count; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_lead_auth)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.tasks where id = v_task_id;
  if v_count <> 1 then raise exception 'TEST_FAILED: policy 5 — the creator''s team lead should SELECT a zero-assignee task (got % rows).', v_count; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.tasks where id = v_task_id;
  if v_count <> 1 then raise exception 'TEST_FAILED: policy 5 — an admin should SELECT a zero-assignee task (got % rows).', v_count; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_other_agent_auth)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.tasks where id = v_task_id;
  if v_count <> 0 then raise exception 'TEST_FAILED: policy 5 — an uninvolved agent on another team must NOT SELECT a zero-assignee task (got % rows).', v_count; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- 6. marketing_manager sees a task assigned to a graphic_designer/video_editor.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ policy 6', 'creative', v_creative_id, v_creative_id, 'Creative & Design', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_marketing_manager_auth)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.tasks where id = v_task_id;
  if v_count <> 1 then raise exception 'TEST_FAILED: policy 6 — marketing_manager should SELECT a graphic_designer/video_editor task (got % rows).', v_count; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- 7. Team lead of ANOTHER team cannot see it.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ policy 7', 'other team', v_other_agent_id, v_other_agent_id, v_other_agent_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_lead_auth)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.tasks where id = v_task_id;
  if v_count <> 0 then raise exception 'TEST_FAILED: policy 7 — seo_team_lead must NOT SELECT a task on team % (got % rows).', v_other_agent_team, v_count; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- 8. Sales sees nothing, and cannot INSERT a task at all.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_auth)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.tasks;
  if v_count <> 0 then raise exception 'TEST_FAILED: policy 8 — sales should SELECT zero tasks, ever (got % rows).', v_count; end if;

  begin
    insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
    values ('zz_verify_sales_insert', v_test_client_id, 'ZZ policy 8', 'sales cannot insert', v_sales_id, 'Sales', 'todo', current_date, 'low');
    raise exception 'TEST_FAILED: policy 8 — sales should not be able to INSERT a task at all, but it succeeded.';
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- 9. Assignee can close; a team lead who is neither creator nor assignee cannot.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ policy 9', 'closing', v_seo_agent_b_id, v_seo_agent_a_id, v_seo_lead_team, 'completed', current_date, 'low');
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_id, v_seo_agent_b_id, v_seo_agent_a_id)
    on conflict (task_id, user_id) do nothing;

  -- The team lead CAN see this row (it's on their own team via task_visible_v2's team-lead door),
  -- so the UPDATE's USING clause passes and the row is targeted — it's the WITH CHECK's closing
  -- gate that then rejects it, which Postgres raises as 42501 (insufficient_privilege), NOT a
  -- silent zero-row update. Only a row excluded by USING ever fails silently.
  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_lead_auth)::text, true);
  set local role authenticated;
  begin
    update public.tasks set status = 'closed' where id = v_task_id;
    if found then
      raise exception 'TEST_FAILED: policy 9 — a team lead who is neither creator nor assignee must NOT be able to close this task (the update unexpectedly succeeded).';
    end if;
  exception when insufficient_privilege then
    null; -- expected: WITH CHECK rejects it
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_b_auth)::text, true);
  set local role authenticated;
  update public.tasks set status = 'closed' where id = v_task_id;
  if not found then raise exception 'TEST_FAILED: policy 9 — the assignee should be able to close this task.'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- 10. Creator (not assignee) can upload to the storage path of their own task.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_test_client_id, 'ZZ policy 10', 'storage upload', v_seo_agent_b_id, v_seo_agent_a_id, v_seo_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_agent_a_auth)::text, true);
  set local role authenticated;
  begin
    insert into storage.objects (bucket_id, name) values ('task-attachments', v_task_id || '/zz-test-file.txt');
  exception when others then
    raise exception 'TEST_FAILED: policy 10 — the creator (not the assignee) should be able to upload to their own task''s storage path; got: %', sqlerrm;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all post-cutover policy tests passed (10 scenarios: insert+returning for creator, subtask under visible/invisible parent, assignee viewed_at update, teammate exclusion, zero-assignee visibility, marketing_manager, other-team lead exclusion, sales exclusion, close permission, storage upload). Nothing persisted.';
end $$;
