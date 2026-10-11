-- ============================================================================
-- Manual verification for 20261103000000_task_assignees_foundation.sql.
-- NOT a migration — lives outside supabase/migrations/ on purpose so no tool ever applies it
-- automatically. Paste this whole block into the Supabase SQL Editor and run it AFTER applying
-- the migration, as a role that can `set local role authenticated` and `reset role` (the SQL
-- Editor's own connection role qualifies).
--
-- Nothing this script does persists. The final `raise exception 'TEST_OK_ROLLED_BACK: ...'`
-- intentionally aborts the implicit transaction wrapping the whole DO block, which rolls back
-- every insert/update/delete performed above it (the fabricated task, its task_assignees/
-- task_assignee_log rows, everything) — a result reading "TEST_OK_ROLLED_BACK: ..." IS the
-- success signal, not a real error. Any other raised message starting "TEST_FAILED:" or
-- "TEST_SETUP_FAILED:" means something is wrong; read the message for which check failed.
--
-- Preconditions this script assumes (true of every real project this app runs against):
--   - at least one active (deactivated_at is null) employee with a non-null auth_id and
--     role <> 'sales' (used as creator + first assignee)
--   - at least one more active employee with a non-null auth_id, distinct from the first
--   - at least one active employee with role = 'sales' and a non-null auth_id (the deterministic
--     "must NOT see this task" probe — task_visible() excludes sales unconditionally, so this
--     doesn't depend on any team/department specifics of live data)
--   - at least one row in public.clients
-- ============================================================================
do $$
declare
  v_creator_id text;
  v_creator_auth_id uuid;
  v_sales_auth_id uuid;
  v_other_user_id text;
  v_client_id text;
  v_task_id text := 'zz_verify_task_' || substr(md5(random()::text), 1, 8);
  v_count int;
  v_backfill_expected int;
  v_backfill_actual int;
begin
  -- Run setup as the admin/service connection (bypasses RLS) so these lookups are unfiltered.
  reset role;

  select id, auth_id into v_creator_id, v_creator_auth_id
  from public.users
  where auth_id is not null and deactivated_at is null and role <> 'sales'
  limit 1;
  if v_creator_id is null then
    raise exception 'TEST_SETUP_FAILED: no active non-sales user with auth_id found to run this test as.';
  end if;

  select auth_id into v_sales_auth_id
  from public.users
  where auth_id is not null and deactivated_at is null and role = 'sales'
  limit 1;
  if v_sales_auth_id is null then
    raise exception 'TEST_SETUP_FAILED: no active sales user with auth_id found for the visibility-exclusion probe.';
  end if;

  select id into v_other_user_id
  from public.users
  where auth_id is not null and deactivated_at is null and id <> v_creator_id
  limit 1;
  if v_other_user_id is null then
    raise exception 'TEST_SETUP_FAILED: need at least 2 distinct active users with auth_id.';
  end if;

  select id into v_client_id from public.clients limit 1;
  if v_client_id is null then
    raise exception 'TEST_SETUP_FAILED: no client row found to attach the test task to.';
  end if;

  -- --------------------------------------------------------------------
  -- 1. Backfill count: every task with assigned_to is not null has a task_assignees row
  --    (>= rather than = so this still holds if other rows were added since backfill ran).
  -- --------------------------------------------------------------------
  select count(*) into v_backfill_expected from public.tasks where assigned_to is not null;
  select count(*) into v_backfill_actual from public.task_assignees;
  if v_backfill_actual < v_backfill_expected then
    raise exception 'TEST_FAILED: backfill undercount — tasks.assigned_to is not null count=%, task_assignees row count=%',
      v_backfill_expected, v_backfill_actual;
  end if;

  -- --------------------------------------------------------------------
  -- 2. INSERT with assigned_to creates exactly one task_assignees row.
  -- --------------------------------------------------------------------
  insert into public.tasks
    (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority)
  values
    (v_task_id, v_client_id, 'ZZ verify task', 'ZZ verify — rolled back', v_creator_id, v_creator_id, 'ZZ', 'todo', current_date, 'low');

  select count(*) into v_count from public.task_assignees where task_id = v_task_id and user_id = v_creator_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: insert-time sync did not create exactly 1 task_assignees row (got %).', v_count;
  end if;

  select count(*) into v_count from public.task_assignee_log where task_id = v_task_id and action = 'added';
  if v_count <> 1 then
    raise exception 'TEST_FAILED: insert-time sync did not log exactly 1 "added" row (got %).', v_count;
  end if;

  -- --------------------------------------------------------------------
  -- 3. Changing assigned_to removes the old row, adds the new one, logs 2 more rows
  --    (1 removed + 1 added, on top of the 1 "added" from the insert above).
  -- --------------------------------------------------------------------
  update public.tasks set assigned_to = v_other_user_id, assignee_viewed_at = null where id = v_task_id;

  select count(*) into v_count from public.task_assignees where task_id = v_task_id and user_id = v_creator_id;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: old assignee row still present after reassignment (got % rows).', v_count;
  end if;

  select count(*) into v_count from public.task_assignees where task_id = v_task_id and user_id = v_other_user_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: new assignee row missing after reassignment (got % rows).', v_count;
  end if;

  select count(*) into v_count from public.task_assignee_log where task_id = v_task_id;
  if v_count <> 3 then
    raise exception 'TEST_FAILED: expected 3 total log rows after insert + reassignment (1 added, 1 removed, 1 added), got %.', v_count;
  end if;

  -- --------------------------------------------------------------------
  -- 4. Setting assigned_to to null removes the row and adds no new one.
  -- --------------------------------------------------------------------
  update public.tasks set assigned_to = null where id = v_task_id;

  select count(*) into v_count from public.task_assignees where task_id = v_task_id;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: task_assignees row still present after assigned_to set to null (got % rows).', v_count;
  end if;

  -- Restore an assignee (the creator) for the visibility tests below.
  update public.tasks set assigned_to = v_creator_id, assignee_viewed_at = null where id = v_task_id;

  -- --------------------------------------------------------------------
  -- 5. Visibility: the task's own assignee can SELECT their task_assignees row under RLS.
  -- --------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_creator_auth_id)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.task_assignees where task_id = v_task_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: the task''s own assignee could not see their task_assignees row under RLS (got % rows).', v_count;
  end if;

  -- --------------------------------------------------------------------
  -- 6. Writes to task_assignees must be rejected outright (no INSERT/UPDATE/DELETE grant) while
  --    still authenticated as the assignee above.
  -- --------------------------------------------------------------------
  begin
    insert into public.task_assignees (task_id, user_id) values (v_task_id, v_creator_id);
    raise exception 'TEST_FAILED: INSERT on task_assignees succeeded as authenticated — expected insufficient_privilege (no grant).';
  exception when insufficient_privilege then
    null; -- expected
  end;

  begin
    update public.task_assignees set viewed_at = now() where task_id = v_task_id;
    raise exception 'TEST_FAILED: UPDATE on task_assignees succeeded as authenticated — expected insufficient_privilege (no grant).';
  exception when insufficient_privilege then
    null; -- expected
  end;

  begin
    delete from public.task_assignees where task_id = v_task_id;
    raise exception 'TEST_FAILED: DELETE on task_assignees succeeded as authenticated — expected insufficient_privilege (no grant).';
  exception when insufficient_privilege then
    null; -- expected
  end;

  -- Reset claims/role before switching personas — never leave a narrowed role/claim active
  -- across a persona switch or before the plain admin-role reads/updates that follow.
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- --------------------------------------------------------------------
  -- 7. Visibility exclusion: a 'sales' caller can never see a task_assignees row, regardless of
  --    which task it is — task_visible() excludes app_user_role() = 'sales' unconditionally, so
  --    this holds without depending on any team/department specifics of live data.
  -- --------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_auth_id)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.task_assignees where task_id = v_task_id;
  if v_count <> 0 then
    raise exception 'TEST_FAILED: a sales-role caller could see a task_assignees row (got % rows) — task_visible() should exclude sales unconditionally.', v_count;
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- --------------------------------------------------------------------
  -- All checks passed. Force a rollback so nothing performed above persists.
  -- --------------------------------------------------------------------
  raise exception 'TEST_OK_ROLLED_BACK: all task_assignees foundation checks passed (backfill, insert sync, reassignment sync + log, null-clears-row, assignee can SELECT, writes rejected, sales excluded). Nothing persisted.';
end $$;
