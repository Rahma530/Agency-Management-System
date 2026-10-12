-- ============================================================================
-- FUNCTION TESTS for 20261105000000_task_assignees_rpcs.sql (review round 1). NOT a migration —
-- lives outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. Every scenario below fabricates only
-- throwaway tasks/task_assignees/task_attachments/storage.objects/notifications rows and, in one
-- place, temporarily deactivates one real employee; every OTHER persona is a REAL existing active
-- employee, selected defensively (TEST_SETUP_FAILED, naming exactly what's missing, rather than
-- silently skipping a check) and kept mutually exclusive by explicit id exclusions. The final
-- `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit transaction wrapping this
-- whole DO block, rolling back every single write performed above it — nothing persists either
-- way, pass or fail.
--
-- "Expect this call to fail" scenarios wrap the call in its own nested BEGIN/EXCEPTION block (a
-- real exception creates an implicit savepoint in plpgsql, so a caught failure doesn't abort the
-- rest of the test). If the call unexpectedly SUCCEEDS, it raises its own 'TEST_FAILED: ...' from
-- inside the try block, which the handler re-raises instead of swallowing — the `sqlerrm like
-- 'TEST_FAILED%'` check tells "the guard correctly raised" apart from "my own alarm fired".
-- ============================================================================
do $$
declare
  v_exec_id text; v_exec_auth uuid;
  v_hot_id text; v_hot_auth uuid;
  v_ai_eng_id text; v_ai_eng_auth uuid;
  v_sales_id text; v_sales_auth uuid;
  v_am_agent_id text; v_am_agent_auth uuid;
  v_agent_a_id text; v_agent_a_auth uuid;
  v_agent_b_id text; v_agent_b_auth uuid;
  v_agent_c_id text; v_agent_c_auth uuid;
  v_agent_d_id text; v_agent_d_auth uuid;
  v_am_lead_id text; v_am_lead_auth uuid; v_am_lead_team text;
  v_mb_lead_id text; v_mb_lead_auth uuid; v_mb_lead_team text;
  v_marketing_mgr_id text; v_marketing_mgr_auth uuid;
  v_creative_id text; v_creative_auth uuid;

  v_client_id text;
  v_invisible_client_id text;
  v_client_scratch_am_agent_id text;
  v_agent_a_original_team text;
  v_am_agent_old_team text;
  v_scratch_old_team text;
  v_creative_old_team text;
  v_result boolean;
  v_capacity_before integer;
  v_capacity_after integer;

  v_task_id text;
  v_task2_id text;
  v_task3_id text;
  v_assigned_to text;
  v_log_count integer;
  v_mark_time timestamptz;
  v_old_deactivated_at timestamptz;
  v_snapshot_used integer;
  v_expected_used integer;
  v_storage_path text;
  v_storage_path2 text;
  v_copy1_id text;
  v_copy2_id text;
  v_att_count integer;
  v_object_count integer;
  v_scratch_status text;
  v_att1_id text;
  v_att2_id text;
  v_returned_path text;
  v_batch_id text;
  v_copy_x_id text;
  v_copy_x_id_retry text;
  v_zero_task_id text;
  v_sentinel_viewed_at timestamptz := '2020-01-01T00:00:00Z';
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: select real personas defensively.
  -- ======================================================================
  select id, auth_id into v_exec_id, v_exec_auth from public.users where role = 'executive' and auth_id is not null and deactivated_at is null limit 1;
  select id, auth_id into v_hot_id, v_hot_auth from public.users where role = 'head_of_technical' and auth_id is not null and deactivated_at is null limit 1;
  select id, auth_id into v_ai_eng_id, v_ai_eng_auth from public.users where role = 'ai_engineer' and auth_id is not null and deactivated_at is null limit 1;
  select id, auth_id into v_sales_id, v_sales_auth from public.users where role = 'sales' and auth_id is not null and deactivated_at is null limit 1;
  if v_exec_id is null or v_hot_id is null or v_ai_eng_id is null or v_sales_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active executive, head_of_technical, ai_engineer, and sales user, each with auth_id.';
  end if;

  select id, auth_id into v_am_agent_id, v_am_agent_auth from public.users where role = 'am_agent' and auth_id is not null and deactivated_at is null limit 1;
  if v_am_agent_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active am_agent with auth_id.';
  end if;

  select id, auth_id into v_agent_a_id, v_agent_a_auth
    from public.users where role = 'programming_agent' and auth_id is not null and deactivated_at is null limit 1;
  if v_agent_a_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active programming_agent with auth_id.';
  end if;

  select id, auth_id into v_agent_b_id, v_agent_b_auth
    from public.users
    where auth_id is not null and deactivated_at is null
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'am_agent')
      and role not like '%team_lead'
      and id <> v_agent_a_id
    order by id limit 1;
  select id, auth_id into v_agent_c_id, v_agent_c_auth
    from public.users
    where auth_id is not null and deactivated_at is null
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'am_agent')
      and role not like '%team_lead'
      and id not in (v_agent_a_id, v_agent_b_id)
    order by id limit 1;
  select id, auth_id into v_agent_d_id, v_agent_d_auth
    from public.users
    where auth_id is not null and deactivated_at is null
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'am_agent')
      and role not like '%team_lead'
      and id not in (v_agent_a_id, v_agent_b_id, v_agent_c_id)
    order by id limit 1;
  if v_agent_b_id is null or v_agent_c_id is null or v_agent_d_id is null then
    raise exception 'TEST_SETUP_FAILED: need 3 more distinct active ordinary (non-admin, non-sales, non-am_agent, non-team-lead) employees with auth_id.';
  end if;

  select id, auth_id, team into v_am_lead_id, v_am_lead_auth, v_am_lead_team
    from public.users where role = 'am_team_lead' and auth_id is not null and deactivated_at is null limit 1;
  if v_am_lead_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active am_team_lead with auth_id.';
  end if;

  select id, auth_id, team into v_mb_lead_id, v_mb_lead_auth, v_mb_lead_team
    from public.users where role = 'media_buying_team_lead' and auth_id is not null and deactivated_at is null limit 1;
  if v_mb_lead_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active media_buying_team_lead with auth_id.';
  end if;

  select id, auth_id into v_marketing_mgr_id, v_marketing_mgr_auth
    from public.users where role = 'marketing_manager' and auth_id is not null and deactivated_at is null limit 1;
  if v_marketing_mgr_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active marketing_manager with auth_id.';
  end if;

  select id, auth_id into v_creative_id, v_creative_auth
    from public.users where role in ('graphic_designer', 'video_editor') and auth_id is not null and deactivated_at is null limit 1;
  if v_creative_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active graphic_designer or video_editor with auth_id.';
  end if;

  select team into v_agent_a_original_team from public.users where id = v_agent_a_id;
  if v_agent_a_original_team = v_am_lead_team or v_agent_a_original_team = v_mb_lead_team then
    raise exception 'TEST_SETUP_FAILED: need the chosen programming_agent''s team to differ from BOTH the am_team_lead''s and media_buying_team_lead''s team, to isolate the team-rule gate scenarios.';
  end if;
  if v_am_lead_team = v_mb_lead_team then
    raise exception 'TEST_SETUP_FAILED: need the am_team_lead''s and media_buying_team_lead''s teams to differ from each other.';
  end if;

  select id into v_client_id from public.clients limit 1;
  if v_client_id is null then
    raise exception 'TEST_SETUP_FAILED: need at least 1 client row.';
  end if;

  -- A client with no task_assignees-based relationship to v_agent_a — invisible to them under
  -- clients_select_rls's "else" branch (programming_agent has no other door onto clients at all).
  select c.id into v_invisible_client_id
  from public.clients c
  where not exists (
    select 1 from public.tasks t
    join public.task_assignees ta on ta.task_id = t.id
    where t.client_id = c.id and ta.user_id = v_agent_a_id
  )
  limit 1;
  if v_invisible_client_id is null then
    raise exception 'TEST_SETUP_FAILED: need at least 1 client with no task_assignees-based link to the chosen programming_agent.';
  end if;

  -- ======================================================================
  -- Scenario 1-3: escalation guard, ordinary creator.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 1-3', 'escalation guard', null, v_agent_a_id, 'Technical', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_assignees(v_task_id, array[v_exec_id]);
    raise exception 'TEST_FAILED: scenario 1 — ordinary creator must NOT be able to assign executive.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  begin
    perform public.set_task_assignees(v_task_id, array[v_hot_id]);
    raise exception 'TEST_FAILED: scenario 2 — ordinary creator must NOT be able to assign head_of_technical.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  begin
    perform public.set_task_assignees(v_task_id, array[v_sales_id]);
    raise exception 'TEST_FAILED: scenario 3 — sales must NEVER be assignable, even attempted by an ordinary creator.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  -- Scenario 3b: ai_engineer is unrestricted — this one must SUCCEED.
  perform public.set_task_assignees(v_task_id, array[v_ai_eng_id]);
  select assigned_to into v_assigned_to from public.tasks where id = v_task_id;
  if v_assigned_to <> v_ai_eng_id then
    raise exception 'TEST_FAILED: scenario 3b — ai_engineer should be assignable by an ordinary creator, and become assigned_to.';
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 4-5: escalation guard, executive creator.
  -- ======================================================================
  v_task2_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task2_id, v_client_id, 'ZZ scenario 4-5', 'executive guard', null, v_exec_id, 'Technical', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth)::text, true);
  set local role authenticated;
  -- Scenario 4: executive naming head_of_technical must SUCCEED.
  perform public.set_task_assignees(v_task2_id, array[v_hot_id]);
  if not exists (select 1 from public.task_assignees where task_id = v_task2_id and user_id = v_hot_id) then
    raise exception 'TEST_FAILED: scenario 4 — executive should be able to assign head_of_technical.';
  end if;
  -- Scenario 5: sales is unassignable even by executive.
  begin
    perform public.set_task_assignees(v_task2_id, array[v_hot_id, v_sales_id]);
    raise exception 'TEST_FAILED: scenario 5 — sales must NEVER be assignable, even attempted by executive.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 6: order -> assigned_to. Brand-new multi-assignee add on a zero-assignee task — the
  -- FIRST listed becomes the oldest (tasks.assigned_to), via the reverse-sync trigger.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 6', 'order', null, v_agent_a_id, 'Technical', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task_id, array[v_agent_b_id, v_agent_c_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  select assigned_to into v_assigned_to from public.tasks where id = v_task_id;
  if v_assigned_to <> v_agent_b_id then
    raise exception 'TEST_FAILED: scenario 6 — the first-listed new assignee (%) should become tasks.assigned_to, got %.', v_agent_b_id, v_assigned_to;
  end if;

  select count(*) into v_log_count from public.task_assignee_log where task_id = v_task_id;
  if v_log_count <> 2 then
    raise exception 'TEST_FAILED: scenario 6 — expected exactly 2 task_assignee_log rows (one ''added'' per new assignee, no cascade duplicates from the forward trigger), found %.', v_log_count;
  end if;

  -- ======================================================================
  -- Scenario 7: no-op. Re-sending the identical set, reordered, changes nothing — no new log rows,
  -- assigned_to unchanged.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task_id, array[v_agent_c_id, v_agent_b_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_log_count from public.task_assignee_log where task_id = v_task_id;
  if v_log_count <> 2 then
    raise exception 'TEST_FAILED: scenario 7 — re-sending the same assignee set (reordered) must be a true no-op: log row count should stay 2, found %.', v_log_count;
  end if;
  select assigned_to into v_assigned_to from public.tasks where id = v_task_id;
  if v_assigned_to <> v_agent_b_id then
    raise exception 'TEST_FAILED: scenario 7 — a no-op diff must not change tasks.assigned_to.';
  end if;

  -- ======================================================================
  -- Scenario 8: removal — row deleted, 'removed' log row logged with the real actor, NO
  -- notification sent to the removed person. Scenario 8b: assigning yourself does not notify you.
  -- ======================================================================
  v_mark_time := clock_timestamp();
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task_id, array[v_agent_b_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_agent_c_id) then
    raise exception 'TEST_FAILED: scenario 8 — removed assignee''s task_assignees row should be gone.';
  end if;
  if not exists (
    select 1 from public.task_assignee_log
    where task_id = v_task_id and user_id = v_agent_c_id and action = 'removed' and actor_id = v_agent_a_id
  ) then
    raise exception 'TEST_FAILED: scenario 8 — expected a ''removed'' log row for the removed assignee, attributed to the real actor.';
  end if;
  if exists (select 1 from public.notifications where user_id = v_agent_c_id and created_at >= v_mark_time) then
    raise exception 'TEST_FAILED: scenario 8 — a removed assignee must NOT receive a notification.';
  end if;

  select count(*) into v_log_count from public.task_assignee_log where task_id = v_task_id;
  if v_log_count <> 3 then
    raise exception 'TEST_FAILED: recursion guard — expected exactly 3 task_assignee_log rows for this task (2 added + 1 removed, no cascade duplicates), found %.', v_log_count;
  end if;
  select assigned_to into v_assigned_to from public.tasks where id = v_task_id;
  if v_assigned_to <> v_agent_b_id then
    raise exception 'TEST_FAILED: recursion guard — assigned_to should still be % after removing the other assignee, got %.', v_agent_b_id, v_assigned_to;
  end if;

  -- Scenario 8b: v_agent_a (creator, already an implicit non-assignee actor here) assigns
  -- THEMSELVES to a fresh task — must succeed with no notification sent to themselves.
  v_task3_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task3_id, v_client_id, 'ZZ scenario 8b', 'self-assign', null, v_agent_a_id, 'Technical', 'todo', current_date, 'low');

  v_mark_time := clock_timestamp();
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task3_id, array[v_agent_a_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if exists (select 1 from public.notifications where user_id = v_agent_a_id and created_at >= v_mark_time) then
    raise exception 'TEST_FAILED: scenario 8b — assigning yourself must NOT generate a notification to yourself.';
  end if;

  -- ======================================================================
  -- Scenario 9: validity guard is active-only-for-NEW ids. Deactivate v_agent_c (temporarily —
  -- rolled back with everything else), then: (a) adding them fresh to a task is blocked;
  -- (b) a list that still includes them (unchanged) plus a genuinely new, active addition
  -- succeeds.
  -- ======================================================================
  select deactivated_at into v_old_deactivated_at from public.users where id = v_agent_c_id;
  update public.users set deactivated_at = now() where id = v_agent_c_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_assignees(v_task_id, array[v_agent_b_id, v_agent_c_id]);
    raise exception 'TEST_FAILED: scenario 9a — adding a deactivated user as a NEW assignee must be rejected.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;

  reset role; perform set_config('request.jwt.claims', '', true);
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task2_id, v_agent_c_id, v_exec_id);
  update public.users set deactivated_at = now() where id = v_agent_c_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task2_id, array[v_hot_id, v_agent_c_id, v_ai_eng_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_assignees where task_id = v_task2_id and user_id = v_agent_c_id) then
    raise exception 'TEST_FAILED: scenario 9b — a list that still includes a now-deactivated, pre-existing assignee must keep them, not reject the whole call.';
  end if;
  if not exists (select 1 from public.task_assignees where task_id = v_task2_id and user_id = v_ai_eng_id) then
    raise exception 'TEST_FAILED: scenario 9b — a genuinely new, active addition in the same call must still succeed.';
  end if;

  update public.users set deactivated_at = v_old_deactivated_at where id = v_agent_c_id;

  -- ======================================================================
  -- Scenario 10: the task's creator can never be removed from its own assignee list.
  -- ======================================================================
  v_task3_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task3_id, v_client_id, 'ZZ scenario 10', 'creator never removed', v_agent_a_id, v_agent_a_id, 'Technical', 'todo', current_date, 'low');
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task3_id, v_agent_b_id, v_agent_a_id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  begin
    -- Dropping the creator (v_agent_a) from the list, keeping only v_agent_b, must be rejected —
    -- even though v_agent_a is the one calling.
    perform public.set_task_assignees(v_task3_id, array[v_agent_b_id]);
    raise exception 'TEST_FAILED: scenario 10 — the task''s creator must never be removable from its own assignee list.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from public.task_assignees where task_id = v_task3_id and user_id = v_agent_a_id) then
    raise exception 'TEST_FAILED: scenario 10 — the creator''s task_assignees row must still be there after the rejected call.';
  end if;

  -- ======================================================================
  -- Scenario 11: validity/escalation checks run ONLY on ids newly entering the list. v_task2_id
  -- already has head_of_technical (v_hot_id) as an assignee (from scenario 4) and v_agent_d is NOT
  -- yet on it — add v_agent_d as a plain assignee directly (admin) so they can act as a legitimate,
  -- NON-executive editor via task_visible_v2's assignee door, then have THEM resave the list,
  -- keeping v_hot_id untouched and adding a new ordinary assignee. Under the bug this fixes, this
  -- call would have been rejected (a non-executive actor "naming" an already-present
  -- head_of_technical by merely including them in the resubmitted list).
  -- ======================================================================
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task2_id, v_agent_d_id, v_exec_id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_d_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task2_id, array[v_hot_id, v_agent_c_id, v_ai_eng_id, v_agent_d_id, v_agent_b_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_assignees where task_id = v_task2_id and user_id = v_hot_id) then
    raise exception 'TEST_FAILED: scenario 11 — head_of_technical should still be on the task (untouched, not re-validated).';
  end if;
  if not exists (select 1 from public.task_assignees where task_id = v_task2_id and user_id = v_agent_b_id) then
    raise exception 'TEST_FAILED: scenario 11 — a non-executive editor should be able to add a brand-new ordinary assignee in the same call that leaves an existing head_of_technical assignee untouched.';
  end if;

  -- ======================================================================
  -- Scenario 12: create_task_copy — ordinary caller, ordered assignees, atomic.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  select (public.create_task_copy(
    v_client_id, 'ZZ scenario 12', 'copy test', 'Technical', current_date, 'low',
    null, null, null, null, null, array[v_agent_b_id, v_agent_c_id]
  )).id into v_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select status, assigned_to into v_scratch_status, v_assigned_to from public.tasks where id = v_task_id;
  if v_scratch_status <> 'todo' then
    raise exception 'TEST_FAILED: scenario 12 — create_task_copy must set status to ''todo'', got %.', v_scratch_status;
  end if;
  if v_assigned_to <> v_agent_b_id then
    raise exception 'TEST_FAILED: scenario 12 — the first-listed assignee should end up as assigned_to, got %.', v_assigned_to;
  end if;
  select count(*) into v_att_count from public.task_assignees where task_id = v_task_id;
  if v_att_count <> 2 then
    raise exception 'TEST_FAILED: scenario 12 — expected exactly 2 task_assignees rows, found %.', v_att_count;
  end if;

  -- Scenario 12b: sales cannot create a task copy at all (tasks_insert_rls itself blocks it).
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_auth)::text, true);
  set local role authenticated;
  begin
    perform public.create_task_copy(v_client_id, 'ZZ scenario 12b', 'sales blocked', 'Technical', current_date, 'low');
    raise exception 'TEST_FAILED: scenario 12b — sales must not be able to create a task via create_task_copy.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Scenario 12c: a real client the caller cannot see under clients_select_rls is rejected, not
  -- silently inserted via the FK's existence-only check.
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  begin
    perform public.create_task_copy(v_invisible_client_id, 'ZZ scenario 12c', 'invisible client', 'Technical', current_date, 'low');
    raise exception 'TEST_FAILED: scenario 12c — create_task_copy must reject a client not visible to the caller under RLS.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 13: (batch_id, client_id) partial unique index + create_task_copy idempotency.
  -- ======================================================================
  v_batch_id := 'zz_verify_batch_' || substr(md5(random()::text), 1, 8);

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  select (public.create_task_copy(v_client_id, 'ZZ scenario 13a', 'batch original', 'Technical', current_date, 'low', null, null, null, null, v_batch_id)).id into v_copy_x_id;
  -- Same caller, same (batch_id, client_id), different title/description — must return the SAME
  -- existing row, not raise, and not create a second one.
  select (public.create_task_copy(v_client_id, 'ZZ scenario 13b RETRY', 'batch retry', 'Technical', current_date, 'low', null, null, null, null, v_batch_id)).id into v_copy_x_id_retry;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_copy_x_id_retry <> v_copy_x_id then
    raise exception 'TEST_FAILED: scenario 13 — a retried create_task_copy for the same (batch_id, client_id) must return the EXISTING row''s id, got a different one.';
  end if;
  select count(*) into v_att_count from public.tasks where batch_id = v_batch_id and client_id = v_client_id;
  if v_att_count <> 1 then
    raise exception 'TEST_FAILED: scenario 13 — expected exactly 1 task row for this (batch_id, client_id) pair after the retry, found %.', v_att_count;
  end if;
  if exists (select 1 from public.tasks where id = v_copy_x_id and title = 'ZZ scenario 13b RETRY') then
    raise exception 'TEST_FAILED: scenario 13 — the retried call must not have modified the existing row''s fields.';
  end if;

  -- Scenario 13c: the SAME (batch_id, client_id) pair, but the existing row is invisible to a
  -- different, uninvolved caller (not its creator, not an assignee, not admin) — must raise, not
  -- silently return a row that caller cannot actually see.
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_c_auth)::text, true);
  set local role authenticated;
  begin
    perform public.create_task_copy(v_client_id, 'ZZ scenario 13c', 'invisible retry', 'Technical', current_date, 'low', null, null, null, null, v_batch_id);
    raise exception 'TEST_FAILED: scenario 13c — a conflicting (batch_id, client_id) retry must raise when the existing row is not visible to the caller.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 14: mark_task_viewed — first-view-wins.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 14', 'viewed', v_agent_b_id, v_agent_a_id, 'Technical', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_b_auth)::text, true);
  set local role authenticated;
  perform public.mark_task_viewed(v_task_id);
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_agent_b_id and viewed_at is not null) then
    raise exception 'TEST_FAILED: scenario 14 — mark_task_viewed should set the caller''s own task_assignees.viewed_at.';
  end if;
  if not exists (select 1 from public.tasks where id = v_task_id and assignee_viewed_at is not null) then
    raise exception 'TEST_FAILED: scenario 14 — mark_task_viewed should mirror tasks.assignee_viewed_at for the legacy assigned_to.';
  end if;

  -- Overwrite both with a distinctive sentinel timestamp, then call mark_task_viewed AGAIN —
  -- first-view-wins means neither should move off the sentinel.
  update public.task_assignees set viewed_at = v_sentinel_viewed_at where task_id = v_task_id and user_id = v_agent_b_id;
  update public.tasks set assignee_viewed_at = v_sentinel_viewed_at where id = v_task_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_b_auth)::text, true);
  set local role authenticated;
  perform public.mark_task_viewed(v_task_id);
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_agent_b_id and viewed_at = v_sentinel_viewed_at) then
    raise exception 'TEST_FAILED: scenario 14b — a second mark_task_viewed call must NOT overwrite an already-set viewed_at (first-view-wins).';
  end if;
  if not exists (select 1 from public.tasks where id = v_task_id and assignee_viewed_at = v_sentinel_viewed_at) then
    raise exception 'TEST_FAILED: scenario 14b — a second mark_task_viewed call must NOT overwrite an already-set assignee_viewed_at (first-view-wins).';
  end if;

  -- ======================================================================
  -- Scenario 15: get_capacity_snapshot.
  --   15a: am_agent branch — matches capacity.ts's own am_agent_id-based count exactly.
  --   15b: ordinary branch — now by task_assignees MEMBERSHIP: a 2-assignee task counts fully for
  --        BOTH assignees, and a zero-assignee task counts for neither.
  --   15c: sales caller rejected.
  -- ======================================================================
  select count(*) into v_expected_used
  from public.clients c
  where c.am_agent_id = v_am_agent_id and c.status <> 'closed' and c.status <> 'paused';

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  select used_capacity into v_snapshot_used from public.get_capacity_snapshot(array[v_am_agent_id]) where user_id = v_am_agent_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_snapshot_used is distinct from v_expected_used then
    raise exception 'TEST_FAILED: scenario 15a — get_capacity_snapshot returned % active clients for an am_agent, expected %.', v_snapshot_used, v_expected_used;
  end if;

  -- A fresh 2-assignee task (v_agent_c, v_agent_d) plus a zero-assignee task, to isolate the
  -- membership-counting rule from whatever pre-existing tasks these personas already carry from
  -- earlier scenarios.
  v_task3_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task3_id, v_client_id, 'ZZ scenario 15b', 'membership capacity', null, v_agent_a_id, 'Technical', 'todo', current_date, 'low');
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task3_id, v_agent_c_id, v_agent_a_id);
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task3_id, v_agent_d_id, v_agent_a_id);
  -- Zero-assignee task — must count for nobody, in particular not for its own creator. Captured
  -- before/after the creator's OWN get_capacity_snapshot to prove creating it adds exactly 0.
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  select used_capacity into v_capacity_before from public.get_capacity_snapshot(array[v_agent_a_id]) where user_id = v_agent_a_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  v_zero_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_zero_task_id, v_client_id, 'ZZ scenario 15b zero', 'zero assignees', null, v_agent_a_id, 'Technical', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  select used_capacity into v_capacity_after from public.get_capacity_snapshot(array[v_agent_a_id]) where user_id = v_agent_a_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_capacity_after <> v_capacity_before then
    raise exception 'TEST_FAILED: scenario 15b — creating a zero-assignee task must add exactly 0 to its creator''s own get_capacity_snapshot (before %, after %).', v_capacity_before, v_capacity_after;
  end if;

  select count(*) into v_expected_used
  from public.task_assignees ta
  join public.tasks t on t.id = ta.task_id
  where ta.user_id = v_agent_c_id and t.status not in ('completed', 'closed');

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  select used_capacity into v_snapshot_used from public.get_capacity_snapshot(array[v_agent_c_id]) where user_id = v_agent_c_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_snapshot_used is distinct from v_expected_used then
    raise exception 'TEST_FAILED: scenario 15b — get_capacity_snapshot returned % for v_agent_c via task_assignees membership, expected %.', v_snapshot_used, v_expected_used;
  end if;
  if v_snapshot_used < 1 then
    raise exception 'TEST_FAILED: scenario 15b — v_agent_c should count at least the fresh 2-assignee task via membership.';
  end if;

  -- v_agent_a created the zero-assignee task above but is not an assignee of it — confirm it adds
  -- nothing to THEIR count by checking it's not counted via a direct membership probe.
  if exists (
    select 1 from public.task_assignees ta
    where ta.user_id = v_agent_a_id and ta.task_id = v_zero_task_id
  ) then
    raise exception 'TEST_FAILED: scenario 15b setup — the zero-assignee task unexpectedly has a task_assignees row.';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_auth)::text, true);
  set local role authenticated;
  begin
    perform public.get_capacity_snapshot(array[v_agent_b_id]);
    raise exception 'TEST_FAILED: scenario 15c — a sales caller must be rejected by get_capacity_snapshot.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 16: storage SELECT policy — OR of the old folder-name rule and the new
  -- task_attachments.storage_path rule. A freshly "uploaded" object (fabricated row) under an
  -- existing task's folder, with NO task_attachments row yet, must still resolve via the OLD rule
  -- for that task's creator, and must NOT resolve for an uninvolved party.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 16', 'folder fallback', null, v_agent_a_id, 'Technical', 'todo', current_date, 'low');

  -- No task_attachments row is created for this path at all — simulating the gap between
  -- upload and add_task_attachments_for_copies() running.
  v_storage_path2 := v_task_id || '/zz_verify_pre-metadata.txt';
  insert into storage.objects (bucket_id, name) values ('task-attachments', v_storage_path2);

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  if not exists (select 1 from storage.objects where bucket_id = 'task-attachments' and name = v_storage_path2) then
    raise exception 'TEST_FAILED: scenario 16 — the task''s own creator should see a freshly-uploaded object via the old folder-name rule, even with no task_attachments row yet.';
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_c_auth)::text, true);
  set local role authenticated;
  if exists (select 1 from storage.objects where bucket_id = 'task-attachments' and name = v_storage_path2) then
    raise exception 'TEST_FAILED: scenario 16 — an uninvolved party must NOT see an object under a task they have no relation to.';
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 17: attachment RPCs, redesigned. delete_task_attachment() returns the storage_path
  -- only when no other task_attachments row references it (null otherwise), and never touches
  -- storage.objects itself.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  v_copy1_id := (public.create_task_copy(v_client_id, 'ZZ scenario 17a', 'copy 1', 'Technical', current_date, 'low')).id;
  v_copy2_id := (public.create_task_copy(v_client_id, 'ZZ scenario 17b', 'copy 2', 'Technical', current_date, 'low')).id;
  reset role; perform set_config('request.jwt.claims', '', true);

  v_storage_path := v_copy1_id || '/zz_verify_att-test.txt';
  insert into storage.objects (bucket_id, name, owner) values ('task-attachments', v_storage_path, v_agent_a_auth);

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  perform public.add_task_attachments_for_copies(array[v_copy1_id, v_copy2_id], v_storage_path, 'test.txt', 1234, 'text/plain');
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_att_count from public.task_attachments where storage_path = v_storage_path;
  if v_att_count <> 2 then
    raise exception 'TEST_FAILED: scenario 17 — expected 2 task_attachments rows sharing the one storage_path, found %.', v_att_count;
  end if;

  select id into v_att1_id from public.task_attachments where task_id = v_copy1_id and storage_path = v_storage_path;
  select id into v_att2_id from public.task_attachments where task_id = v_copy2_id and storage_path = v_storage_path;

  -- A path not under either given task's folder must be rejected.
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  begin
    perform public.add_task_attachments_for_copies(array[v_copy1_id, v_copy2_id], 'zz_verify_unrelated-folder/x.txt', 'x.txt', 1, 'text/plain');
    raise exception 'TEST_FAILED: scenario 17b — a storage_path outside every given task''s folder must be rejected.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;

  -- v_agent_c is NOT the uploader of either task_attachments row above — their delete attempt must fail.
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_c_auth)::text, true);
  set local role authenticated;
  begin
    perform public.delete_task_attachment(v_att1_id);
    raise exception 'TEST_FAILED: scenario 17c — delete_task_attachment must be uploader-only.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- The real uploader deletes copy 1's reference — another row (copy 2's) still references the
  -- path, so the function must return NULL (nothing to clean up yet), and never touch
  -- storage.objects itself.
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  select public.delete_task_attachment(v_att1_id) into v_returned_path;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_returned_path is not null then
    raise exception 'TEST_FAILED: scenario 17d — delete_task_attachment must return NULL while another row still references the storage_path, got %.', v_returned_path;
  end if;
  select count(*) into v_object_count from storage.objects where bucket_id = 'task-attachments' and name = v_storage_path;
  if v_object_count <> 1 then
    raise exception 'TEST_FAILED: scenario 17d — delete_task_attachment must never touch storage.objects itself; the fabricated object row must still be there.';
  end if;

  -- Deleting the LAST reference returns the path, non-null — again without touching
  -- storage.objects (that part is the CALLER's job via the Storage API, simulated below).
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  select public.delete_task_attachment(v_att2_id) into v_returned_path;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_returned_path <> v_storage_path then
    raise exception 'TEST_FAILED: scenario 17e — delete_task_attachment must return the storage_path once no task_attachments row references it anymore, got %.', v_returned_path;
  end if;
  select count(*) into v_object_count from storage.objects where bucket_id = 'task-attachments' and name = v_storage_path;
  if v_object_count <> 1 then
    raise exception 'TEST_FAILED: scenario 17e — delete_task_attachment must STILL never touch storage.objects itself, even on the last reference.';
  end if;

  -- Scenario 17f (section 9c): the new owner-based storage DELETE policy. The real uploader
  -- (owner = v_agent_a_auth) can now remove the object directly, simulating the client's
  -- follow-up Storage API call after the non-null return above; an unrelated party cannot.
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_c_auth)::text, true);
  set local role authenticated;
  delete from storage.objects where bucket_id = 'task-attachments' and name = v_storage_path;
  reset role; perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from storage.objects where bucket_id = 'task-attachments' and name = v_storage_path) then
    raise exception 'TEST_FAILED: scenario 17f — a non-owner must NOT be able to delete the storage object.';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  delete from storage.objects where bucket_id = 'task-attachments' and name = v_storage_path;
  reset role; perform set_config('request.jwt.claims', '', true);
  if exists (select 1 from storage.objects where bucket_id = 'task-attachments' and name = v_storage_path) then
    raise exception 'TEST_FAILED: scenario 17f — the real owner should be able to delete their own object directly, with no task_attachments row referencing it anymore.';
  end if;

  -- ======================================================================
  -- Scenario 18: legacy single-assignee reassign — a plain `update tasks set assigned_to = ...`
  -- ends with the right assigned_to and exactly one 'added' + one 'removed' log row for the
  -- reassignment itself (both forward and reverse triggers' pg_trigger_depth() guards hold).
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 18', 'legacy reassign', v_agent_b_id, v_agent_a_id, 'Technical', 'todo', current_date, 'low');

  select count(*) into v_log_count from public.task_assignee_log where task_id = v_task_id;
  if v_log_count <> 1 then
    raise exception 'TEST_FAILED: scenario 18 setup — expected exactly 1 ''added'' log row from creation, found %.', v_log_count;
  end if;

  update public.tasks set assigned_to = v_agent_c_id where id = v_task_id;

  select assigned_to into v_assigned_to from public.tasks where id = v_task_id;
  if v_assigned_to <> v_agent_c_id then
    raise exception 'TEST_FAILED: scenario 18 — assigned_to should be % after the legacy reassign, got %.', v_agent_c_id, v_assigned_to;
  end if;
  select count(*) into v_log_count from public.task_assignee_log where task_id = v_task_id;
  if v_log_count <> 3 then
    raise exception 'TEST_FAILED: scenario 18 — expected exactly 3 total log rows (1 added at creation + 1 removed + 1 added from the reassign, no cascade duplicates), found %.', v_log_count;
  end if;
  if not exists (select 1 from public.task_assignee_log where task_id = v_task_id and user_id = v_agent_b_id and action = 'removed') then
    raise exception 'TEST_FAILED: scenario 18 — expected exactly one ''removed'' row for the old assignee.';
  end if;
  if not exists (select 1 from public.task_assignee_log where task_id = v_task_id and user_id = v_agent_c_id and action = 'added') then
    raise exception 'TEST_FAILED: scenario 18 — expected exactly one ''added'' row for the new assignee.';
  end if;
  if exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_agent_b_id) then
    raise exception 'TEST_FAILED: scenario 18 — the old assignee''s task_assignees row should be gone.';
  end if;

  -- ======================================================================
  -- Scenario 19: an RPC add of 3 brand-new assignees ends with assigned_to = the first listed and
  -- exactly 3 'added' log rows (no cascade duplicates from either trigger).
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 19', 'three at once', null, v_agent_a_id, 'Technical', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_a_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task_id, array[v_agent_b_id, v_agent_c_id, v_agent_d_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  select assigned_to into v_assigned_to from public.tasks where id = v_task_id;
  if v_assigned_to <> v_agent_b_id then
    raise exception 'TEST_FAILED: scenario 19 — assigned_to should be the first-listed assignee (%), got %.', v_agent_b_id, v_assigned_to;
  end if;
  select count(*) into v_log_count from public.task_assignee_log where task_id = v_task_id;
  if v_log_count <> 3 then
    raise exception 'TEST_FAILED: scenario 19 — expected exactly 3 ''added'' log rows, found %.', v_log_count;
  end if;
  if exists (select 1 from public.task_assignee_log where task_id = v_task_id and action <> 'added') then
    raise exception 'TEST_FAILED: scenario 19 — every log row for this task should be ''added'' — no spurious ''removed'' rows from a cascade.';
  end if;

  -- ======================================================================
  -- Scenario 20: set_task_assignees' gate (round 2) — am_team_lead via the TEAM RULE.
  -- 20a: own team (creator's team matches) — allowed. 20b: other team, no client-management
  -- relationship either — rejected.
  -- ======================================================================
  update public.users set team = v_am_lead_team where id = v_agent_a_id;

  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 20a', 'am_team_lead own team', null, v_agent_a_id, v_am_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_am_lead_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task_id, array[v_agent_b_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_agent_b_id) then
    raise exception 'TEST_FAILED: scenario 20a — am_team_lead should be able to edit assignees on a task created by someone on their own team (team rule).';
  end if;

  update public.users set team = v_agent_a_original_team where id = v_agent_a_id;

  -- 20b: neutralize the client-management door too (null out the client's am_agent_id
  -- temporarily), so this isolates the team-rule rejection specifically.
  select am_agent_id into v_client_scratch_am_agent_id from public.clients where id = v_client_id;
  update public.clients set am_agent_id = null where id = v_client_id;

  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 20b', 'am_team_lead other team', null, v_agent_a_id, v_agent_a_original_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_am_lead_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_assignees(v_task_id, array[v_agent_b_id]);
    raise exception 'TEST_FAILED: scenario 20b — am_team_lead must be rejected on a task entirely outside their team, with no client-management relationship either.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  update public.clients set am_agent_id = v_client_scratch_am_agent_id where id = v_client_id;

  -- ======================================================================
  -- Scenario 21: media_buying_team_lead — own team allowed, other team rejected (same pattern).
  -- ======================================================================
  update public.users set team = v_mb_lead_team where id = v_agent_a_id;

  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 21a', 'media_buying_team_lead own team', null, v_agent_a_id, v_mb_lead_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_mb_lead_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task_id, array[v_agent_c_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_agent_c_id) then
    raise exception 'TEST_FAILED: scenario 21a — media_buying_team_lead should be able to edit assignees on a task created by someone on their own team.';
  end if;

  update public.users set team = v_agent_a_original_team where id = v_agent_a_id;

  select am_agent_id into v_client_scratch_am_agent_id from public.clients where id = v_client_id;
  update public.clients set am_agent_id = null where id = v_client_id;

  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 21b', 'media_buying_team_lead other team', null, v_agent_a_id, v_agent_a_original_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_mb_lead_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_assignees(v_task_id, array[v_agent_c_id]);
    raise exception 'TEST_FAILED: scenario 21b — media_buying_team_lead must be rejected on a task on another team with no client-management relationship.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  update public.clients set am_agent_id = v_client_scratch_am_agent_id where id = v_client_id;

  -- ======================================================================
  -- Scenario 22: marketing_manager is rejected even though they can SEE the task (the creative
  -- door in task_visible_v2 is deliberately not replicated here). Confirms the visibility side
  -- first, so the rejection below is a meaningful contrast, not a double-negative.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 22', 'marketing_manager sees but cannot manage', null, v_creative_id, 'Creative & Design', 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_marketing_mgr_auth)::text, true);
  set local role authenticated;
  select public.task_visible_v2(v_task_id) into v_result;
  if not v_result then
    raise exception 'TEST_SETUP_FAILED: scenario 22 — marketing_manager should see a graphic_designer/video_editor''s task (precondition for this scenario to mean anything).';
  end if;
  begin
    perform public.set_task_assignees(v_task_id, array[v_agent_b_id]);
    raise exception 'TEST_FAILED: scenario 22 — marketing_manager must be rejected from managing assignees despite being able to see the task.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 23: am_agent managing the task's client can swap its designer — the
  -- client-management door, independent of creator/assignee/team.
  -- ======================================================================
  select am_agent_id into v_client_scratch_am_agent_id from public.clients where id = v_client_id;
  update public.clients set am_agent_id = v_am_agent_id where id = v_client_id;

  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 23', 'am_agent swaps designer', null, v_agent_a_id, v_agent_a_original_team, 'todo', current_date, 'low');
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_id, v_creative_id, v_agent_a_id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task_id, array[v_agent_b_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_creative_id) then
    raise exception 'TEST_FAILED: scenario 23 — am_agent managing the client should be able to swap out the designer.';
  end if;
  if not exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_agent_b_id) then
    raise exception 'TEST_FAILED: scenario 23 — am_agent managing the client should be able to swap in a new assignee.';
  end if;

  update public.clients set am_agent_id = v_client_scratch_am_agent_id where id = v_client_id;

  -- ======================================================================
  -- Scenario 24: am_team_lead can swap any assignee on his team's CLIENT task — the
  -- client-management-via-team door specifically (creator deliberately on an unrelated team, so
  -- the team-rule door from scenario 20 cannot be what's passing this one).
  -- ======================================================================
  select team into v_am_agent_old_team from public.users where id = v_am_agent_id;
  update public.users set team = v_am_lead_team where id = v_am_agent_id;

  select am_agent_id into v_client_scratch_am_agent_id from public.clients where id = v_client_id;
  update public.clients set am_agent_id = v_am_agent_id where id = v_client_id;

  select team into v_scratch_old_team from public.users where id = v_agent_d_id;
  update public.users set team = v_agent_a_original_team where id = v_agent_d_id;

  -- Also pin the creative assignee's team away from v_am_lead_team — otherwise, if it happened to
  -- coincidentally match, the generic team-rule branch (scenario 20) could ALSO pass here,
  -- muddying this scenario's isolation of the client-management-via-team branch specifically.
  select team into v_creative_old_team from public.users where id = v_creative_id;
  update public.users set team = v_agent_a_original_team where id = v_creative_id;

  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 24', 'am_team_lead swaps via client', null, v_agent_d_id, v_agent_a_original_team, 'todo', current_date, 'low');
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_id, v_creative_id, v_agent_d_id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_am_lead_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task_id, array[v_agent_c_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_creative_id) then
    raise exception 'TEST_FAILED: scenario 24 — am_team_lead whose team manages the client should be able to swap out the existing assignee.';
  end if;
  if not exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_agent_c_id) then
    raise exception 'TEST_FAILED: scenario 24 — am_team_lead whose team manages the client should be able to swap in a new assignee.';
  end if;

  update public.users set team = v_scratch_old_team where id = v_agent_d_id;
  update public.users set team = v_creative_old_team where id = v_creative_id;
  update public.clients set am_agent_id = v_client_scratch_am_agent_id where id = v_client_id;
  update public.users set team = v_am_agent_old_team where id = v_am_agent_id;

  -- ======================================================================
  -- Scenario 25: a plain assignee (not creator, no special role) can add/remove other assignees.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 25', 'plain assignee edits', null, v_agent_a_id, v_agent_a_original_team, 'todo', current_date, 'low');
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_id, v_agent_b_id, v_agent_a_id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_b_auth)::text, true);
  set local role authenticated;
  perform public.set_task_assignees(v_task_id, array[v_agent_b_id, v_agent_c_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.task_assignees where task_id = v_task_id and user_id = v_agent_c_id) then
    raise exception 'TEST_FAILED: scenario 25 — a plain assignee (task_closable''s assignee branch) should be able to add another assignee.';
  end if;

  -- ======================================================================
  -- Scenario 26: an uninvolved agent (not creator, not assignee, no admin/am/team-lead role) is
  -- rejected outright.
  -- ======================================================================
  v_task_id := 'zz_verify_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ scenario 26', 'uninvolved rejected', null, v_agent_a_id, v_agent_a_original_team, 'todo', current_date, 'low');

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_c_auth)::text, true);
  set local role authenticated;
  begin
    perform public.set_task_assignees(v_task_id, array[v_agent_b_id]);
    raise exception 'TEST_FAILED: scenario 26 — an uninvolved agent with no relationship to this task must be rejected.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all task_assignees_rpcs tests passed (review round 2, 26 scenarios). Nothing persisted.';
end $$;
