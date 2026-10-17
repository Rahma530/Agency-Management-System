-- Verification for 20261120000000_auto_daily_log_from_delivered_task.sql.
--
-- Single DO block, real personas, ends in a raised exception so every fabricated change (test
-- client, task, task_assignees row, daily_logs rows, and the one temporary CHECK constraint used
-- to force an insert failure) is rolled back regardless of outcome: TEST_OK_ROLLED_BACK on
-- success, a descriptive TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
--
-- Every impersonation sets request.jwt.claims to {"sub": ..., "role": "authenticated"} and
-- self-checks auth.role() right after switching Postgres role, per this session's established
-- pattern. The test client/task/task_assignees setup rows are inserted directly (no role switch)
-- — this DO block runs as the connecting owner/superuser role, which RLS never applies to, and
-- what's under test is the AFTER UPDATE trigger's own logic, not tasks/task_assignees RLS.
do $$
declare
  v_assignee_id text;       -- the delivered task's assignee — ui_designer (a department role
                             -- task_assignees/tasks already support without extra setup)
  v_assignee_auth uuid;
  v_am_agent_id text;       -- set as the test client's am_agent_id; also used as created_by
  v_am_agent_auth uuid;
  v_unrelated_id text;      -- not a direct report of anyone involved, not this client's am_agent
  v_unrelated_auth uuid;
  v_exec_id text;           -- delete_tasks() is executive/head_of_technical/ai_engineer only
  v_exec_auth uuid;
  v_app_role text;
  v_client_id text := 'zz_dlog_c_' || substr(md5(random()::text), 1, 8);
  v_task_id text := 'zz_dlog_t_' || substr(md5(random()::text), 1, 8);
  v_task2_id text := 'zz_dlog_t2_' || substr(md5(random()::text), 1, 8);
  v_task3_id text := 'zz_dlog_t3_' || substr(md5(random()::text), 1, 8);
  v_task4_id text := 'zz_dlog_t4_' || substr(md5(random()::text), 1, 8);
  v_count integer;
  v_row_id text;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_status text;
  v_summary text;
  v_task_id_check text;
