-- ============================================================================
-- FUNCTION TESTS for 20261110000000_user_schedule_load.sql. NOT a migration — lives outside
-- supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. Every scenario fabricates only
-- throwaway clients/tasks (zz_ prefixed ids); every PERSONA is a REAL existing active employee
-- (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing), kept mutually
-- exclusive by explicit id exclusions, EXCEPT the one persona temporarily deactivated in place
-- for the "ineligible target" scenario (restored only by this whole DO block's own rollback,
-- same pattern 20261105000000_task_assignees_rpcs_tests.sql already uses). The final
-- `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit transaction wrapping this
-- whole DO block, rolling back every single write performed above it — nothing persists either
-- way, pass or fail.
--
-- "Expect this call to fail" scenarios wrap the call in its own nested BEGIN/EXCEPTION block (a
-- real exception creates an implicit savepoint in plpgsql, so a caught failure doesn't abort the
-- rest of the test). If the call unexpectedly SUCCEEDS, it raises its own 'TEST_FAILED: ...' from
-- inside the try block, which the handler re-raises instead of swallowing.
--
-- Coverage: caller gate (sales caller always rejected; a non-sales caller may query a creative
-- target; an executive/head_of_technical target requires an executive caller; a deactivated
-- employee, a nonexistent user, a sales target, and a marketing_manager target are all rejected;
-- p_from > p_to is rejected), the counting rule at its exact boundaries (a day with no fixture
-- added, a day with exactly 5 fixture tasks added, a day with exactly 6, today counting a DONE
-- task the same as any other day, a future day counting only open tasks), the return shape
-- (every day in [p_from, p_to] is present via generate_series — never sparse), and the
-- Cairo-timezone fix (get_server_today()/get_user_schedule_load()'s p_as_of correctly crosses
-- midnight into the next Cairo day while the same instant's bare UTC date has not yet rolled
-- over — simulated via the p_as_of parameter, never by touching the real system clock).
--
-- BASELINE-RELATIVE, not absolute: every numeric assertion is baseline (this environment's real,
-- pre-existing data, queried before any fixture exists) + the delta this file's own fixtures
-- contribute — see the BASELINE declare-block comment below. A live run against prod found a
-- picked persona with real pre-existing tasks on the exact dates this file used to assert
-- literal counts against (0, 1, 2, 5, 6) — those assertions broke not because the function was
-- wrong, but because the test assumed the picked user had no real tasks. This file no longer
-- makes that assumption.
--
-- Not covered here (no SQL equivalent): "5 tasks suggests that day," "exactly 6 pushes to the
-- next working day," and "Friday is skipped" are suggestDueDateAndHours()'s own date-WALKING
-- behavior in src/lib/designerScheduling.ts — this function only ever returns raw per-day
-- counts, never a suggested date, so there is nothing in this file that exercises date-walking;
-- those three are covered by scripts/checkDesignerScheduling.ts instead.
-- ============================================================================
do $$
declare
  v_sales_id text; v_sales_auth uuid;
  v_ordinary_id text; v_ordinary_auth uuid;
  v_exec_id text; v_exec_auth uuid;
  v_creative_id text; v_creative_auth uuid;
  v_hot_id text; v_hot_auth uuid;
  v_marketing_mgr_id text; v_marketing_mgr_auth uuid;
  v_inactive_id text; v_inactive_auth_unused uuid; v_inactive_original_deactivated_at timestamptz;

  v_client_id text;
  v_task_past_id text;
  v_task_today_todo_id text;
  v_task_today_done_id text;
  v_task_future_open_id text;
  v_task_future_done_id text;
  v_fake_user_id text;

  v_row record;
  v_count_by_date jsonb := '{}'::jsonb;
  v_row_count integer;

  -- BASELINE — this environment's REAL, pre-existing data for the personas this file checks
  -- counts for, computed with a plain join (no RPC) BEFORE any fixture is inserted, using the
  -- exact same rule get_user_schedule_load() uses (date <= v_cairo_today: all statuses; date >
  -- v_cairo_today: open only). Every numeric assertion below is baseline + the delta this file's
  -- OWN fixtures contribute — never an absolute number — so the suite passes regardless of
  -- whatever real tasks the picked personas already have (a live run against prod data for
  -- v_creative_id = usr-0033-ihik, who already had 5 real tasks due on the 2b date, is exactly
  -- the case this must survive). v_baseline_creative/v_baseline_ordinary are jsonb maps keyed by
  -- date (text) -> count, built only for the specific dates this file actually checks (not the
  -- whole window — the row-COUNT check in 2a is already data-independent via generate_series and
  -- needs no baseline). v_baseline_scenario13 is a scalar: scenario 13 calls the function with an
  -- explicit p_as_of whose OWN Cairo date (v_as_of_cairo_date) is its cutoff, not v_cairo_today,
  -- so that one date's baseline cannot share the v_cairo_today-keyed map above. v_diag is a
  -- scratch buffer for the row-level diagnostic text built into each TEST_FAILED message below,
  -- rebuilt fresh right before each raise (never relied upon outside the `if` block that fills
  -- it).
  v_baseline_creative jsonb;
  v_baseline_ordinary jsonb;
  v_baseline_scenario13 integer;
  v_diag text;

  -- A fixed, known instant: 2026-01-14 22:30:00 UTC. January is Cairo standard time (UTC+2,
  -- outside Egypt's DST window), so this is 2026-01-15 00:30:00 in Cairo — 30 minutes into the
  -- "00:00-03:00 Cairo window" this fix specifically targets, and on a DIFFERENT calendar date
  -- than its own bare UTC date (2026-01-14). Using a fixed historical/future instant (not
  -- `now()`) makes this deterministic regardless of when the test actually runs — the
  -- Africa/Cairo offset for this specific instant never changes.
  v_as_of timestamptz := '2026-01-14 22:30:00+00'::timestamptz;
  v_as_of_cairo_date date := date '2026-01-15';
  v_as_of_utc_date date := date '2026-01-14';
  v_server_today date;
  v_task_cairo_today_id text;

  -- The function's OWN notion of "today" (Africa/Cairo, via get_server_today()) — every fixture
  -- due_date, query window bound, and assertion lookup below uses THIS, never a bare SQL
  -- CURRENT_DATE (session-timezone-dependent), so the whole suite cannot flake near a
  -- Cairo/session-timezone midnight-crossing: there is now exactly one "today" in this file, the
  -- same one get_user_schedule_load() itself computes, fetched once up front and reused
  -- everywhere (scenarios 12/13's OWN fixed historical instant are intentionally separate from
  -- this and untouched).
  v_cairo_today date;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  select public.get_server_today() into v_cairo_today;

  -- ======================================================================
  -- Setup: select real personas defensively.
  -- ======================================================================
  select id, auth_id into v_sales_id, v_sales_auth
    from public.users where role = 'sales' and auth_id is not null and deactivated_at is null order by id limit 1;
  select id, auth_id into v_exec_id, v_exec_auth
    from public.users where role = 'executive' and auth_id is not null and deactivated_at is null order by id limit 1;
  select id, auth_id into v_hot_id, v_hot_auth
    from public.users where role = 'head_of_technical' and auth_id is not null and deactivated_at is null order by id limit 1;
  select id, auth_id into v_marketing_mgr_id, v_marketing_mgr_auth
    from public.users where role = 'marketing_manager' and auth_id is not null and deactivated_at is null order by id limit 1;
  if v_sales_id is null or v_exec_id is null or v_hot_id is null or v_marketing_mgr_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active sales, executive, head_of_technical, and marketing_manager user, each with auth_id.';
  end if;

  select id, auth_id into v_ordinary_id, v_ordinary_auth
    from public.users
    where auth_id is not null and deactivated_at is null
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'marketing_manager')
      and role not like '%team_lead'
    order by id limit 1;
  if v_ordinary_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active ordinary (non-admin, non-sales, non-marketing-manager, non-team-lead) employee with auth_id.';
  end if;

  select id, auth_id into v_creative_id, v_creative_auth
    from public.users where role in ('graphic_designer', 'video_editor', 'ui_ux_designer') and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_creative_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active graphic_designer/video_editor/ui_ux_designer with auth_id.';
  end if;

  select id, auth_id into v_inactive_id, v_inactive_auth_unused
    from public.users
    where auth_id is not null and deactivated_at is null
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'marketing_manager')
      and role not like '%team_lead'
      and id not in (v_ordinary_id, v_creative_id)
    order by id limit 1;
  if v_inactive_id is null then
    raise exception 'TEST_SETUP_FAILED: need a second, distinct active ordinary employee with auth_id to temporarily deactivate for the "ineligible target" scenario.';
  end if;

  v_fake_user_id := 'zz_nonexistent_' || substr(md5(random()::text), 1, 8);

  -- Temporarily deactivate v_inactive_id in place — restored only by this whole block's rollback.
  select deactivated_at into v_inactive_original_deactivated_at from public.users where id = v_inactive_id;
  update public.users set deactivated_at = now() where id = v_inactive_id;

  -- ======================================================================
  -- BASELINE — computed NOW, before any fixture below is inserted, so it reflects only this
  -- environment's pre-existing real data. See this block's own declare-section comment for why
  -- these specific (user, date) pairs and not a full-window map.
  -- ======================================================================
  select jsonb_object_agg(d::text, cnt) into v_baseline_creative
  from (
    select d, (
      select count(*)
      from public.tasks t
      join public.task_assignees ta on ta.task_id = t.id
      where ta.user_id = v_creative_id
        and t.due_date = d
        and (d <= v_cairo_today or t.status not in ('completed', 'closed'))
    ) as cnt
    from (values
      (v_cairo_today - 3), (v_cairo_today - 1), (v_cairo_today),
      (v_cairo_today + 1), (v_cairo_today + 5), (v_cairo_today + 10)
    ) as dates(d)
  ) sub;

  select jsonb_object_agg(d::text, cnt) into v_baseline_ordinary
  from (
    select d, (
      select count(*)
      from public.tasks t
      join public.task_assignees ta on ta.task_id = t.id
      where ta.user_id = v_ordinary_id
        and t.due_date = d
        and (d <= v_cairo_today or t.status not in ('completed', 'closed'))
    ) as cnt
    from (values (v_cairo_today + 10)) as dates(d)
  ) sub;

  -- Scenario 13's own cutoff is v_as_of_cairo_date, not v_cairo_today — but since the one date it
  -- checks EQUALS that cutoff, "date <= cutoff" is trivially true, so this is simply every real
  -- task of v_creative_id's due exactly then, no status filter needed.
  select count(*) into v_baseline_scenario13
  from public.tasks t
  join public.task_assignees ta on ta.task_id = t.id
  where ta.user_id = v_creative_id and t.due_date = v_as_of_cairo_date;

  -- ======================================================================
  -- Fabricate a throwaway client and throwaway tasks, all assigned to the creative target via
  -- task_assignees (inserted directly here, bypassing RLS, as the unprivileged superuser
  -- context — same fabrication pattern every other verification file in this repo uses).
  -- ======================================================================
  v_client_id := 'zz_schedload_client_' || substr(md5(random()::text), 1, 8);
  insert into public.clients (id, name, services, status, sales_owner_id)
  values (v_client_id, 'ZZ Schedule Load Test Client', array['seo'], 'active', v_ordinary_id);

  v_task_past_id := 'zz_schedload_past_' || substr(md5(random()::text), 1, 8);
  v_task_today_todo_id := 'zz_schedload_todaytodo_' || substr(md5(random()::text), 1, 8);
  v_task_today_done_id := 'zz_schedload_todaydone_' || substr(md5(random()::text), 1, 8);
  v_task_future_open_id := 'zz_schedload_futopen_' || substr(md5(random()::text), 1, 8);
  v_task_future_done_id := 'zz_schedload_futdone_' || substr(md5(random()::text), 1, 8);

  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values
    (v_task_past_id, v_client_id, 'ZZ past completed', 'test', v_ordinary_id, 'Technical', 'completed', v_cairo_today - 3, 'low'),
    (v_task_today_todo_id, v_client_id, 'ZZ today todo', 'test', v_ordinary_id, 'Technical', 'todo', v_cairo_today, 'low'),
    (v_task_today_done_id, v_client_id, 'ZZ today done', 'test', v_ordinary_id, 'Technical', 'closed', v_cairo_today, 'low'),
    (v_task_future_open_id, v_client_id, 'ZZ future open', 'test', v_ordinary_id, 'Technical', 'in_progress', v_cairo_today + 5, 'low'),
    (v_task_future_done_id, v_client_id, 'ZZ future done', 'test', v_ordinary_id, 'Technical', 'completed', v_cairo_today + 5, 'low');

  insert into public.task_assignees (task_id, user_id, added_by)
  values
    (v_task_past_id, v_creative_id, v_ordinary_id),
    (v_task_today_todo_id, v_creative_id, v_ordinary_id),
    (v_task_today_done_id, v_creative_id, v_ordinary_id),
    (v_task_future_open_id, v_creative_id, v_ordinary_id),
    (v_task_future_done_id, v_creative_id, v_ordinary_id);

  -- ======================================================================
  -- Sanity: confirm each fixture task was actually STORED with the status/due_date/assignee this
  -- whole scenario depends on — catches a trigger, default, or constraint silently rewriting a
  -- value on insert (Step 1's own hint (d)) before any assertion below can misattribute a mismatch
  -- to the function instead of the fixture.
  -- ======================================================================
  declare
    v_check record;
  begin
    select id, status, due_date into v_check from public.tasks where id = v_task_past_id;
    if v_check.status <> 'completed' or v_check.due_date <> v_cairo_today - 3 then
      raise exception 'TEST_SETUP_FAILED: v_task_past_id stored as status=%, due_date=% (expected completed, %).', v_check.status, v_check.due_date, v_cairo_today - 3;
    end if;
    if not exists (select 1 from public.task_assignees where task_id = v_task_past_id and user_id = v_creative_id) then
      raise exception 'TEST_SETUP_FAILED: v_task_past_id has no task_assignees row for v_creative_id (%).', v_creative_id;
    end if;

    select id, status, due_date into v_check from public.tasks where id = v_task_today_todo_id;
    if v_check.status <> 'todo' or v_check.due_date <> v_cairo_today then
      raise exception 'TEST_SETUP_FAILED: v_task_today_todo_id stored as status=%, due_date=% (expected todo, %).', v_check.status, v_check.due_date, v_cairo_today;
    end if;
    if not exists (select 1 from public.task_assignees where task_id = v_task_today_todo_id and user_id = v_creative_id) then
      raise exception 'TEST_SETUP_FAILED: v_task_today_todo_id has no task_assignees row for v_creative_id (%).', v_creative_id;
    end if;

    select id, status, due_date into v_check from public.tasks where id = v_task_today_done_id;
    if v_check.status <> 'closed' or v_check.due_date <> v_cairo_today then
      raise exception 'TEST_SETUP_FAILED: v_task_today_done_id stored as status=%, due_date=% (expected closed, %).', v_check.status, v_check.due_date, v_cairo_today;
    end if;
    if not exists (select 1 from public.task_assignees where task_id = v_task_today_done_id and user_id = v_creative_id) then
      raise exception 'TEST_SETUP_FAILED: v_task_today_done_id has no task_assignees row for v_creative_id (%).', v_creative_id;
    end if;

    select id, status, due_date into v_check from public.tasks where id = v_task_future_open_id;
    if v_check.status <> 'in_progress' or v_check.due_date <> v_cairo_today + 5 then
      raise exception 'TEST_SETUP_FAILED: v_task_future_open_id stored as status=%, due_date=% (expected in_progress, %).', v_check.status, v_check.due_date, v_cairo_today + 5;
    end if;
    if not exists (select 1 from public.task_assignees where task_id = v_task_future_open_id and user_id = v_creative_id) then
      raise exception 'TEST_SETUP_FAILED: v_task_future_open_id has no task_assignees row for v_creative_id (%).', v_creative_id;
    end if;

    select id, status, due_date into v_check from public.tasks where id = v_task_future_done_id;
    if v_check.status <> 'completed' or v_check.due_date <> v_cairo_today + 5 then
      raise exception 'TEST_SETUP_FAILED: v_task_future_done_id stored as status=%, due_date=% (expected completed, %).', v_check.status, v_check.due_date, v_cairo_today + 5;
    end if;
    if not exists (select 1 from public.task_assignees where task_id = v_task_future_done_id and user_id = v_creative_id) then
      raise exception 'TEST_SETUP_FAILED: v_task_future_done_id has no task_assignees row for v_creative_id (%).', v_creative_id;
    end if;
  end;

  -- ======================================================================
  -- Scenario 1: sales may never call this function, regardless of target.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_auth)::text, true);
  set local role authenticated;
  begin
    perform * from public.get_user_schedule_load(v_creative_id, v_cairo_today - 7, v_cairo_today + 7);
    raise exception 'TEST_FAILED: scenario 1 — sales must never be able to query schedule load.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 2: a non-sales caller may query a creative target; every day in range comes back
  -- (including empty ones); the counting rule is correct at the today/past/future boundaries,
  -- INCLUDING that today counts a DONE task exactly the same as a past one (not just open ones).
  --
  -- Every assertion below is baseline (this environment's real, pre-existing data, computed
  -- above BEFORE any fixture existed) + the delta this scenario's own fixtures contribute — never
  -- an absolute number — so it passes regardless of whatever real tasks v_creative_id already
  -- has. Every TEST_FAILED carries the baseline, the delta expected, and the stored fixture
  -- row(s) + their task_assignees, so one failed run names the actual cause instead of just the
  -- symptom.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;

  v_row_count := 0;
  for v_row in
    select * from public.get_user_schedule_load(v_creative_id, v_cairo_today - 7, v_cairo_today + 7)
  loop
    v_row_count := v_row_count + 1;
    v_count_by_date := v_count_by_date || jsonb_build_object(v_row.due_date::text, v_row.task_count);
  end loop;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_row_count <> 15 then
    raise exception 'TEST_FAILED: scenario 2a — expected exactly 15 rows (one per day, 7 before + today + 7 after), got %. DIAGNOSTIC: v_cairo_today=%, p_from=%, p_to=%, v_creative_id=%, full_result=%',
      v_row_count, v_cairo_today, v_cairo_today - 7, v_cairo_today + 7, v_creative_id, v_count_by_date;
  end if;
  if (v_count_by_date ->> (v_cairo_today - 3)::text)::integer <> (v_baseline_creative ->> (v_cairo_today - 3)::text)::integer + 1 then
    select format(
      '{id:%s, status:%s, due_date:%s, created_by:%s, parent_task_id:%s}',
      t.id, t.status, t.due_date, t.created_by, t.parent_task_id
    ) into v_diag
    from public.tasks t where t.id = v_task_past_id;

    raise exception 'TEST_FAILED: scenario 2b — a completed task due 3 days ago must still count (today/past counts all). DIAGNOSTIC: v_cairo_today=%, p_from=%, p_to=%, row_for_date={due_date:%, task_count:%}, baseline=%, delta_expected=1, expected=%, fixture_task(v_task_past_id)=%, task_assignees_for_fixture=%, v_creative_id=%',
      v_cairo_today, v_cairo_today - 7, v_cairo_today + 7,
      (v_cairo_today - 3)::text, (v_count_by_date ->> (v_cairo_today - 3)::text),
      (v_baseline_creative ->> (v_cairo_today - 3)::text),
      (v_baseline_creative ->> (v_cairo_today - 3)::text)::integer + 1,
      v_diag,
      (select string_agg(user_id, ', ') from public.task_assignees where task_id = v_task_past_id),
      v_creative_id;
  end if;
  if (v_count_by_date ->> (v_cairo_today - 1)::text)::integer <> (v_baseline_creative ->> (v_cairo_today - 1)::text)::integer then
    select string_agg(
      format('{id:%s, status:%s, due_date:%s, created_by:%s, parent_task_id:%s}', t.id, t.status, t.due_date, t.created_by, t.parent_task_id),
      '; '
    ) into v_diag
    from public.tasks t
    join public.task_assignees ta on ta.task_id = t.id
    where ta.user_id = v_creative_id and t.due_date = v_cairo_today - 1;

    raise exception 'TEST_FAILED: scenario 2c — a PAST day with no fixture added must match its baseline exactly (no delta). DIAGNOSTIC: v_cairo_today=%, p_from=%, p_to=%, row_for_date={due_date:%, task_count:%}, baseline=%, delta_expected=0, v_creative_id=%, real_tasks_found_for_date=%',
      v_cairo_today, v_cairo_today - 7, v_cairo_today + 7,
      (v_cairo_today - 1)::text, (v_count_by_date ->> (v_cairo_today - 1)::text),
      (v_baseline_creative ->> (v_cairo_today - 1)::text),
      v_creative_id, coalesce(v_diag, '(none)');
  end if;
  if (v_count_by_date ->> (v_cairo_today)::text)::integer <> (v_baseline_creative ->> (v_cairo_today)::text)::integer + 2 then
    select string_agg(
      format('{id:%s, status:%s, due_date:%s, created_by:%s, parent_task_id:%s, assignees:%s}',
        t.id, t.status, t.due_date, t.created_by, t.parent_task_id,
        (select string_agg(user_id, ',') from public.task_assignees where task_id = t.id)
      ), '; '
    ) into v_diag
    from public.tasks t where t.id in (v_task_today_todo_id, v_task_today_done_id);

    raise exception 'TEST_FAILED: scenario 2d — today must count BOTH its open task and its closed task on top of baseline (+2 total), the same today/past rule as any other non-future day. DIAGNOSTIC: v_cairo_today=%, p_from=%, p_to=%, row_for_date={due_date:%, task_count:%}, baseline=%, delta_expected=2, expected=%, v_creative_id=%, fixtures=%',
      v_cairo_today, v_cairo_today - 7, v_cairo_today + 7,
      (v_cairo_today)::text, (v_count_by_date ->> (v_cairo_today)::text),
      (v_baseline_creative ->> (v_cairo_today)::text),
      (v_baseline_creative ->> (v_cairo_today)::text)::integer + 2,
      v_creative_id, v_diag;
  end if;
  if (v_count_by_date ->> (v_cairo_today + 5)::text)::integer <> (v_baseline_creative ->> (v_cairo_today + 5)::text)::integer + 1 then
    select string_agg(
      format('{id:%s, status:%s, due_date:%s, created_by:%s, parent_task_id:%s, assignees:%s}',
        t.id, t.status, t.due_date, t.created_by, t.parent_task_id,
        (select string_agg(user_id, ',') from public.task_assignees where task_id = t.id)
      ), '; '
    ) into v_diag
    from public.tasks t where t.id in (v_task_future_open_id, v_task_future_done_id);

    raise exception 'TEST_FAILED: scenario 2e — a future day with one open + one completed task must count only the open one on top of baseline (+1, not +2). DIAGNOSTIC: v_cairo_today=%, p_from=%, p_to=%, row_for_date={due_date:%, task_count:%}, baseline=%, delta_expected=1, expected=%, v_creative_id=%, fixtures=%',
      v_cairo_today, v_cairo_today - 7, v_cairo_today + 7,
      (v_cairo_today + 5)::text, (v_count_by_date ->> (v_cairo_today + 5)::text),
      (v_baseline_creative ->> (v_cairo_today + 5)::text),
      (v_baseline_creative ->> (v_cairo_today + 5)::text)::integer + 1,
      v_creative_id, v_diag;
  end if;
  if (v_count_by_date ->> (v_cairo_today + 1)::text)::integer <> (v_baseline_creative ->> (v_cairo_today + 1)::text)::integer then
    raise exception 'TEST_FAILED: scenario 2f — a FUTURE day with no fixture added must match its baseline exactly (no delta; still appears in the result rather than being sparse). DIAGNOSTIC: v_cairo_today=%, row_for_date={due_date:%, task_count:%}, baseline=%, delta_expected=0, v_creative_id=%',
      v_cairo_today, (v_cairo_today + 1)::text, (v_count_by_date ->> (v_cairo_today + 1)::text),
      (v_baseline_creative ->> (v_cairo_today + 1)::text), v_creative_id;
  end if;

  -- ======================================================================
  -- Scenario 3: counting is correct at the exact 5/6 boundaries — fabricate 6 more throwaway
  -- tasks, all due the same day, 5 assigned to the creative target and the 6th assigned to the
  -- ordinary employee (so the SAME day's count differs by viewpoint: 5 for the creative target,
  -- 1 for the ordinary one), confirming the function counts per-ASSIGNEE, not per-day globally.
  -- ======================================================================
  declare
    v_boundary_day date := v_cairo_today + 10;
    v_boundary_task_ids text[] := array[]::text[];
    v_i integer;
    v_task_id text;
    v_count_creative integer;
    v_count_ordinary integer;
  begin
    for v_i in 1..6 loop
      v_task_id := 'zz_schedload_boundary_' || v_i || '_' || substr(md5(random()::text), 1, 6);
      v_boundary_task_ids := array_append(v_boundary_task_ids, v_task_id);
      insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
      values (v_task_id, v_client_id, 'ZZ boundary task ' || v_i, 'test', v_ordinary_id, 'Technical', 'todo', v_boundary_day, 'low');
    end loop;
    -- First 5 go to the creative target; the 6th goes to the ordinary employee instead.
    for v_i in 1..5 loop
      insert into public.task_assignees (task_id, user_id, added_by) values (v_boundary_task_ids[v_i], v_creative_id, v_ordinary_id);
    end loop;
    insert into public.task_assignees (task_id, user_id, added_by) values (v_boundary_task_ids[6], v_ordinary_id, v_ordinary_id);

    perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
    set local role authenticated;
    select task_count into v_count_creative from public.get_user_schedule_load(v_creative_id, v_boundary_day, v_boundary_day);
    select task_count into v_count_ordinary from public.get_user_schedule_load(v_ordinary_id, v_boundary_day, v_boundary_day);
    reset role; perform set_config('request.jwt.claims', '', true);

    -- All 6 boundary fixtures are 'todo' (open) on a FUTURE day, so every one of them
    -- contributes +1 to the delta regardless of baseline — this scenario is about the exact
    -- boundary value (5, then 6), not about the day being empty.
    if v_count_creative <> (v_baseline_creative ->> v_boundary_day::text)::integer + 5 then
      raise exception 'TEST_FAILED: scenario 3 — the creative target should show baseline+5 tasks on the boundary day. DIAGNOSTIC: v_boundary_day=%, baseline=%, delta_expected=5, expected=%, got=%.',
        v_boundary_day, (v_baseline_creative ->> v_boundary_day::text),
        (v_baseline_creative ->> v_boundary_day::text)::integer + 5, v_count_creative;
    end if;
    if v_count_ordinary <> (v_baseline_ordinary ->> v_boundary_day::text)::integer + 1 then
      raise exception 'TEST_FAILED: scenario 3b — the ordinary employee should show baseline+1 task on the same day (counting is per-assignee, not per-day globally). DIAGNOSTIC: v_boundary_day=%, baseline=%, delta_expected=1, expected=%, got=%.',
        v_boundary_day, (v_baseline_ordinary ->> v_boundary_day::text),
        (v_baseline_ordinary ->> v_boundary_day::text)::integer + 1, v_count_ordinary;
    end if;

    -- Now add a 6th task for the creative target on the SAME day — confirms the boundary value
    -- 6 itself is reported accurately (the "exactly 6" case the client-side suggester must then
    -- treat as full).
    insert into public.task_assignees (task_id, user_id, added_by) values (v_boundary_task_ids[6], v_creative_id, v_ordinary_id);
    perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
    set local role authenticated;
    select task_count into v_count_creative from public.get_user_schedule_load(v_creative_id, v_boundary_day, v_boundary_day);
    reset role; perform set_config('request.jwt.claims', '', true);
    if v_count_creative <> (v_baseline_creative ->> v_boundary_day::text)::integer + 6 then
      raise exception 'TEST_FAILED: scenario 3c — the creative target should show baseline+6 tasks on the boundary day after the 6th is added. DIAGNOSTIC: v_boundary_day=%, baseline=%, delta_expected=6, expected=%, got=%.',
        v_boundary_day, (v_baseline_creative ->> v_boundary_day::text),
        (v_baseline_creative ->> v_boundary_day::text)::integer + 6, v_count_creative;
    end if;
  end;

  -- ======================================================================
  -- Scenario 4: an executive caller sees the identical counts (admin doors are unconditional).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth)::text, true);
  set local role authenticated;
  if not exists (
    select 1 from public.get_user_schedule_load(v_creative_id, v_cairo_today, v_cairo_today)
    where task_count = (v_baseline_creative ->> v_cairo_today::text)::integer + 2
  ) then
    raise exception 'TEST_FAILED: scenario 4 — an executive caller should see the same today-count (baseline+2) for the creative target as scenario 2d. DIAGNOSTIC: v_cairo_today=%, baseline=%, delta_expected=2, expected=%.',
      v_cairo_today, (v_baseline_creative ->> v_cairo_today::text),
      (v_baseline_creative ->> v_cairo_today::text)::integer + 2;
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 5: a nonexistent target id is rejected.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  begin
    perform * from public.get_user_schedule_load(v_fake_user_id, v_cairo_today, v_cairo_today);
    raise exception 'TEST_FAILED: scenario 5 — a nonexistent target user id must be rejected.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;

  -- ======================================================================
  -- Scenario 6: an INELIGIBLE (deactivated) target is rejected — still impersonating v_ordinary.
  -- ======================================================================
  begin
    perform * from public.get_user_schedule_load(v_inactive_id, v_cairo_today, v_cairo_today);
    raise exception 'TEST_FAILED: scenario 6 — a deactivated target user must be rejected.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;

  -- ======================================================================
  -- Scenario 7: a marketing_manager target is rejected outright (this feature's own exclusion,
  -- enforced server-side too, not just by the UI's isCreativeAssignee() filter).
  -- ======================================================================
  begin
    perform * from public.get_user_schedule_load(v_marketing_mgr_id, v_cairo_today, v_cairo_today);
    raise exception 'TEST_FAILED: scenario 7 — a marketing_manager target must be rejected.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;

  -- ======================================================================
  -- Scenario 8: a head_of_technical target is rejected for a non-executive caller.
  -- ======================================================================
  begin
    perform * from public.get_user_schedule_load(v_hot_id, v_cairo_today, v_cairo_today);
    raise exception 'TEST_FAILED: scenario 8 — a non-executive caller must not be able to query a head_of_technical target.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;

  -- ======================================================================
  -- Scenario 9: a sales target is rejected outright, even for a non-sales caller.
  -- ======================================================================
  begin
    perform * from public.get_user_schedule_load(v_sales_id, v_cairo_today, v_cairo_today);
    raise exception 'TEST_FAILED: scenario 9 — a sales target must be rejected regardless of caller.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;

  -- ======================================================================
  -- Scenario 10: p_from after p_to is rejected.
  -- ======================================================================
  begin
    perform * from public.get_user_schedule_load(v_creative_id, v_cairo_today + 1, v_cairo_today);
    raise exception 'TEST_FAILED: scenario 10 — p_from after p_to must be rejected.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' then raise; end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 11: an executive caller MAY query a head_of_technical target (the one exception to
  -- scenario 8's rule).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_exec_auth)::text, true);
  set local role authenticated;
  perform * from public.get_user_schedule_load(v_hot_id, v_cairo_today, v_cairo_today);
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 12: Cairo timezone fix — get_server_today(p_as_of) with a FIXED instant known to
  -- fall in the 00:00-03:00 Cairo window (2026-01-14 22:30:00 UTC = 2026-01-15 00:30:00 Cairo)
  -- must return the Cairo date (2026-01-15), NOT the bare UTC date of that same instant
  -- (2026-01-14).
  -- ======================================================================
  select public.get_server_today(v_as_of) into v_server_today;
  if v_server_today <> v_as_of_cairo_date then
    raise exception 'TEST_FAILED: scenario 12 — get_server_today(%) should return the Cairo date %, got %.', v_as_of, v_as_of_cairo_date, v_server_today;
  end if;
  if v_server_today = v_as_of_utc_date then
    raise exception 'TEST_FAILED: scenario 12b — get_server_today() returned the bare UTC date instead of converting to Cairo; the whole point of this fix is that these two must differ for this instant.';
  end if;

  -- ======================================================================
  -- Scenario 13: the SAME Cairo-midnight-crossing instant, fed to get_user_schedule_load() via
  -- p_as_of, must treat a task due on the Cairo date (v_as_of_cairo_date) as "today" (counts a
  -- DONE task) — proving the fix applies inside the counting logic itself, not just in the
  -- standalone get_server_today() helper.
  -- ======================================================================
  v_task_cairo_today_id := 'zz_schedload_cairotoday_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task_cairo_today_id, v_client_id, 'ZZ Cairo-today completed', 'test', v_ordinary_id, 'Technical', 'completed', v_as_of_cairo_date, 'low');
  insert into public.task_assignees (task_id, user_id, added_by)
  values (v_task_cairo_today_id, v_creative_id, v_ordinary_id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  if not exists (
    select 1 from public.get_user_schedule_load(v_creative_id, v_as_of_cairo_date, v_as_of_cairo_date, v_as_of)
    where task_count = v_baseline_scenario13 + 1
  ) then
    raise exception 'TEST_FAILED: scenario 13 — a completed task due on the Cairo date must still count as "today" when p_as_of is the Cairo-midnight-crossing instant (proves the function uses Cairo''s date, not UTC''s, for the today/past-vs-future decision). DIAGNOSTIC: v_as_of=%, v_as_of_cairo_date=%, baseline=%, delta_expected=1, expected=%.',
      v_as_of, v_as_of_cairo_date, v_baseline_scenario13, v_baseline_scenario13 + 1;
  end if;
  reset role; perform set_config('request.jwt.claims', '', true);

  raise exception 'TEST_OK_ROLLED_BACK: all user schedule load scenarios passed; rolling back every fabricated row and the temporary deactivation.';
end $$;
