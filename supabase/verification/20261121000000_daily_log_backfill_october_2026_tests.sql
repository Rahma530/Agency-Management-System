-- Verification for 20261121000000_daily_log_backfill_october_2026.sql.
--
-- Single DO block, real personas, ends in a raised exception so every fabricated row (test
-- client/tasks/task_assignees/daily_logs) is rolled back regardless of outcome: TEST_OK_ROLLED_BACK
-- on success, a descriptive TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
--
-- The backfill's own INSERT...SELECT is reproduced here verbatim (same CTEs, same NOT EXISTS
-- guard, same ON CONFLICT target), with one addition: `and t.id = any(v_task_ids)` on the
-- qualifying_tasks CTE, so this test only ever touches the fake tasks it creates below — never
-- any real task row, even though the whole DO block rolls back regardless. The actual forward
-- migration has no such restriction and is never run from this session against prod, per
-- instructions.
--
-- The one impersonation below (scenario 1's self-check) follows this session's established
-- JWT-claims/auth.role() pattern even though the backfill INSERT itself runs unimpersonated (as
-- the connecting owner/superuser role, same posture as every other verification script's direct
-- setup inserts) — it exists to confirm a real employee's own backfilled row is immediately
-- theirs under the existing, unchanged daily_logs RLS policies, not to test the INSERT's
-- permissions (the backfill is a plain migration statement, not an RPC with its own gate).
do $$
declare
  v_assignee1_id text;
  v_assignee1_auth uuid;
  v_assignee2_id text;
  v_am_agent_id text;
  v_client_id text := 'zz_bf_c_' || substr(md5(random()::text), 1, 8);
  v_task_oct_id text := 'zz_bf_t1_' || substr(md5(random()::text), 1, 8);
  v_task_sep_id text := 'zz_bf_t2_' || substr(md5(random()::text), 1, 8);
  v_task_closed_id text := 'zz_bf_t3_' || substr(md5(random()::text), 1, 8);
  v_task_linked_id text := 'zz_bf_t4_' || substr(md5(random()::text), 1, 8);
  v_task_ids text[];
  v_count integer;
  v_row_id text;
begin
  select id, auth_id into v_assignee1_id, v_assignee1_auth from public.users
  where role = 'ui_designer' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_assignee1_id is null then
    raise exception 'TEST_SETUP_FAILED: no active ui_designer persona found.';
  end if;

  select id into v_assignee2_id from public.users
  where role = 'social_media_agent' and auth_id is not null and deactivated_at is null and id <> v_assignee1_id
  limit 1;
  if v_assignee2_id is null then
    raise exception 'TEST_SETUP_FAILED: no second active persona (social_media_agent) found.';
  end if;

  select id into v_am_agent_id from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_am_agent_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_agent persona found.';
  end if;

  v_task_ids := array[v_task_oct_id, v_task_sep_id, v_task_closed_id, v_task_linked_id];

  insert into public.clients (id, name, status, am_agent_id)
  values (v_client_id, 'ZZ Backfill Test Client', 'active', v_am_agent_id);

  -- delivered_at is entirely trigger-owned (track_delivery_and_revisions(),
  -- 20261112000000_in_review_not_workload.sql's own header comment: "it cannot be set directly by
  -- any UPDATE") — it is ALWAYS stamped to the real now() on a real transition and restored
  -- (`new.delivered_at := old.delivered_at`) on every other UPDATE, including one that names
  -- delivered_at in its own SET list. There is no way to backdate it through ordinary DML, so the
  -- trigger is disabled for this block's setup only, and re-enabled immediately after — needed
  -- here specifically to construct a fixed pre-cutoff date (scenario 2) and a historical delivery
  -- date generally; every row this creates is rolled back with the rest of this transaction.
  alter table public.tasks disable trigger tasks_track_delivery_and_revisions_trigger;

  -- Every delivered_at literal below is written as a Cairo LOCAL wall-clock time, converted via
  -- `at time zone 'Africa/Cairo'` rather than a hardcoded '+02:00' offset — Cairo observes DST in
  -- summer (+03:00), so a fixed '+02:00' literal is wrong for part of the year. The bug this fixes:
  -- '2026-09-30T23:59:00+02:00'::timestamptz was being interpreted as 2026-10-01 00:59 Cairo LOCAL
  -- time (one hour later than the literal's own date suggests) whenever Cairo is actually at
  -- +03:00, pushing it past the backfill's October 1 cutoff and failing scenario 2. Converting the
  -- local timestamp through its IANA zone name instead always resolves to the correct UTC instant
  -- for whatever offset actually applies on that date.

  -- Task 1: delivered in October 2026 (Cairo), two assignees via task_assignees — scenario 1.
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority, delivered_at)
  values (v_task_oct_id, v_client_id, 'ZZ Backfill October Task', 'Delivered in October.', v_am_agent_id, 'creative', 'in_review', current_date, 'medium', ('2026-10-15 10:00:00'::timestamp at time zone 'Africa/Cairo'));
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_oct_id, v_assignee1_id, v_am_agent_id);
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_oct_id, v_assignee2_id, v_am_agent_id);

  -- Task 2: delivered BEFORE October 2026 — scenario 2 (must never be backfilled).
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority, delivered_at)
  values (v_task_sep_id, v_client_id, 'ZZ Backfill September Task', 'Delivered before cutoff.', v_am_agent_id, 'creative', 'in_review', current_date, 'medium', ('2026-09-30 23:59:00'::timestamp at time zone 'Africa/Cairo'));
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_sep_id, v_assignee1_id, v_am_agent_id);

  -- Task 3: closed, delivered in October — scenario 3 (closed is excluded by the status filter).
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority, delivered_at)
  values (v_task_closed_id, v_client_id, 'ZZ Backfill Closed Task', 'Closed, not in_review/completed.', v_am_agent_id, 'creative', 'closed', current_date, 'medium', ('2026-10-10 10:00:00'::timestamp at time zone 'Africa/Cairo'));
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_closed_id, v_assignee1_id, v_am_agent_id);

  -- Task 4: delivered in October, but the assignee already manually linked it on a DIFFERENT date
  -- — scenario 4 (must be skipped entirely, regardless of the manual log's own date).
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority, delivered_at)
  values (v_task_linked_id, v_client_id, 'ZZ Backfill Already Linked Task', 'Manually linked on a different day.', v_am_agent_id, 'creative', 'in_review', current_date, 'medium', ('2026-10-20 10:00:00'::timestamp at time zone 'Africa/Cairo'));
  insert into public.task_assignees (task_id, user_id, added_by) values (v_task_linked_id, v_assignee1_id, v_am_agent_id);
  insert into public.daily_logs (id, user_id, date, summary_text, linked_task_ids, client_id, source)
  values ('zz_bf_manual_' || substr(md5(random()::text), 1, 8), v_assignee1_id, date '2026-10-05', 'Manually logged on a different day.', array[v_task_linked_id], v_client_id, 'manual');

  alter table public.tasks enable trigger tasks_track_delivery_and_revisions_trigger;

  -- ======================================================================
  -- Run the backfill's own INSERT...SELECT, scoped to only these 4 fake tasks.
  -- ======================================================================
  with qualifying_tasks as (
    select t.id as task_id, t.client_id, t.title, t.description, t.delivered_at, t.assigned_to
    from public.tasks t
    where t.status in ('in_review', 'completed')
      and t.delivered_at is not null
      and (t.delivered_at at time zone 'Africa/Cairo')::date >= date '2026-10-01'
      and t.id = any(v_task_ids)
  ),
  assignees as (
    select
      qt.task_id, qt.client_id, qt.title, qt.description, qt.delivered_at,
      coalesce(
        (select array_agg(distinct ta.user_id) from public.task_assignees ta where ta.task_id = qt.task_id),
        case when qt.assigned_to is not null then array[qt.assigned_to] else array[]::text[] end
      ) as assignee_ids
    from qualifying_tasks qt
  ),
  expanded as (
    select a.task_id, a.client_id, a.title, a.description, a.delivered_at, u as user_id
    from assignees a, unnest(a.assignee_ids) as u
  )
  insert into public.daily_logs (id, user_id, date, summary_text, linked_task_ids, client_id, task_id, source)
  select
    'dlog-bf-' || md5(e.task_id || e.user_id || ((e.delivered_at at time zone 'Africa/Cairo')::date)::text),
    e.user_id,
    (e.delivered_at at time zone 'Africa/Cairo')::date,
    coalesce(e.title, '') || coalesce(E'\n' || nullif(btrim(e.description), ''), ''),
    array[e.task_id],
    e.client_id,
    e.task_id,
    'auto_task'
  from expanded e
  where not exists (
    select 1 from public.daily_logs dl
    where dl.user_id = e.user_id and e.task_id = any(dl.linked_task_ids)
  )
  on conflict (task_id, user_id, date) where task_id is not null do nothing;

  -- ======================================================================
  -- Scenario 1: October delivery creates one row per assignee (2 here), dated 2026-10-15.
  -- ======================================================================
  select count(*) into v_count from public.daily_logs
  where task_id = v_task_oct_id and source = 'auto_task' and date = date '2026-10-15';
  if v_count <> 2 then
    raise exception 'TEST_FAILED: scenario 1 — expected 2 backfilled rows for the October task, found %.', v_count;
  end if;
  select id into v_row_id from public.daily_logs where task_id = v_task_oct_id and user_id = v_assignee1_id and source = 'auto_task';
  if v_row_id is null or v_row_id not like 'dlog-bf-%' then
    raise exception 'TEST_FAILED: scenario 1 — backfilled row id must carry the dlog-bf- prefix, found %.', v_row_id;
  end if;

  -- Self-check: the real employee can see their own backfilled row under the existing,
  -- unchanged daily_logs_select_rls (direct_report_visible(user_id): target_id = caller).
  perform set_config('request.jwt.claims', json_build_object('sub', v_assignee1_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 1 self-check).';
  end if;
  select count(*) into v_count from public.daily_logs where id = v_row_id;
  reset role; perform set_config('request.jwt.claims', '', true);
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 1 — the assignee could not see their own backfilled row.';
  end if;

  -- ======================================================================
  -- Scenario 2: delivery before 2026-10-01 (Cairo) must never be backfilled.
  -- ======================================================================
  if exists (select 1 from public.daily_logs where task_id = v_task_sep_id and source = 'auto_task') then
    raise exception 'TEST_FAILED: scenario 2 — a pre-October delivery must not be backfilled.';
  end if;

  -- ======================================================================
  -- Scenario 3: a closed task must never be backfilled, even with delivered_at set.
  -- ======================================================================
  if exists (select 1 from public.daily_logs where task_id = v_task_closed_id and source = 'auto_task') then
    raise exception 'TEST_FAILED: scenario 3 — a closed task must not be backfilled.';
  end if;

  -- ======================================================================
  -- Scenario 4: a task already manually linked by the employee (any date) must be skipped.
  -- ======================================================================
  if exists (select 1 from public.daily_logs where task_id = v_task_linked_id and source = 'auto_task') then
    raise exception 'TEST_FAILED: scenario 4 — a task already manually linked by the employee must not be backfilled.';
  end if;
  select count(*) into v_count from public.daily_logs where v_task_linked_id = any(linked_task_ids) and user_id = v_assignee1_id;
  if v_count <> 1 then
    raise exception 'TEST_FAILED: scenario 4 — the original manual link must be the only row, found %.', v_count;
  end if;

  -- ======================================================================
  -- Scenario 5: re-running the exact same INSERT...SELECT must not duplicate anything.
  -- ======================================================================
  with qualifying_tasks as (
    select t.id as task_id, t.client_id, t.title, t.description, t.delivered_at, t.assigned_to
    from public.tasks t
    where t.status in ('in_review', 'completed')
      and t.delivered_at is not null
      and (t.delivered_at at time zone 'Africa/Cairo')::date >= date '2026-10-01'
      and t.id = any(v_task_ids)
  ),
  assignees as (
    select
      qt.task_id, qt.client_id, qt.title, qt.description, qt.delivered_at,
      coalesce(
        (select array_agg(distinct ta.user_id) from public.task_assignees ta where ta.task_id = qt.task_id),
        case when qt.assigned_to is not null then array[qt.assigned_to] else array[]::text[] end
      ) as assignee_ids
    from qualifying_tasks qt
  ),
  expanded as (
    select a.task_id, a.client_id, a.title, a.description, a.delivered_at, u as user_id
    from assignees a, unnest(a.assignee_ids) as u
  )
  insert into public.daily_logs (id, user_id, date, summary_text, linked_task_ids, client_id, task_id, source)
  select
    'dlog-bf-' || md5(e.task_id || e.user_id || ((e.delivered_at at time zone 'Africa/Cairo')::date)::text),
    e.user_id,
    (e.delivered_at at time zone 'Africa/Cairo')::date,
    coalesce(e.title, '') || coalesce(E'\n' || nullif(btrim(e.description), ''), ''),
    array[e.task_id],
    e.client_id,
    e.task_id,
    'auto_task'
  from expanded e
  where not exists (
    select 1 from public.daily_logs dl
    where dl.user_id = e.user_id and e.task_id = any(dl.linked_task_ids)
  )
  on conflict (task_id, user_id, date) where task_id is not null do nothing;

  select count(*) into v_count from public.daily_logs
  where task_id = v_task_oct_id and source = 'auto_task';
  if v_count <> 2 then
    raise exception 'TEST_FAILED: scenario 5 — re-running the backfill must not duplicate rows, found % (expected 2).', v_count;
  end if;

  -- ======================================================================
  -- Scenario 6: the rollback statement (`delete ... where id like 'dlog-bf-%'`) must remove only
  -- backfill rows, never the manual row from scenario 4 nor a trigger-style ('dlog-') row.
  -- ======================================================================
  insert into public.daily_logs (id, user_id, date, summary_text, linked_task_ids, client_id, task_id, source)
  values ('dlog-' || replace(gen_random_uuid()::text, '-', ''), v_assignee1_id, date '2026-10-16', 'Trigger-style row, not backfill.', array[v_task_oct_id], v_client_id, v_task_oct_id, 'auto_task')
  on conflict (task_id, user_id, date) where task_id is not null do nothing;

  delete from public.daily_logs where id like 'dlog-bf-%' and task_id = any(v_task_ids);

  if exists (select 1 from public.daily_logs where task_id = any(v_task_ids) and id like 'dlog-bf-%') then
    raise exception 'TEST_FAILED: scenario 6 — rollback must remove every dlog-bf- row.';
  end if;
  if not exists (select 1 from public.daily_logs where v_task_linked_id = any(linked_task_ids) and user_id = v_assignee1_id and source = 'manual') then
    raise exception 'TEST_FAILED: scenario 6 — rollback must not remove the manual row.';
  end if;
  if not exists (select 1 from public.daily_logs where task_id = v_task_oct_id and id not like 'dlog-bf-%') then
    raise exception 'TEST_FAILED: scenario 6 — rollback must not remove the trigger-style row.';
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all daily_log_backfill_october_2026 scenarios passed; rolling back every fabricated change.';
end $$;
