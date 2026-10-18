-- Verification for 20261122000000_management_notifications_completed_closed_only.sql.
--
-- Single DO block, distinct real personas, ends in a raised exception so every change (the two
-- test tasks and their assignees) is rolled back regardless of outcome: TEST_OK_ROLLED_BACK on
-- success, a descriptive TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
--
-- Every impersonation sets request.jwt.claims to {"sub": ..., "role": "authenticated"} and
-- self-checks auth.role() right after switching Postgres role, per this session's established
-- pattern (same as 20261118000000_key_task_notifications_team_feed_tests.sql) -- a
-- TEST_SETUP_FAILED here means the impersonation itself did not take effect, not that the feature
-- under test is wrong.
--
-- task_events rows are inserted DIRECTLY here (not via an UPDATE on tasks.status), elevated --
-- i.e. with no role switch at all, running as whatever role this verification script itself runs
-- as. task_events has no insert policy for any role (confirmed in 20261116000000_task_events.sql:
-- "revoke all on public.task_events from public, anon, authenticated; grant select ... to
-- authenticated" -- writes are only ever done by the two SECURITY DEFINER trigger functions), so
-- an authenticated-role insert would be rejected by RLS outright. Inserting directly also lets
-- this test exercise all five key transitions (including a revision) on ONE task without needing
-- five separate, individually-valid tasks.status transitions -- task_events.old_value/new_value
-- are free-text columns with no CHECK constraint tying them to any real state machine.
--
-- Every exception handler below re-raises unconditionally on its own TEST_FAILED/TEST_SETUP_FAILED
-- marker BEFORE checking the real rejection text, so a bug that lets a rejected operation silently
-- succeed can never be mistaken for a pass via a loose substring match.
--
-- Notifications have no task_id column of their own, so every check below filters by
-- message LIKE '%' || <this test's unique task title> || '%' -- each test task's title embeds a
-- fresh random suffix, making that filter precise regardless of whatever real historical
-- notification rows already exist for these same real persona accounts.
do $$
declare
  v_client_id text;
  v_exec_id text;
  v_ho_tech_id text;
  v_am_tl_id text;
  v_am_tl_auth uuid;
  v_am_tl_team text;
  v_creator_id text;
  v_creator_auth uuid;
  v_assignee_id text;
  v_task1_title text := 'ZZ mgmt-notif test 1 ' || substr(md5(random()::text), 1, 8);
  v_task2_title text := 'ZZ mgmt-notif test 2 ' || substr(md5(random()::text), 1, 8);
  v_task1_id text := 'zz_mgmtnotif_1_' || substr(md5(random()::text), 1, 8);
  v_task2_id text := 'zz_mgmtnotif_2_' || substr(md5(random()::text), 1, 8);
  v_count integer;
begin
  select id into v_client_id from public.clients limit 1;
  if v_client_id is null then
    raise exception 'TEST_SETUP_FAILED: no client row found at all.';
  end if;

  -- Both leadership roles are needed as DISTINCT real personas (not "any one admin" the way
  -- 20261118000000's own test does it) -- this migration's whole point is a difference BETWEEN
  -- what completed/closed vs. the other three transitions send them, so both must be checked.
  select id into v_exec_id from public.users
  where role = 'executive' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_exec_id is null then
    raise exception 'TEST_SETUP_FAILED: no active executive persona found.';
  end if;

  select id into v_ho_tech_id from public.users
  where role = 'head_of_technical' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_ho_tech_id is null then
    raise exception 'TEST_SETUP_FAILED: no active head_of_technical persona found.';
  end if;

  select id, auth_id, team into v_am_tl_id, v_am_tl_auth, v_am_tl_team from public.users
  where role = 'am_team_lead' and auth_id is not null and deactivated_at is null and team is not null
  limit 1;
  if v_am_tl_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_team_lead persona (with a team) found.';
  end if;

  select id, auth_id into v_creator_id, v_creator_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
    and team = v_am_tl_team and id <> v_exec_id and id <> v_ho_tech_id and id <> v_am_tl_id
  limit 1;
  if v_creator_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_agent on the same team as the am_team_lead found, for the creator.';
  end if;

  select id into v_assignee_id from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
    and team = v_am_tl_team and id <> v_exec_id and id <> v_ho_tech_id and id <> v_am_tl_id and id <> v_creator_id
  limit 1;
  if v_assignee_id is null then
    raise exception 'TEST_SETUP_FAILED: need a second active am_agent on the same team, for the assignee (whose supervisor is am_team_lead).';
  end if;

  -- ======================================================================
  -- Setup: task1, created by v_creator (am_agent, same team as v_am_tl), assigned to v_assignee
  -- (am_agent, same team -- task_supervisor_role('am_agent') = 'am_team_lead').
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (task1 setup).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task1_id, v_client_id, v_task1_title, 'test', v_creator_id, 'Account Management', 'todo', current_date + 5, 'low');
  perform public.set_task_assignees(v_task1_id, array[v_assignee_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Fire all five key transitions on task1, directly as task_events rows, actor = v_assignee_id
  -- throughout (so "the actor never receives" can be checked against every one of them). Old/new
  -- values are chosen only to satisfy notify_key_task_status_changes()'s own branching, not to
  -- form a real sequence of task.status values.
  -- ======================================================================
  insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
  values (v_task1_id, v_assignee_id, 'status_changed', 'todo', 'in_review');

  insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
  values (v_task1_id, v_assignee_id, 'status_changed', 'in_review', 'completed');

  insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
  values (v_task1_id, v_assignee_id, 'status_changed', 'completed', 'closed');

  insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
  values (v_task1_id, v_assignee_id, 'status_changed', 'in_progress', 'blocked');

  -- A revision: old_value in ('in_review', 'completed', 'closed') and new_value in
  -- ('todo', 'in_progress') -- v_is_revision = true, takes the "Task Sent Back for Revision"
  -- branch, which is NOT new.new_value in ('completed', 'closed') either way.
  insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
  values (v_task1_id, v_assignee_id, 'status_changed', 'completed', 'in_progress');

  -- ----------------------------------------------------------------------
  -- executive: exactly 2 notifications for task1 (completed, closed) -- never in_review, blocked,
  -- or the revision.
  -- ----------------------------------------------------------------------
  select count(*) into v_count from public.notifications
  where user_id = v_exec_id and type = 'task_updated' and message like '%' || v_task1_title || '%';
  if v_count <> 2 then
    raise exception 'TEST_FAILED: executive must receive exactly 2 notifications for task1 (completed + closed only), got %.', v_count;
  end if;

  select count(*) into v_count from public.notifications
  where user_id = v_exec_id and type = 'task_updated' and message like '%' || v_task1_title || '%'
    and (title = 'Task Ready for Review' or title = 'Task Blocked' or title = 'Task Sent Back for Revision');
  if v_count <> 0 then
    raise exception 'TEST_FAILED: executive must not receive an in_review/blocked/revision notification for task1, got %.', v_count;
  end if;

  -- ----------------------------------------------------------------------
  -- head_of_technical: same 2-of-5 expectation as executive, checked as its own distinct persona.
  -- ----------------------------------------------------------------------
  select count(*) into v_count from public.notifications
  where user_id = v_ho_tech_id and type = 'task_updated' and message like '%' || v_task1_title || '%';
  if v_count <> 2 then
    raise exception 'TEST_FAILED: head_of_technical must receive exactly 2 notifications for task1 (completed + closed only), got %.', v_count;
  end if;

  select count(*) into v_count from public.notifications
  where user_id = v_ho_tech_id and type = 'task_updated' and message like '%' || v_task1_title || '%'
    and (title = 'Task Ready for Review' or title = 'Task Blocked' or title = 'Task Sent Back for Revision');
  if v_count <> 0 then
    raise exception 'TEST_FAILED: head_of_technical must not receive an in_review/blocked/revision notification for task1, got %.', v_count;
  end if;

  -- ----------------------------------------------------------------------
  -- am_team_lead (v_assignee's supervisor): still all 5, unchanged.
  -- ----------------------------------------------------------------------
  select count(*) into v_count from public.notifications
  where user_id = v_am_tl_id and type = 'task_updated' and message like '%' || v_task1_title || '%';
  if v_count <> 5 then
    raise exception 'TEST_FAILED: am_team_lead (the assignee''s supervisor) must still receive all 5 key-transition notifications for task1, got %.', v_count;
  end if;

  -- ----------------------------------------------------------------------
  -- The actor (v_assignee performed every one of the 5 events above) must never be notified about
  -- their own action, for any of them.
  -- ----------------------------------------------------------------------
  select count(*) into v_count from public.notifications
  where user_id = v_assignee_id and type = 'task_updated' and message like '%' || v_task1_title || '%';
  if v_count <> 0 then
    raise exception 'TEST_FAILED: the actor must never be notified about their own action, got %.', v_count;
  end if;

  -- ======================================================================
  -- task2: no assignees at all -- the task_supervisor_role branch's EXISTS-style subquery must
  -- yield nothing, and the insert itself must not raise (notify_key_task_status_changes() has its
  -- own exception handler regardless, but this also confirms the normal, non-exceptional path
  -- tolerates zero assignees cleanly). A 'completed' transition still reaches both leadership
  -- personas (their branch does not depend on assignees at all).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (task2 setup).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task2_id, v_client_id, v_task2_title, 'test', v_creator_id, 'Account Management', 'todo', current_date + 5, 'low');
  reset role; perform set_config('request.jwt.claims', '', true);

  insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
  values (v_task2_id, v_creator_id, 'status_changed', 'todo', 'completed');

  select count(*) into v_count from public.notifications
  where user_id = v_exec_id and type = 'task_updated' and message like '%' || v_task2_title || '%';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: executive must receive exactly 1 notification for task2''s completed transition even with zero assignees, got %.', v_count;
  end if;

  select count(*) into v_count from public.notifications
  where user_id = v_ho_tech_id and type = 'task_updated' and message like '%' || v_task2_title || '%';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: head_of_technical must receive exactly 1 notification for task2''s completed transition even with zero assignees, got %.', v_count;
  end if;

  -- Safe with no type/user filter at all: task2 never has set_task_assignees() called on it, so
  -- there is no type = 'task_assigned' notification mentioning task2_title that this could ever
  -- mistakenly count, and the only possible recipient of a supervisor-branch notification here
  -- would be am_team_lead (no other role's supervisor applies in this test's persona set).
  select count(*) into v_count from public.notifications
  where user_id = v_am_tl_id and message like '%' || v_task2_title || '%';
  if v_count <> 0 then
    raise exception 'TEST_FAILED: a task with zero assignees must produce zero supervisor-branch notifications, got %.', v_count;
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all management_notifications_completed_closed_only scenarios passed; rolling back every fabricated change.';
end $$;
