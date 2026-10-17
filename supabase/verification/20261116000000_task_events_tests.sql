-- Verification for 20261116000000_task_events.sql.
--
-- Single DO block, distinct real personas, ends in a raised exception so every change (the test
-- task, its updates, its assignee add/remove) is rolled back regardless of outcome:
-- TEST_OK_ROLLED_BACK on success, a descriptive TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
--
-- Every impersonation sets request.jwt.claims to {"sub": ..., "role": "authenticated"} and
-- self-checks auth.role() right after switching Postgres role, per this session's established
-- pattern (see 20261115000000_daily_task_target_tests.sql's own header for why this matters for
-- any trigger/policy that reads auth.role() specifically) — kept here for consistency even though
-- task_visible_v2()/app_user_id() read the JWT's "sub" claim, not auth.role(); a TEST_SETUP_FAILED
-- here means the impersonation itself didn't take effect, not that the feature under test is wrong.
--
-- Every exception handler below re-raises unconditionally on its own TEST_FAILED/TEST_SETUP_FAILED
-- marker BEFORE checking the real rejection text, so a bug that lets a rejected operation silently
-- succeed can never be mistaken for a pass via a loose substring match on its own synthetic message.
do $$
declare
  v_client_id text;
  v_admin_id text;
  v_admin_auth uuid;
  v_creator_id text;
  v_creator_auth uuid;
  v_assignee_id text;
  v_assignee_auth uuid;
  v_assignee2_id text;
  v_assignee2_auth uuid;
  v_other_team_id text;
  v_other_team_auth uuid;
  v_task_id text := 'zz_task_events_' || substr(md5(random()::text), 1, 8);
  v_task2_id text := 'zz_task_events_2_' || substr(md5(random()::text), 1, 8);
  v_task3_id text := 'zz_task_events_3_' || substr(md5(random()::text), 1, 8);
  v_task4_id text := 'zz_task_events_4_' || substr(md5(random()::text), 1, 8);
  v_initial_due_date date := current_date + 5;
  v_updated_due_date date := current_date + 10;
  v_count integer;
  v_count_before integer;
  v_total_events integer;
  v_actor_check text;
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

  select id, auth_id into v_assignee2_id, v_assignee2_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_creator_id and id <> v_assignee_id
  limit 1;
  if v_assignee2_id is null then
    raise exception 'TEST_SETUP_FAILED: need a third active am_agent persona for the legacy-reassignment scenario.';
  end if;

  select id, auth_id into v_other_team_id, v_other_team_auth from public.users
  where role = 'seo_agent' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_creator_id and id <> v_assignee_id and id <> v_assignee2_id
  limit 1;
  if v_other_team_id is null then
    raise exception 'TEST_SETUP_FAILED: no active seo_agent persona found for the unrelated-team check.';
  end if;

  -- ======================================================================
  -- Scenario 1: INSERT on tasks -> exactly one 'created' event, actor = the inserting creator.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 1).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ task-events test', 'test', v_creator_id, 'Account Management', 'todo', v_initial_due_date, 'low');
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events
  where task_id = v_task_id and event_type = 'created' and actor_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 1 — expected exactly one ''created'' event, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 2: UPDATE status -> exactly one 'status_changed' event with the real old/new values.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 2).';
  end if;
  update public.tasks set status = 'in_progress' where id = v_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events
  where task_id = v_task_id and event_type = 'status_changed'
    and old_value = 'todo' and new_value = 'in_progress' and actor_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 2 — expected exactly one status_changed(todo -> in_progress) event, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 3: UPDATE priority -> exactly one 'priority_changed' event.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 3).';
  end if;
  update public.tasks set priority = 'high' where id = v_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events
  where task_id = v_task_id and event_type = 'priority_changed'
    and old_value = 'low' and new_value = 'high' and actor_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 3 — expected exactly one priority_changed(low -> high) event, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 4: UPDATE due_date -> exactly one 'due_date_changed' event, values as text.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 4).';
  end if;
  update public.tasks set due_date = v_updated_due_date where id = v_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events
  where task_id = v_task_id and event_type = 'due_date_changed'
    and old_value = v_initial_due_date::text and new_value = v_updated_due_date::text and actor_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — expected exactly one due_date_changed event, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 5: UPDATE title -> exactly one 'title_changed' event.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 5).';
  end if;
  update public.tasks set title = 'ZZ task-events test (renamed)' where id = v_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events
  where task_id = v_task_id and event_type = 'title_changed'
    and old_value = 'ZZ task-events test' and new_value = 'ZZ task-events test (renamed)' and actor_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 5 — expected exactly one title_changed event, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 6: UPDATE team -> exactly one 'team_changed' event.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 6).';
  end if;
  update public.tasks set team = 'Social Media' where id = v_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events
  where task_id = v_task_id and event_type = 'team_changed'
    and old_value = 'Account Management' and new_value = 'Social Media' and actor_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 6 — expected exactly one team_changed event, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 7: an UPDATE touching only an untracked column (estimated_hours) must write nothing.
  -- ======================================================================
  select count(*) into v_count_before from public.task_events where task_id = v_task_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 7).';
  end if;
  update public.tasks set estimated_hours = 5 where id = v_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events where task_id = v_task_id;
  if v_count <> v_count_before then
    raise exception 'TEST_FAILED: scenario 7 — an update to an untracked column must write zero events, went from % to %.', v_count_before, v_count;
  end if;

  -- ======================================================================
  -- Scenario 8: set_task_assignees() adding v_assignee -> exactly one 'assignee_added' event,
  -- actor = added_by = the creator (who made this call), not a second row from the legacy
  -- assigned_to <-> task_assignees sync trigger pair.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 8).';
  end if;
  perform public.set_task_assignees(v_task_id, array[v_assignee_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events
  where task_id = v_task_id and event_type = 'assignee_added'
    and new_value = v_assignee_id and actor_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 8 — expected exactly one assignee_added event for %, got %.', v_assignee_id, v_count;
  end if;

  -- Ground truth total so far (bypassing RLS, same ambient privilege every other verification
  -- script in this repo reads fixture state with): 7 real events — created, status_changed,
  -- priority_changed, due_date_changed, title_changed, team_changed, assignee_added, and the
  -- untracked-column update from scenario 7 contributing zero. Re-checked explicitly so scenarios
  -- 9/13 below aren't comparing against an assumption.
  select count(*) into v_total_events from public.task_events where task_id = v_task_id;
  if v_total_events <> 7 then
    raise exception 'TEST_FAILED: scenario 8b — expected 7 total events after scenarios 1-8 (6 field changes + 1 add), got %.', v_total_events;
  end if;

  -- ======================================================================
  -- Scenario 9: the now-assigned employee can see every event on their own task (not just the
  -- assignee_added row) — visibility is task-scoped via task_visible_v2(), not per-event.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_assignee_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 9).';
  end if;
  select count(*) into v_count from public.task_events where task_id = v_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_count <> v_total_events then
    raise exception 'TEST_FAILED: scenario 9 — an assigned employee must see every event on their own task (% of %).', v_count, v_total_events;
  end if;

  -- ======================================================================
  -- Scenario 10: set_task_assignees() removing v_assignee -> exactly one 'assignee_removed'
  -- event, actor = app_user_id() = the creator (who made THIS call) — the row itself carries no
  -- actor on removal, unlike the add.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 10).';
  end if;
  perform public.set_task_assignees(v_task_id, array[]::text[]);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events
  where task_id = v_task_id and event_type = 'assignee_removed'
    and old_value = v_assignee_id and actor_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 10 — expected exactly one assignee_removed event for %, got %.', v_assignee_id, v_count;
  end if;

  select count(*) into v_total_events from public.task_events where task_id = v_task_id;
  if v_total_events <> 8 then
    raise exception 'TEST_FAILED: scenario 10b — expected 8 total events after the removal, got %.', v_total_events;
  end if;

  -- ======================================================================
  -- Scenario 11: an employee from an unrelated team/role, never assigned, never the creator, not
  -- admin — must see zero events for this task.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_team_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 11).';
  end if;
  select count(*) into v_count from public.task_events where task_id = v_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 11 — an unrelated employee must see zero events, saw %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 12: executive/head_of_technical sees every event on the task, unconditionally.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 12).';
  end if;
  select count(*) into v_count from public.task_events where task_id = v_task_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_count <> v_total_events then
    raise exception 'TEST_FAILED: scenario 12 — an admin must see every event on the task (% of %).', v_count, v_total_events;
  end if;

  -- ======================================================================
  -- Scenario 13: no direct write is possible, even for an admin — only the two SECURITY DEFINER
  -- triggers ever write this table. First the grants themselves (deterministic, no exception
  -- handling needed), then a live attempt proving the actual behavioral consequence.
  -- ======================================================================
  if has_table_privilege('authenticated', 'public.task_events', 'INSERT')
    or has_table_privilege('authenticated', 'public.task_events', 'UPDATE')
    or has_table_privilege('authenticated', 'public.task_events', 'DELETE') then
    raise exception 'TEST_FAILED: scenario 13a — authenticated must not hold INSERT/UPDATE/DELETE on task_events.';
  end if;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.role() is distinct from 'authenticated' then
      raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 13b).';
    end if;
    insert into public.task_events (task_id, actor_id, event_type) values (v_task_id, v_admin_id, 'created');
    raise exception 'TEST_FAILED: scenario 13b — a direct INSERT into task_events must be rejected, even for an admin.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' or sqlerrm like 'TEST_SETUP_FAILED%' then
      raise;
    end if;
    if sqlerrm not like '%permission denied for table task_events%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 14: executive/head_of_technical hard-deletes a task (with an assignee) via
  -- delete_tasks(). task_assignees.task_id -> tasks(id) ON DELETE CASCADE removes its
  -- task_assignees row without any explicit DELETE statement ever touching task_assignees itself
  -- — exactly the cascade case task_assignees_log_events()'s existence check exists for. Must
  -- write zero 'assignee_removed' rows for it, and every event already logged before the delete
  -- must still be there afterward (task_events has no FK to tasks, by design).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 14a).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task2_id, v_client_id, 'ZZ task-events delete test', 'test', v_creator_id, 'Account Management', 'todo', v_initial_due_date, 'low');
  perform public.set_task_assignees(v_task2_id, array[v_assignee_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count_before from public.task_events where task_id = v_task2_id;
  if v_count_before <> 2 then
    raise exception 'TEST_FAILED: scenario 14a — expected 2 events (created + assignee_added) before the delete, got %.', v_count_before;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 14b).';
  end if;
  perform public.delete_tasks(array[v_task2_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events where task_id = v_task2_id and event_type = 'assignee_removed';
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 14b — a cascade-induced assignee removal from a hard delete must write zero assignee_removed events, got %.', v_count;
  end if;

  select count(*) into v_count from public.task_events where task_id = v_task2_id;
  if v_count <> v_count_before then
    raise exception 'TEST_FAILED: scenario 14c — events logged before a hard delete must still all be there afterward (had %, now %).', v_count_before, v_count;
  end if;

  -- ======================================================================
  -- Scenario 15: reassigning tasks.assigned_to directly from A to B (the legacy path, not
  -- set_task_assignees()) must still produce exactly one assignee_removed(A) and one
  -- assignee_added(B) — sync_legacy_assigned_to_to_task_assignees_trigger does the actual
  -- task_assignees delete+insert underneath, and each fires task_assignees_log_events_trigger
  -- exactly once, same as any other row-level INSERT/DELETE on that table.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 15a).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority, assigned_to)
  values (v_task3_id, v_client_id, 'ZZ task-events legacy reassign test', 'test', v_creator_id, 'Account Management', 'todo', v_initial_due_date, 'low', v_assignee_id);
  update public.tasks set assigned_to = v_assignee2_id where id = v_task3_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.task_events
  where task_id = v_task3_id and event_type = 'assignee_removed' and old_value = v_assignee_id and actor_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 15 — expected exactly one assignee_removed(%) via the legacy path, got %.', v_assignee_id, v_count;
  end if;

  select count(*) into v_count from public.task_events
  where task_id = v_task3_id and event_type = 'assignee_added' and new_value = v_assignee2_id and actor_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 15 — expected exactly one assignee_added(%) via the legacy path, got %.', v_assignee2_id, v_count;
  end if;

  -- created + assignee_added(A, from the INSERT's own assigned_to) + assignee_removed(A) +
  -- assignee_added(B) = 4 total, confirming neither leg of the reassignment was double-logged.
  select count(*) into v_count from public.task_events where task_id = v_task3_id;
  if v_count <> 4 then
    raise exception 'TEST_FAILED: scenario 15 — expected exactly 4 total events for the legacy-reassignment task, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 16: a 'created' event's actor falls back to created_by when app_user_id() has
  -- nothing to resolve — simulated here by inserting with no impersonation at all (no
  -- request.jwt.claims set), so auth.uid() — and so app_user_id() — is null, same as any
  -- genuine service-context write with no authenticated caller.
  -- ======================================================================
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task4_id, v_client_id, 'ZZ task-events no-auth-context test', 'test', v_creator_id, 'Account Management', 'todo', v_initial_due_date, 'low');

  select actor_id into v_actor_check from public.task_events where task_id = v_task4_id and event_type = 'created';
  if v_actor_check is distinct from v_creator_id then
    raise exception 'TEST_FAILED: scenario 16 — a created event with no auth context must fall back to created_by (%), got %.', v_creator_id, v_actor_check;
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all task_events scenarios passed; rolling back every fabricated change.';
end $$;
