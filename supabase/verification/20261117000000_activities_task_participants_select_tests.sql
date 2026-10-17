-- Verification for 20261117000000_activities_task_participants_select.sql.
--
-- Single DO block, distinct real personas, ends in a raised exception so every change (the test
-- task, its assignee, the three fabricated activities rows) is rolled back regardless of outcome:
-- TEST_OK_ROLLED_BACK on success, a descriptive TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
--
-- Every impersonation sets request.jwt.claims to {"sub": ..., "role": "authenticated"} and
-- self-checks auth.role() right after switching Postgres role, per this session's established
-- pattern (see 20261115000000_daily_task_target_tests.sql's own header) — kept here for
-- consistency even though task_visible_v2()/app_user_id() read the JWT's "sub" claim, not
-- auth.role(); a TEST_SETUP_FAILED here means the impersonation itself didn't take effect, not
-- that the feature under test is wrong.
--
-- Every row this test depends on is created with a REAL INSERT under the actor's own
-- impersonation, not a privileged/bypassing write — the three activities rows in particular are
-- each inserted while impersonating the account that is user_id on that row, satisfying
-- activities_insert_rls (with check user_id = app_user_id()) for real, the same way a genuine
-- caller would.
do $$
declare
  v_client_id text;
  v_admin_id text;
  v_admin_auth uuid;
  v_creator_id text;
  v_creator_auth uuid;
  v_assignee_id text;
  v_assignee_auth uuid;
  v_other_id text;
  v_other_auth uuid;
  v_task_id text := 'zz_act_task_' || substr(md5(random()::text), 1, 8);
  v_ghost_task_id text := 'zz_act_ghost_task_' || substr(md5(random()::text), 1, 8);
  v_activity_task_id text := 'zz_act_' || substr(md5(random()::text), 1, 8);
  v_activity_client_id text := 'zz_act_' || substr(md5(random()::text), 1, 8);
  v_activity_ghost_id text := 'zz_act_' || substr(md5(random()::text), 1, 8);
  v_count integer;
begin
  select id into v_client_id from public.clients limit 1;
  if v_client_id is null then
    raise exception 'TEST_SETUP_FAILED: no client row found at all.';
  end if;

  select id, auth_id into v_admin_id, v_admin_auth from public.users
  where role in ('executive', 'head_of_technical') and auth_id is not null and deactivated_at is null
  limit 1;
  if v_admin_id is null then
    raise exception 'TEST_SETUP_FAILED: no active executive/head_of_technical persona found.';
  end if;

  select id, auth_id into v_creator_id, v_creator_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null and id <> v_admin_id
  limit 1;
  if v_creator_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_agent persona found for the creator.';
  end if;

  select id, auth_id into v_assignee_id, v_assignee_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_creator_id
  limit 1;
  if v_assignee_id is null then
    raise exception 'TEST_SETUP_FAILED: need a second active am_agent persona distinct from the creator.';
  end if;

  select id, auth_id into v_other_id, v_other_auth from public.users
  where role = 'seo_agent' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_creator_id and id <> v_assignee_id
  limit 1;
  if v_other_id is null then
    raise exception 'TEST_SETUP_FAILED: no active seo_agent persona found for the unrelated-employee check.';
  end if;

  -- ======================================================================
  -- Setup: a real task created by v_creator, with v_assignee added as a real assignee.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (setup).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ activities participants test', 'test', v_creator_id, 'Account Management', 'todo', current_date + 5, 'low');
  perform public.set_task_assignees(v_task_id, array[v_assignee_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: three fabricated activities rows, each inserted under its own actor's impersonation.
  --   1. v_activity_task_id: target_type='task', target_id=v_task_id (the real task above).
  --   2. v_activity_client_id: target_type='client', but target_id is the SAME v_task_id — a
  --      rigorous check that the new policy keys off target_type, not just target_id, so a task
  --      participant can't see an unrelated entity's activity merely by sharing that text value.
  --   3. v_activity_ghost_id: target_type='task', target_id=v_ghost_task_id, a task id that was
  --      NEVER inserted into public.tasks at all — standing in for "a deleted/non-existent task".
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (activities setup).';
  end if;
  insert into public.activities (id, user_id, action_type, target_type, target_id, target_name, details)
  values
    (v_activity_task_id, v_creator_id, 'create', 'task', v_task_id, 'ZZ activities participants test', null),
    (v_activity_client_id, v_creator_id, 'update', 'client', v_task_id, 'ZZ same-id-different-type', 'test'),
    (v_activity_ghost_id, v_creator_id, 'status_change', 'task', v_ghost_task_id, 'ZZ ghost task', 'Status updated to in_progress');
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 1: the task's creator sees its own activity row.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 1).';
  end if;
  select count(*) into v_count from public.activities where id = v_activity_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 1 — the task creator must see their own task''s activity, saw %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 2: the assignee sees it too.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_assignee_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 2).';
  end if;
  select count(*) into v_count from public.activities where id = v_activity_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 2 — an assignee must see their task''s activity, saw %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 3: an employee unrelated to the task (not creator, not assignee, not admin, a
  -- different department) sees zero.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 3).';
  end if;
  select count(*) into v_count from public.activities where id = v_activity_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 3 — an unrelated employee must see zero rows, saw %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 4: executive/head_of_technical sees all three rows regardless — proving
  -- activities_select_rls (the pre-existing admin-only policy) is completely unaffected by the
  -- new one, including the client-type and ghost-task rows no participant-based door covers.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 4).';
  end if;
  select count(*) into v_count from public.activities
  where id = any(array[v_activity_task_id, v_activity_client_id, v_activity_ghost_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_count <> 3 then
    raise exception 'TEST_FAILED: scenario 4 — an admin must see all 3 fabricated rows, saw %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 5: the SAME task's creator must NOT see the client-type row that happens to share
  -- its task's own id as target_id — the new policy must key off target_type = 'task', not merely
  -- a matching target_id.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 5).';
  end if;
  select count(*) into v_count from public.activities where id = v_activity_client_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 5 — a client-type activity must not leak through target_id alone, saw %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 6: an activity recorded against a task that doesn't exist (standing in for a
  -- hard-deleted task) is invisible to a non-admin — task_visible_v2() requires the task to
  -- actually exist (exists(select 1 from t) in its own definition), so no participant-style
  -- branch can ever match a target_id with nothing behind it. Checked with the creator, the
  -- non-admin persona with the most routes to visibility of anything.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 6).';
  end if;
  select count(*) into v_count from public.activities where id = v_activity_ghost_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 6 — a non-admin must not see an activity on a nonexistent/deleted task, saw %.', v_count;
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all activities_select_task_participants scenarios passed; rolling back every fabricated change.';
end $$;
