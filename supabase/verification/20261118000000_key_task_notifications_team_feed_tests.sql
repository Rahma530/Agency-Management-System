-- Verification for 20261118000000_key_task_notifications_team_feed.sql.
--
-- Single DO block, distinct real personas, ends in a raised exception so every change (test
-- tasks, their assignees, status updates, and the one temporary constraint used in scenario 6)
-- is rolled back regardless of outcome: TEST_OK_ROLLED_BACK on success, a descriptive
-- TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
--
-- Every impersonation sets request.jwt.claims to {"sub": ..., "role": "authenticated"} and
-- self-checks auth.role() right after switching Postgres role, per this session's established
-- pattern — kept here for consistency even though none of the functions under test read
-- auth.role() directly; a TEST_SETUP_FAILED here means the impersonation itself didn't take
-- effect, not that the feature under test is wrong.
--
-- Every exception handler below re-raises unconditionally on its own TEST_FAILED/TEST_SETUP_FAILED
-- marker BEFORE checking the real rejection text, so a bug that lets a rejected operation silently
-- succeed can never be mistaken for a pass via a loose substring match.
--
-- Notifications have no task_id column of their own, so every check below filters by
-- message LIKE '%' || <this test's unique task title> || '%' — each test task's title embeds a
-- fresh random suffix, making that filter precise regardless of whatever real historical
-- notification rows already exist for these same real persona accounts.
do $$
declare
  v_client_id text;
  v_admin_id text;
  v_admin_auth uuid;
  v_am_tl_id text;
  v_am_tl_auth uuid;
  v_am_tl_team text;
  v_creator_id text;
  v_creator_auth uuid;
  v_assignee_id text;
  v_assignee_auth uuid;
  v_other_tl_id text;
  v_other_tl_auth uuid;
  v_seo_assignee_id text;
  v_graphic_designer_id text;
  v_task1_title text := 'ZZ key-notif test 1 ' || substr(md5(random()::text), 1, 8);
  v_task2_title text := 'ZZ key-notif test 2 ' || substr(md5(random()::text), 1, 8);
  v_task3_title text := 'ZZ key-notif test 3 ' || substr(md5(random()::text), 1, 8);
  v_task4_title text := 'ZZ key-notif test 4 ' || substr(md5(random()::text), 1, 8);
  v_task5_title text := 'ZZ key-notif test 5 ' || substr(md5(random()::text), 1, 8);
  v_task6_title text := 'ZZ key-notif test 6 ' || substr(md5(random()::text), 1, 8);
  v_task1_id text := 'zz_notif_1_' || substr(md5(random()::text), 1, 8);
  v_task2_id text := 'zz_notif_2_' || substr(md5(random()::text), 1, 8);
  v_task3_id text := 'zz_notif_3_' || substr(md5(random()::text), 1, 8);
  v_task4_id text := 'zz_notif_4_' || substr(md5(random()::text), 1, 8);
  v_task5_id text := 'zz_notif_5_' || substr(md5(random()::text), 1, 8);
  v_task6_id text := 'zz_notif_6_' || substr(md5(random()::text), 1, 8);
  v_count integer;
  v_status text;
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

  select id, auth_id, team into v_am_tl_id, v_am_tl_auth, v_am_tl_team from public.users
  where role = 'am_team_lead' and auth_id is not null and deactivated_at is null and team is not null
  limit 1;
  if v_am_tl_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_team_lead persona (with a team) found.';
  end if;

  select id, auth_id into v_creator_id, v_creator_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
    and team = v_am_tl_team and id <> v_admin_id and id <> v_am_tl_id
  limit 1;
  if v_creator_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_agent on the same team as the am_team_lead found, for the creator.';
  end if;

  select id, auth_id into v_assignee_id, v_assignee_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
    and team = v_am_tl_team and id <> v_admin_id and id <> v_am_tl_id and id <> v_creator_id
  limit 1;
  if v_assignee_id is null then
    raise exception 'TEST_SETUP_FAILED: need a second active am_agent on the same team, for the assignee.';
  end if;

  select id, auth_id into v_other_tl_id, v_other_tl_auth from public.users
  where role = 'seo_team_lead' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_am_tl_id and id <> v_creator_id and id <> v_assignee_id
  limit 1;
  if v_other_tl_id is null then
    raise exception 'TEST_SETUP_FAILED: no active seo_team_lead persona found, for the unrelated-team check.';
  end if;

  select id into v_seo_assignee_id from public.users
  where role = 'seo_agent' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_am_tl_id and id <> v_creator_id and id <> v_assignee_id and id <> v_other_tl_id
  limit 1;
  if v_seo_assignee_id is null then
    raise exception 'TEST_SETUP_FAILED: no active seo_agent persona found.';
  end if;

  select id into v_graphic_designer_id from public.users
  where role = 'graphic_designer' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_graphic_designer_id is null then
    raise exception 'TEST_SETUP_FAILED: no active graphic_designer persona found.';
  end if;

  -- ======================================================================
  -- Setup: task1, created by v_creator (am_agent, same team as v_am_tl), assigned to v_assignee
  -- (am_agent, same team).
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
  -- Scenario 1 + 3: v_assignee moves task1 todo -> in_review (a key transition: reaching
  -- in_review). Must notify: admin, and v_am_tl (the am_agent's supervisor). Must NOT notify:
  -- v_other_tl (seo_team_lead — unrelated, no seo_agent assigned yet), or the actor (v_assignee)
  -- about their own action.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_assignee_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 1).';
  end if;
  update public.tasks set status = 'in_review' where id = v_task1_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.notifications
  where user_id = v_admin_id and type = 'task_updated' and message like '%' || v_task1_title || '%';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 1 — expected exactly one admin notification for task1''s in_review transition, got %.', v_count;
  end if;

  select count(*) into v_count from public.notifications
  where user_id = v_am_tl_id and type = 'task_updated' and message like '%' || v_task1_title || '%';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 1 — expected exactly one am_team_lead notification for task1''s in_review transition, got %.', v_count;
  end if;

  select count(*) into v_count from public.notifications
  where user_id = v_other_tl_id and message like '%' || v_task1_title || '%';
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 1 — an unrelated team''s lead must not be notified, got %.', v_count;
  end if;

  select count(*) into v_count from public.notifications
  where user_id = v_assignee_id and message like '%' || v_task1_title || '%';
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 3 — the actor must never be notified about their own action, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 2: a non-key transition (todo -> in_progress, on a second task) must notify no one.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (task2 setup).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task2_id, v_client_id, v_task2_title, 'test', v_creator_id, 'Account Management', 'todo', current_date + 5, 'low');
  update public.tasks set status = 'in_progress' where id = v_task2_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.notifications where message like '%' || v_task2_title || '%';
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 2 — a non-key transition (todo -> in_progress) must notify no one, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 4: add a seo_agent as a second assignee on task1, then v_am_tl (not v_assignee this
  -- time) moves it in_review -> completed (reaching completed, also a key transition). Must now
  -- ALSO notify v_other_tl (seo_team_lead — the seo_agent's supervisor), and must NOT notify
  -- v_am_tl about their own action this time, even though they're normally a valid recipient for
  -- an am_agent-role transition.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (task1 second assignee).';
  end if;
  perform public.set_task_assignees(v_task1_id, array[v_assignee_id, v_seo_assignee_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_am_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 4).';
  end if;
  update public.tasks set status = 'completed' where id = v_task1_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.notifications
  where user_id = v_other_tl_id and type = 'task_updated' and message like '%' || v_task1_title || '%';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — expected exactly one seo_team_lead notification once a seo_agent is assigned, got %.', v_count;
  end if;

  select count(*) into v_count from public.notifications
  where user_id = v_am_tl_id and type = 'task_updated' and message like '%' || v_task1_title || '%'
    and message like '%Completed%';
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 4 — v_am_tl must not be notified about their own completed transition, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 5: a key transition on a task assigned ONLY to a graphic_designer (no supervisor
  -- role covers them) must notify the admin only — no team lead at all.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (task3 setup).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task3_id, v_client_id, v_task3_title, 'test', v_creator_id, 'Creative & Design', 'todo', current_date + 5, 'low');
  perform public.set_task_assignees(v_task3_id, array[v_graphic_designer_id]);
  update public.tasks set status = 'blocked' where id = v_task3_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.notifications
  where user_id = v_admin_id and type = 'task_updated' and message like '%' || v_task3_title || '%';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 5 — expected exactly one admin notification for the graphic_designer task''s blocked transition, got %.', v_count;
  end if;

  select count(*) into v_count from public.notifications
  where user_id in (v_am_tl_id, v_other_tl_id) and message like '%' || v_task3_title || '%';
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 5 — no team lead has a supervisor role for graphic_designer; expected zero TL notifications, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 7: team_task_activity_feed() — scoping, admin, rejection, and the p_limit clamp.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_am_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 7a).';
  end if;
  select count(*) into v_count from public.team_task_activity_feed(100, null) where task_id = v_task1_id;
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count = 0 then
    raise exception 'TEST_FAILED: scenario 7a — v_am_tl must see task1''s events (an am_agent is assigned to it).';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_am_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 7b).';
  end if;
  select count(*) into v_count from public.team_task_activity_feed(100, null) where task_id = v_task3_id;
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 7b — v_am_tl must not see task3''s events (only a graphic_designer is assigned), got %.', v_count;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_other_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 7c).';
  end if;
  select count(*) into v_count from public.team_task_activity_feed(100, null) where task_id = v_task1_id;
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count = 0 then
    raise exception 'TEST_FAILED: scenario 7c — v_other_tl (seo_team_lead) must see task1''s events now that a seo_agent is assigned.';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 7d).';
  end if;
  select count(*) into v_count from public.team_task_activity_feed(100, null) where task_id = v_task3_id;
  if v_count = 0 then
    raise exception 'TEST_FAILED: scenario 7d — an admin must see every task''s events, including the graphic_designer-only task3.';
  end if;

  select count(*) into v_count from public.team_task_activity_feed(1000, null);
  if v_count > 100 then
    raise exception 'TEST_FAILED: scenario 7e — p_limit=1000 must still be clamped to at most 100 rows, got %.', v_count;
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_assignee_auth, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.role() is distinct from 'authenticated' then
      raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 7f).';
    end if;
    perform public.team_task_activity_feed(10, null);
    raise exception 'TEST_FAILED: scenario 7f — an ordinary am_agent must not be able to call team_task_activity_feed().';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' or sqlerrm like 'TEST_SETUP_FAILED%' then
      raise;
    end if;
    if sqlerrm is distinct from 'You are not permitted to view the team activity feed.' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 8: a revision (in_review -> in_progress) performed by v_am_tl themself. Must notify
  -- the admin exactly once, with the revision-specific title — and must NOT notify v_am_tl about
  -- their own action, even though v_am_tl would normally be the right recipient for an am_agent
  -- assignee's revision (task_supervisor_role('am_agent') = 'am_team_lead'): they're excluded here
  -- purely because they are this event's own actor, same exclusion already proven in scenario 3.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (task5 setup).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task5_id, v_client_id, v_task5_title, 'test', v_creator_id, 'Account Management', 'todo', current_date + 5, 'low');
  perform public.set_task_assignees(v_task5_id, array[v_assignee_id]);
  update public.tasks set status = 'in_review' where id = v_task5_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_am_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 8).';
  end if;
  update public.tasks set status = 'in_progress' where id = v_task5_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.notifications
  where user_id = v_admin_id and type = 'task_updated' and title = 'Task Sent Back for Revision'
    and message like '%' || v_task5_title || '%';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 8 — expected exactly one admin ''Task Sent Back for Revision'' notification for task5''s revision, got %.', v_count;
  end if;

  select count(*) into v_count from public.notifications
  where user_id = v_am_tl_id and title = 'Task Sent Back for Revision' and message like '%' || v_task5_title || '%';
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 8 — v_am_tl must not be notified about their own revision action, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 9: reaching closed (todo -> closed directly, by the task's own creator) must notify
  -- the admin exactly once. No assignee is given at all, so this also exercises the "zero
  -- current assignees" path through task_supervisor_role's EXISTS subquery (no TL recipient, same
  -- underlying reasoning scenario 5 already proved for an unsupervised role, here for none at all).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 9).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task6_id, v_client_id, v_task6_title, 'test', v_creator_id, 'Account Management', 'todo', current_date + 5, 'low');
  update public.tasks set status = 'closed' where id = v_task6_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.notifications
  where user_id = v_admin_id and type = 'task_updated' and title = 'Task Closed' and message like '%' || v_task6_title || '%';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 9 — expected exactly one admin ''Task Closed'' notification for task6''s closed transition, got %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 6: a forced failure inside the trigger — a temporary, NOT VALID check constraint,
  -- built via a dynamically formatted LIKE pattern (%L) so it rejects ONLY a notifications row
  -- whose message mentions this one test's own task4 title, never any other, unrelated
  -- notification insert that might be happening concurrently while this test runs. Placed last,
  -- immediately before the final rollback-raise below, so every earlier scenario's own
  -- notification inserts (above) are never at risk from this constraint's own window — must not
  -- block the task's own status update.
  -- ======================================================================
  execute format(
    'alter table public.notifications add constraint zz_force_notify_failure check (message not like %L) not valid',
    '%' || v_task4_title || '%'
  );

  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (task4 setup).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task4_id, v_client_id, v_task4_title, 'test', v_creator_id, 'Account Management', 'todo', current_date + 5, 'low');
  update public.tasks set status = 'in_review' where id = v_task4_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  alter table public.notifications drop constraint zz_force_notify_failure;

  select status into v_status from public.tasks where id = v_task4_id;
  if v_status is distinct from 'in_review' then
    raise exception 'TEST_FAILED: scenario 6 — the status update must succeed even though the trigger''s own notification insert was forced to fail, got status %.', v_status;
  end if;

  select count(*) into v_count from public.notifications where message like '%' || v_task4_title || '%';
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 6 — the forced constraint should have rejected every notification insert for task4, got %.', v_count;
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all key_task_notifications_team_feed scenarios passed; rolling back every fabricated change.';
end $$;
