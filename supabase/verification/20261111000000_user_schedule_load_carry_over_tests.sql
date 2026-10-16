-- ============================================================================
-- FUNCTION TESTS for 20261111000000_user_schedule_load_carry_over.sql. NOT a migration — lives
-- outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. Same fabrication/rollback pattern as
-- 20261110000000_user_schedule_load_tests.sql: throwaway zz_-prefixed rows only, real personas,
-- a final `raise exception 'TEST_OK_ROLLED_BACK: ...'` discards every write regardless of
-- pass/fail.
--
-- This file ONLY covers the new carried_over_count column and its placement rule. The caller
-- gate, the existing due_date/task_count columns' own counting rule, and the Cairo-timezone fix
-- are already covered by 20261110000000_user_schedule_load_tests.sql and are not re-tested here
-- (the body carrying that logic is byte-identical to that migration — see this file's own
-- header comment).
--
-- Coverage: an overdue OPEN task counts toward carried_over_count; an overdue CLOSED/COMPLETED
-- task does not; carried_over_count is NOT scoped to [p_from, p_to] (an overdue task due before
-- p_from still counts); the count lands on the first WORKING day in the window, skipping a
-- leading Friday; every other row (including the Friday itself) reports 0; a window containing
-- no working day at all reports 0 everywhere, without erroring; task_count (the existing column)
-- is completely unaffected by any of this.
--
-- BASELINE-RELATIVE, not absolute: every numeric assertion is baseline (this environment's real,
-- pre-existing data for the picked v_creative_id, queried before any fixture exists) + the delta
-- this file's own fixtures contribute — same reasoning as
-- 20261110000000_user_schedule_load_tests.sql's own BASELINE comment (a live run found a picked
-- persona with real pre-existing tasks on the exact dates/overdue-status this file used to
-- assert literal counts against). The two STRUCTURAL assertions (carried_over_count is 0 on
-- every row except the one it attaches to; a window with no working day reports 0 everywhere)
-- are untouched — those hold regardless of baseline, by the function's own placement rule, not
-- because of what's on any particular row.
-- ============================================================================
do $$
declare
  v_ordinary_id text; v_ordinary_auth uuid;
  v_creative_id text; v_creative_auth uuid;

  v_client_id text;
  v_task_overdue_open_id text;
  v_task_overdue_closed_id text;
  v_task_overdue_far_id text;

  v_row record;
  v_map jsonb := '{}'::jsonb;
  v_row_count integer;

  v_probe_date date;
  v_boundary_friday date;
  v_expected_first_working_day date;

  -- The function's OWN notion of "today" (Africa/Cairo, via get_server_today()) — every baseline
  -- query, fixture due_date, and assertion lookup below uses THIS, never a bare SQL CURRENT_DATE
  -- (session-timezone-dependent), same fix as 20261110000000_user_schedule_load_tests.sql's own
  -- v_cairo_today.
  v_cairo_today date;

  -- BASELINE (see this file's own header comment): computed below, before any fixture exists.
  -- v_baseline_task_count is keyed by date (text) -> count, for the two specific dates scenario 1
  -- checks; v_baseline_overdue_open is a scalar — the carry-over column's own baseline, since it
  -- is a single system-wide number, never a per-date map.
  v_baseline_task_count jsonb;
  v_baseline_overdue_open integer;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: one ordinary (non-admin) caller, one creative target — real, active personas.
  -- ======================================================================
  select id, auth_id into v_ordinary_id, v_ordinary_auth
    from public.users
    where auth_id is not null and deactivated_at is null
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'marketing_manager')
      and role not like '%team_lead'
    order by id limit 1;
  if v_ordinary_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active ordinary employee with auth_id.';
  end if;

  select id, auth_id into v_creative_id, v_creative_auth
    from public.users where role in ('graphic_designer', 'video_editor', 'ui_ux_designer') and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_creative_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active graphic_designer/video_editor/ui_ux_designer with auth_id.';
  end if;

  select public.get_server_today() into v_cairo_today;
  v_probe_date := v_cairo_today + 20;

  -- ======================================================================
  -- BASELINE — computed NOW, before any fixture below is inserted, so it reflects only this
  -- environment's pre-existing real data for v_creative_id.
  -- ======================================================================
  select jsonb_object_agg(d::text, cnt) into v_baseline_task_count
  from (
    select d, (
      select count(*)
      from public.tasks t
      join public.task_assignees ta on ta.task_id = t.id
      where ta.user_id = v_creative_id
        and t.due_date = d
        and (d <= v_cairo_today or t.status not in ('completed', 'closed'))
    ) as cnt
    from (values (v_cairo_today - 3), (v_cairo_today - 2)) as dates(d)
  ) sub;

  select count(*) into v_baseline_overdue_open
  from public.tasks t
  join public.task_assignees ta on ta.task_id = t.id
  where ta.user_id = v_creative_id
    and t.due_date < v_cairo_today
    and t.status not in ('completed', 'closed');

  -- ======================================================================
  -- Fabricate: one overdue OPEN task (due 3 days ago, 'todo'), one overdue CLOSED task (due 2
  -- days ago — must NOT count), and one overdue OPEN task far in the past (due 30 days ago,
  -- outside the main [v_cairo_today-7, v_cairo_today+7] window used below — proves
  -- carried_over_count is not scoped to the queried window). These contribute exactly 2 to
  -- carried_over_count ON TOP of v_baseline_overdue_open — not a literal 2.
  -- ======================================================================
  v_client_id := 'zz_carryover_client_' || substr(md5(random()::text), 1, 8);
  insert into public.clients (id, name, services, status, sales_owner_id)
  values (v_client_id, 'ZZ Carry-Over Test Client', array['seo'], 'active', v_ordinary_id);

  v_task_overdue_open_id := 'zz_carryover_open_' || substr(md5(random()::text), 1, 8);
  v_task_overdue_closed_id := 'zz_carryover_closed_' || substr(md5(random()::text), 1, 8);
  v_task_overdue_far_id := 'zz_carryover_far_' || substr(md5(random()::text), 1, 8);

  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values
    (v_task_overdue_open_id, v_client_id, 'ZZ overdue open', 'test', v_ordinary_id, 'Technical', 'todo', v_cairo_today - 3, 'low'),
    (v_task_overdue_closed_id, v_client_id, 'ZZ overdue closed', 'test', v_ordinary_id, 'Technical', 'closed', v_cairo_today - 2, 'low'),
    (v_task_overdue_far_id, v_client_id, 'ZZ overdue far', 'test', v_ordinary_id, 'Technical', 'in_progress', v_cairo_today - 30, 'low');

  insert into public.task_assignees (task_id, user_id, added_by)
  values
    (v_task_overdue_open_id, v_creative_id, v_ordinary_id),
    (v_task_overdue_closed_id, v_creative_id, v_ordinary_id),
    (v_task_overdue_far_id, v_creative_id, v_ordinary_id);

  -- ======================================================================
  -- Scenario 1: main window [v_cairo_today-7, v_cairo_today+7] — includes the near overdue tasks,
  -- excludes the far one. Existing columns (due_date/task_count) must be untouched; the new
  -- column must total 2 (open tasks only) on the first working day, 0 everywhere else.
  -- ======================================================================
  -- Walk forward day by day, exactly mirroring the SQL function's own "first dow <> 5" rule, so
  -- this test never silently encodes the same bug the function might have.
  v_expected_first_working_day := v_cairo_today - 7;
  while extract(dow from v_expected_first_working_day) = 5 loop
    v_expected_first_working_day := v_expected_first_working_day + 1;
  end loop;

  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  v_row_count := 0;
  for v_row in
    select * from public.get_user_schedule_load(v_creative_id, v_cairo_today - 7, v_cairo_today + 7)
  loop
    v_row_count := v_row_count + 1;
    v_map := v_map || jsonb_build_object(
      v_row.due_date::text,
      jsonb_build_object('task_count', v_row.task_count, 'carried_over_count', v_row.carried_over_count)
    );
  end loop;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_row_count <> 15 then
    raise exception 'TEST_FAILED: scenario 1 — expected exactly 15 rows (existing shape unchanged), got %.', v_row_count;
  end if;

  if ((v_map -> (v_cairo_today - 3)::text) ->> 'task_count')::integer <> (v_baseline_task_count ->> (v_cairo_today - 3)::text)::integer + 1 then
    raise exception 'TEST_FAILED: scenario 1a — the overdue OPEN task''s own day must show baseline+1 (existing column untouched). DIAGNOSTIC: date=%, baseline=%, delta_expected=1, expected=%, got=%.',
      (v_cairo_today - 3), (v_baseline_task_count ->> (v_cairo_today - 3)::text),
      (v_baseline_task_count ->> (v_cairo_today - 3)::text)::integer + 1,
      ((v_map -> (v_cairo_today - 3)::text) ->> 'task_count');
  end if;
  if ((v_map -> (v_cairo_today - 2)::text) ->> 'task_count')::integer <> (v_baseline_task_count ->> (v_cairo_today - 2)::text)::integer + 1 then
    raise exception 'TEST_FAILED: scenario 1b — the overdue CLOSED task''s own day must show baseline+1 (existing column untouched). DIAGNOSTIC: date=%, baseline=%, delta_expected=1, expected=%, got=%.',
      (v_cairo_today - 2), (v_baseline_task_count ->> (v_cairo_today - 2)::text),
      (v_baseline_task_count ->> (v_cairo_today - 2)::text)::integer + 1,
      ((v_map -> (v_cairo_today - 2)::text) ->> 'task_count');
  end if;

  if ((v_map -> v_expected_first_working_day::text) ->> 'carried_over_count')::integer <> v_baseline_overdue_open + 2 then
    raise exception 'TEST_FAILED: scenario 1c — the first working day (%) must show carried_over_count = baseline_overdue_open+2 (the near OPEN overdue task + the far one outside this window; the CLOSED one must be excluded). DIAGNOSTIC: baseline_overdue_open=%, delta_expected=2, expected=%, got=%.',
      v_expected_first_working_day, v_baseline_overdue_open, v_baseline_overdue_open + 2,
      ((v_map -> v_expected_first_working_day::text) ->> 'carried_over_count');
  end if;

  if exists (
    select 1 from jsonb_each(v_map) e
    where e.key <> v_expected_first_working_day::text
      and (e.value ->> 'carried_over_count')::integer <> 0
  ) then
    raise exception 'TEST_FAILED: scenario 1d — every row OTHER than the first working day must show carried_over_count 0.';
  end if;

  -- ======================================================================
  -- Scenario 2: Friday-skip — p_from itself is a Friday. carried_over_count must land on the
  -- following Saturday, NOT on the Friday row, even though Friday is p_from.
  -- ======================================================================
  v_boundary_friday := v_probe_date;
  while extract(dow from v_boundary_friday) <> 5 loop
    v_boundary_friday := v_boundary_friday + 1;
  end loop;

  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  v_map := '{}'::jsonb;
  for v_row in
    select * from public.get_user_schedule_load(v_creative_id, v_boundary_friday, v_boundary_friday + 2)
  loop
    v_map := v_map || jsonb_build_object(v_row.due_date::text, v_row.carried_over_count);
  end loop;
  reset role; perform set_config('request.jwt.claims', '', true);

  if (v_map ->> v_boundary_friday::text)::integer <> 0 then
    raise exception 'TEST_FAILED: scenario 2 — the Friday row (p_from itself) must show carried_over_count 0, got %.', (v_map ->> v_boundary_friday::text);
  end if;
  if (v_map ->> (v_boundary_friday + 1)::text)::integer <> v_baseline_overdue_open + 2 then
    raise exception 'TEST_FAILED: scenario 2b — the Saturday after a Friday p_from (the first WORKING day) must show carried_over_count = baseline_overdue_open+2 (same global total as scenario 1c — carry-over is not window-scoped). DIAGNOSTIC: baseline_overdue_open=%, delta_expected=2, expected=%, got=%.',
      v_baseline_overdue_open, v_baseline_overdue_open + 2, (v_map ->> (v_boundary_friday + 1)::text);
  end if;
  if (v_map ->> (v_boundary_friday + 2)::text)::integer <> 0 then
    raise exception 'TEST_FAILED: scenario 2c — the day after the first working day must show carried_over_count 0, got %.', (v_map ->> (v_boundary_friday + 2)::text);
  end if;

  -- ======================================================================
  -- Scenario 3: a window that is ENTIRELY non-working (a single Friday) must report 0 — not
  -- error, not attach the carry-over count anywhere, since there is no working day to attach it
  -- to.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  select carried_over_count into v_row_count
  from public.get_user_schedule_load(v_creative_id, v_boundary_friday, v_boundary_friday);
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_row_count <> 0 then
    raise exception 'TEST_FAILED: scenario 3 — a window containing only a Friday must report carried_over_count 0, got %.', v_row_count;
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all carry-over scenarios passed; rolling back every fabricated row.';
end $$;