begin
  select id, auth_id into v_assignee_id, v_assignee_auth from public.users
  where role = 'ui_designer' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_assignee_id is null then
    raise exception 'TEST_SETUP_FAILED: no active ui_designer persona found.';
  end if;

  select id, auth_id into v_am_agent_id, v_am_agent_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_am_agent_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_agent persona found.';
  end if;

  select id, auth_id into v_unrelated_id, v_unrelated_auth from public.users
  where role = 'social_media_agent' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_unrelated_id is null then
    raise exception 'TEST_SETUP_FAILED: no active social_media_agent persona found.';
  end if;

  select id, auth_id into v_exec_id, v_exec_auth from public.users
  where role = 'executive' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_exec_id is null then
    raise exception 'TEST_SETUP_FAILED: no active executive persona found.';
  end if;

  insert into public.clients (id, name, status, am_agent_id)
  values (v_client_id, 'ZZ Daily Log Trigger Test Client', 'active', v_am_agent_id);

  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task_id, v_client_id, 'ZZ Daily Log Trigger Test Task', 'Testing the auto daily log trigger.', v_am_agent_id, 'creative', 'todo', current_date, 'medium');

  insert into public.task_assignees (task_id, user_id, added_by)
  values (v_task_id, v_assignee_id, v_am_agent_id);

  -- ======================================================================
  -- Scenario 1: delivery (todo -> in_review) creates exactly one auto_task row for the current
  -- assignee, with the expected date/linked_task_ids/client_id/source.
  -- ======================================================================
  update public.tasks set status = 'in_review' where id = v_task_id;

  select count(*) into v_count from public.daily_logs
  where task_id = v_task_id and user_id = v_assignee_id and source = 'auto_task';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 1 — expected exactly 1 auto_task row after delivery, found %.', v_count;
  end if;

  select id into v_row_id from public.daily_logs
  where task_id = v_task_id and user_id = v_assignee_id and source = 'auto_task';

  if not exists (
    select 1 from public.daily_logs
    where id = v_row_id
      and date = v_today
      and client_id = v_client_id
      and linked_task_ids = array[v_task_id]
  ) then
    raise exception 'TEST_FAILED: scenario 1 — auto row date/client_id/linked_task_ids do not match the delivered task.';
  end if;

  -- ======================================================================
  -- Scenario 2: no duplicate on the same day — a revision followed by a same-day re-delivery
  -- must not create a second row (ON CONFLICT DO NOTHING on (task_id, user_id, date)).
  -- ======================================================================
  update public.tasks set status = 'todo' where id = v_task_id;     -- revision
  update public.tasks set status = 'in_review' where id = v_task_id; -- re-delivered, same day

  select count(*) into v_count from public.daily_logs
  where task_id = v_task_id and user_id = v_assignee_id and source = 'auto_task';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 2 — same-day revision + re-delivery must not duplicate, found % rows.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 3: in_review -> completed must NOT add another row — old.status ('in_review') is
  -- already in the delivered set, so the trigger's own condition must not re-fire.
  -- ======================================================================
  update public.tasks set status = 'completed' where id = v_task_id;

  select count(*) into v_count from public.daily_logs
  where task_id = v_task_id and user_id = v_assignee_id and source = 'auto_task';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 3 — in_review -> completed must not insert another row, found % rows.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 4: a revision reviewed on a DIFFERENT day creates a NEW row. The live clock can't be
  -- moved, so this backdates the existing row's own `date` to yesterday first — the trigger then
  -- computes TODAY independently via now() at time zone 'Africa/Cairo', so a fresh revision +
  -- re-delivery cycle must land on today's date, a different (task_id, user_id, date) tuple, and
  -- therefore a second row rather than hitting the same ON CONFLICT target as scenario 1/2's row.
  -- ======================================================================
  update public.daily_logs set date = v_today - 1 where id = v_row_id;

  update public.tasks set status = 'todo' where id = v_task_id;       -- revision
  update public.tasks set status = 'in_review' where id = v_task_id;  -- re-delivered "today"

  select count(*) into v_count from public.daily_logs
  where task_id = v_task_id and user_id = v_assignee_id and source = 'auto_task';
  if v_count <> 2 then
    raise exception 'TEST_FAILED: scenario 4 — a revision re-delivered on a different day must create a new row, found % rows (expected 2).', v_count;
  end if;
  if not exists (select 1 from public.daily_logs where task_id = v_task_id and user_id = v_assignee_id and source = 'auto_task' and date = v_today) then
    raise exception 'TEST_FAILED: scenario 4 — the new row must be dated today, not the backdated day.';
  end if;

  -- ======================================================================
  -- Scenario 5: a later manual edit by the employee is not overwritten by the trigger. The
  -- employee (within the 7-day update window) edits today's auto row's summary_text, then another
  -- same-day revision + re-delivery cycle must leave that edit untouched (ON CONFLICT DO NOTHING
  -- never touches the existing row).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_assignee_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 5 edit).';
  end if;
  update public.daily_logs set summary_text = 'ZZ manually edited by the assignee.'
  where task_id = v_task_id and user_id = v_assignee_id and date = v_today;
  reset role; perform set_config('request.jwt.claims', '', true);

  update public.tasks set status = 'todo' where id = v_task_id;
  update public.tasks set status = 'in_review' where id = v_task_id;

  select summary_text into v_summary from public.daily_logs
  where task_id = v_task_id and user_id = v_assignee_id and date = v_today;
  if v_summary is distinct from 'ZZ manually edited by the assignee.' then
    raise exception 'TEST_FAILED: scenario 5 — the trigger must never overwrite an existing row''s manually edited summary_text, found: %.', v_summary;
  end if;

  select count(*) into v_count from public.daily_logs
  where task_id = v_task_id and user_id = v_assignee_id and source = 'auto_task';
  if v_count <> 2 then
    raise exception 'TEST_FAILED: scenario 5 — row count must stay at 2 (no extra insert), found %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 6: the status change itself must never fail even if the INSERT fails. A temporary
  -- CHECK(false) constraint (NOT VALID, so it only blocks NEW rows, not the two already inserted)
  -- forces every insert attempt to fail; the UPDATE on tasks must still succeed and the task's
  -- status must actually change, with only a WARNING raised internally.
  -- ======================================================================
  alter table public.daily_logs add constraint zz_dlog_force_fail_test check (false) not valid;

  update public.tasks set status = 'todo' where id = v_task_id;
  update public.tasks set status = 'in_review' where id = v_task_id;

  select status into v_status from public.tasks where id = v_task_id;
  if v_status is distinct from 'in_review' then
    raise exception 'TEST_FAILED: scenario 6 — the tasks UPDATE must succeed and the status must change even when the auto-insert fails, found status %.', v_status;
  end if;

  select count(*) into v_count from public.daily_logs
  where task_id = v_task_id and user_id = v_assignee_id and source = 'auto_task';
  if v_count <> 2 then
    raise exception 'TEST_FAILED: scenario 6 — the failed insert attempt must not have created a row, found % rows (expected still 2).', v_count;
  end if;

  alter table public.daily_logs drop constraint zz_dlog_force_fail_test;

  -- ======================================================================
  -- Scenario 7: a manual (source='manual') row is never touched by the trigger. Insert one for a
  -- SECOND, unrelated task, fire a delivery on that second task, and confirm the manual row is
  -- unchanged (still source='manual', no task_id link, same summary_text).
  -- ======================================================================
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task2_id, v_client_id, 'ZZ Daily Log Trigger Test Task 2', 'Second task — manual row isolation check.', v_am_agent_id, 'creative', 'todo', current_date, 'medium');
  insert into public.task_assignees (task_id, user_id, added_by)
  values (v_task2_id, v_assignee_id, v_am_agent_id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_assignee_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 7 setup).';
  end if;
  insert into public.daily_logs (id, user_id, date, summary_text, client_id)
  values ('zz_dlog_manual_' || substr(md5(random()::text), 1, 8), v_assignee_id, v_today, 'ZZ manual daily log, unrelated to any auto delivery.', v_client_id);
  reset role; perform set_config('request.jwt.claims', '', true);

  update public.tasks set status = 'in_review' where id = v_task2_id;

  if not exists (
    select 1 from public.daily_logs
    where user_id = v_assignee_id and client_id = v_client_id and source = 'manual'
      and summary_text = 'ZZ manual daily log, unrelated to any auto delivery.'
      and task_id is null
  ) then
    raise exception 'TEST_FAILED: scenario 7 — the pre-existing manual row must remain untouched (source/task_id/summary_text unchanged).';
  end if;

  -- ======================================================================
  -- Scenario 8: RLS — the assignee sees and can edit their own auto row within 7 days (the row is
  -- brand new, so it is well within daily_logs_update_own_rls's window).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_assignee_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 8 select).';
  end if;
  select count(*) into v_count from public.daily_logs where task_id = v_task_id and user_id = v_assignee_id;
  if v_count = 0 then
    raise exception 'TEST_FAILED: scenario 8 — the assignee must be able to see their own auto-created row.';
  end if;
  update public.daily_logs set summary_text = 'ZZ assignee re-edit within 7 days.'
  where task_id = v_task_id and user_id = v_assignee_id and date = v_today;
  reset role; perform set_config('request.jwt.claims', '', true);

  select summary_text into v_summary from public.daily_logs where task_id = v_task_id and user_id = v_assignee_id and date = v_today;
  if v_summary is distinct from 'ZZ assignee re-edit within 7 days.' then
    raise exception 'TEST_FAILED: scenario 8 — the assignee''s own edit within the 7-day window must have been applied.';
  end if;

  -- ======================================================================
  -- Scenario 9: RLS — the client's am_agent sees the auto row (daily_logs_select_rls's
  -- client_id-is-not-null + client_am_agent_is_caller branch).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_am_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 9).';
  end if;
  select count(*) into v_count from public.daily_logs where task_id = v_task_id and user_id = v_assignee_id;
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count = 0 then
    raise exception 'TEST_FAILED: scenario 9 — the client''s own am_agent must be able to see the auto row.';
  end if;

  -- ======================================================================
  -- Scenario 10: RLS — an unrelated employee (not a direct report of anyone involved, not this
  -- client's am_agent) must NOT see the auto row.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_unrelated_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 10).';
  end if;
  select count(*) into v_count from public.daily_logs where task_id = v_task_id and user_id = v_assignee_id;
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count <> 0 then
    raise exception 'TEST_FAILED: scenario 10 — an unrelated employee must not see this row, found % visible.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 11: a task with an EMPTY description (tasks.description is NOT NULL, so NULL itself
  -- is never a real value to test against — '' and a whitespace-only string are the two actual
  -- empty-description shapes that can occur live) must still produce a row, summary_text = title
  -- only, never NULL (string || NULL = NULL is exactly the bug coalesce/nullif/btrim guard against
  -- in the trigger function) and without a trailing blank line.
  -- ======================================================================
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task3_id, v_client_id, 'ZZ Daily Log Trigger Test Task 3 (empty description)', '', v_am_agent_id, 'creative', 'todo', current_date, 'medium');
  insert into public.task_assignees (task_id, user_id, added_by)
  values (v_task3_id, v_assignee_id, v_am_agent_id);

  update public.tasks set status = 'in_review' where id = v_task3_id;

  select summary_text into v_summary from public.daily_logs
  where task_id = v_task3_id and user_id = v_assignee_id and source = 'auto_task';
  if v_summary is null then
    raise exception 'TEST_FAILED: scenario 11 — summary_text must not be NULL when description is an empty string.';
  end if;
  if v_summary is distinct from 'ZZ Daily Log Trigger Test Task 3 (empty description)' then
    raise exception 'TEST_FAILED: scenario 11 — summary_text must be the title alone (no trailing newline/description) when description is '''', found: %.', v_summary;
  end if;

  -- Whitespace-only description must be treated the same as empty — btrim() is what makes this
  -- indistinguishable from the '' case above. The existing row is backdated first (same trick as
  -- scenario 4) so the next revision + re-delivery lands on a fresh (task_id, user_id, date)
  -- tuple instead of hitting ON CONFLICT DO NOTHING against today's already-inserted row.
  update public.daily_logs set date = v_today - 1
  where task_id = v_task3_id and user_id = v_assignee_id and source = 'auto_task';

  update public.tasks set description = '   ' where id = v_task3_id;
  update public.tasks set status = 'todo' where id = v_task3_id;
  update public.tasks set status = 'in_review' where id = v_task3_id;

  select summary_text into v_summary from public.daily_logs
  where task_id = v_task3_id and user_id = v_assignee_id and source = 'auto_task' and date = v_today;
  if v_summary is null then
    raise exception 'TEST_FAILED: scenario 11b — summary_text must not be NULL when description is whitespace-only.';
  end if;
  if v_summary is distinct from 'ZZ Daily Log Trigger Test Task 3 (empty description)' then
    raise exception 'TEST_FAILED: scenario 11b — summary_text must be the title alone when description is whitespace-only, found: %.', v_summary;
  end if;

  -- ======================================================================
  -- Scenario 12: deleting a task that has an auto-created daily_logs row must succeed (the FK is
  -- ON DELETE SET NULL, not RESTRICT), the daily_logs row itself must survive, and its task_id
  -- must become NULL.
  -- ======================================================================
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task4_id, v_client_id, 'ZZ Daily Log Trigger Test Task 4 (delete)', 'Delete-cascade check.', v_am_agent_id, 'creative', 'todo', current_date, 'medium');
  insert into public.task_assignees (task_id, user_id, added_by)
  values (v_task4_id, v_assignee_id, v_am_agent_id);
  update public.tasks set status = 'in_review' where id = v_task4_id;

  select id into v_row_id from public.daily_logs
  where task_id = v_task4_id and user_id = v_assignee_id and source = 'auto_task';
  if v_row_id is null then
    raise exception 'TEST_SETUP_FAILED: scenario 12 — expected an auto_task row before testing delete.';
  end if;

  -- delete_tasks() reads app_user_id() internally (deletion_log.deleted_by is NOT NULL) and
  -- gates on app_user_role() being executive/head_of_technical/ai_engineer — calling it with no
  -- impersonation leaves both NULL (no auth.uid() match), so app_user_id() is NULL and the
  -- deletion_log INSERT fails NOT NULL. Only the delete_tasks() CALL itself runs impersonated as
  -- a real executive — the fabricated setup rows above were all inserted as the connecting
  -- owner/superuser role on purpose (not under test here), per this session's own convention of
  -- never impersonating for rows that aren't the thing being exercised.
  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 12 delete).';
  end if;
  select public.app_user_role() into v_app_role;
  if v_app_role is distinct from 'executive' then
    raise exception 'TEST_SETUP_FAILED: app_user_role() must read ''executive'' for the impersonated caller (scenario 12 delete), found %.', v_app_role;
  end if;
  perform public.delete_tasks(array[v_task4_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  if not exists (select 1 from public.daily_logs where id = v_row_id) then
    raise exception 'TEST_FAILED: scenario 12 — the daily_logs row must survive the task''s deletion (ON DELETE SET NULL, not CASCADE).';
  end if;

  select task_id into v_task_id_check from public.daily_logs where id = v_row_id;
  if v_task_id_check is not null then
    raise exception 'TEST_FAILED: scenario 12 — the surviving row''s task_id must become NULL after the task is deleted, found %.', v_task_id_check;
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all auto_daily_log_from_delivered_task scenarios passed; rolling back every fabricated change.';
exception when others then
  if sqlerrm like 'TEST_OK_ROLLED_BACK%' or sqlerrm like 'TEST_FAILED%' or sqlerrm like 'TEST_SETUP_FAILED%' then
    raise;
  end if;
  -- An unexpected error (e.g. mid-scenario failure while the force-fail constraint from scenario
  -- 6 is still attached) must not leave that constraint behind — drop it defensively before
  -- re-raising, since the whole DO block's writes are rolled back anyway but a leftover DDL
  -- object on a real table would not be.
  alter table public.daily_logs drop constraint if exists zz_dlog_force_fail_test;
  raise;
end $$;
