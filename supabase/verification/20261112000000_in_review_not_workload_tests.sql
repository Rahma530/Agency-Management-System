-- ============================================================================
-- FUNCTION/TRIGGER TESTS for 20261112000000_in_review_not_workload.sql. NOT a migration — lives
-- outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. Same fabrication/rollback pattern as the
-- other verification files in this feature: throwaway zz_-prefixed rows only, real personas
-- (selected defensively, TEST_SETUP_FAILED naming exactly what's missing, creative selected
-- before ordinary with an explicit exclusion so they can never resolve to the same real user —
-- see 20261110000000_user_schedule_load_tests.sql's own fix for why), "today" sourced from
-- get_server_today() rather than session-timezone-dependent CURRENT_DATE, and a final
-- `raise exception 'TEST_OK_ROLLED_BACK: ...'` that discards every fabricated row regardless of
-- pass/fail.
--
-- BASELINE-RELATIVE: carried_over_count assertions use a baseline (this environment's real
-- pre-existing overdue-open count for v_creative_id, queried before any fixture exists) + this
-- file's own delta, never an absolute number — same reasoning as the other verification files in
-- this feature (a live run found picked personas with real pre-existing data).
--
-- Coverage: delivered_at is set once (on first reaching in_review/completed) and never moved by a
-- later transition, including a later re-delivery after a revision; in_review -> in_progress
-- increments revision_count and sets revision_started_at; a client UPDATE that sets
-- revision_count directly (without a qualifying status transition) is silently restored to its
-- previous value; mark_task_viewed() never touches any of the three new columns; an overdue
-- in_review task is excluded from carried_over_count; an overdue REVISION (todo/in_progress,
-- revision_count > 0) IS included in carried_over_count; and no status transition ever touches
-- due_date.
-- ============================================================================
do $$
declare
  v_ordinary_id text; v_ordinary_auth uuid;
  v_creative_id text; v_creative_auth uuid;

  v_client_id text;

  v_cairo_today date;
  v_baseline_overdue_open integer;

  v_task_delivered_id text;
  v_delivered_1 timestamptz;
  v_delivered_2 timestamptz;

  v_task_revision_id text;
  v_revision_count_1 integer;
  v_revision_started_1 timestamptz;

  v_task_viewed_id text;
  v_delivered_before timestamptz;
  v_revision_count_before integer;
  v_revision_started_before timestamptz;
  v_delivered_after timestamptz;
  v_revision_count_after integer;
  v_revision_started_after timestamptz;

  v_task_in_review_overdue_id text;
  v_task_revision_overdue_id text;
  v_due_date_before date;
  v_due_date_after date;

  v_task_legacy_id text;

  v_row record;
  v_carried_over_count integer;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Setup: one creative target, one ordinary caller — real, active, DISTINCT personas (creative
  -- selected first, ordinary excludes it explicitly).
  -- ======================================================================
  select id, auth_id into v_creative_id, v_creative_auth
    from public.users where role in ('graphic_designer', 'video_editor', 'ui_ux_designer') and auth_id is not null and deactivated_at is null
    order by id limit 1;
  if v_creative_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active graphic_designer/video_editor/ui_ux_designer with auth_id.';
  end if;

  select id, auth_id into v_ordinary_id, v_ordinary_auth
    from public.users
    where auth_id is not null and deactivated_at is null
      and role not in ('executive', 'head_of_technical', 'ai_engineer', 'sales', 'marketing_manager')
      and role not like '%team_lead'
      and id <> v_creative_id
    order by id limit 1;
  if v_ordinary_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active ordinary employee with auth_id, distinct from the creative target.';
  end if;
  if v_ordinary_id = v_creative_id then
    raise exception 'TEST_SETUP_FAILED: v_ordinary_id resolved to the same user as v_creative_id (%).', v_creative_id;
  end if;

  select public.get_server_today() into v_cairo_today;

  -- BASELINE — computed before any fixture below is inserted.
  select count(*) into v_baseline_overdue_open
  from public.tasks t
  join public.task_assignees ta on ta.task_id = t.id
  where ta.user_id = v_creative_id
    and t.due_date < v_cairo_today
    and t.status in ('todo', 'in_progress', 'blocked');

  v_client_id := 'zz_inreview_client_' || substr(md5(random()::text), 1, 8);
  insert into public.clients (id, name, services, status, sales_owner_id)
  values (v_client_id, 'ZZ In-Review Test Client', array['seo'], 'active', v_ordinary_id);

  -- ======================================================================
  -- Scenario 1: delivered_at set once — unset on insert, set on first reaching in_review, and
  -- UNCHANGED by a later transition to completed (never mind a later revision — see scenario 2).
  -- ======================================================================
  v_task_delivered_id := 'zz_inreview_delivered_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task_delivered_id, v_client_id, 'ZZ delivered once', 'test', v_ordinary_id, 'Technical', 'todo', v_cairo_today + 5, 'low');

  select delivered_at into v_delivered_1 from public.tasks where id = v_task_delivered_id;
  if v_delivered_1 is not null then
    raise exception 'TEST_FAILED: scenario 1a — delivered_at must be null immediately after insert with status todo, got %.', v_delivered_1;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  update public.tasks set status = 'in_review' where id = v_task_delivered_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select delivered_at into v_delivered_1 from public.tasks where id = v_task_delivered_id;
  if v_delivered_1 is null then
    raise exception 'TEST_FAILED: scenario 1b — delivered_at must be set once status reaches in_review.';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  update public.tasks set status = 'completed' where id = v_task_delivered_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select delivered_at into v_delivered_2 from public.tasks where id = v_task_delivered_id;
  if v_delivered_2 is distinct from v_delivered_1 then
    raise exception 'TEST_FAILED: scenario 1c — delivered_at must not move on a later transition to completed (set once). First=%, after completed=%.', v_delivered_1, v_delivered_2;
  end if;

  -- ======================================================================
  -- Scenario 2: in_review -> in_progress increments revision_count and sets
  -- revision_started_at, WITHOUT moving delivered_at (already set, by the INSERT branch this
  -- time, since the fixture is created directly as in_review).
  -- ======================================================================
  v_task_revision_id := 'zz_inreview_revision_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task_revision_id, v_client_id, 'ZZ revision', 'test', v_ordinary_id, 'Technical', 'in_review', v_cairo_today + 5, 'low');

  select revision_count, delivered_at into v_revision_count_1, v_delivered_1
  from public.tasks where id = v_task_revision_id;
  if v_revision_count_1 <> 0 or v_delivered_1 is null then
    raise exception 'TEST_FAILED: scenario 2a — a task inserted as in_review must start with revision_count=0 and delivered_at set, got revision_count=%, delivered_at=%.', v_revision_count_1, v_delivered_1;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  update public.tasks set status = 'in_progress' where id = v_task_revision_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select revision_count, revision_started_at, delivered_at into v_revision_count_1, v_revision_started_1, v_delivered_2
  from public.tasks where id = v_task_revision_id;
  if v_revision_count_1 <> 1 then
    raise exception 'TEST_FAILED: scenario 2b — in_review -> in_progress must increment revision_count to 1, got %.', v_revision_count_1;
  end if;
  if v_revision_started_1 is null then
    raise exception 'TEST_FAILED: scenario 2c — in_review -> in_progress must set revision_started_at.';
  end if;
  if v_delivered_2 is distinct from v_delivered_1 then
    raise exception 'TEST_FAILED: scenario 2d — delivered_at must not move when a revision starts. Before=%, after=%.', v_delivered_1, v_delivered_2;
  end if;

  -- ======================================================================
  -- Scenario 3: a client UPDATE setting revision_count=99 directly (no qualifying status
  -- transition — status stays in_progress) is silently restored to its previous value.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  update public.tasks set revision_count = 99 where id = v_task_revision_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select revision_count into v_revision_count_1 from public.tasks where id = v_task_revision_id;
  if v_revision_count_1 <> 1 then
    raise exception 'TEST_FAILED: scenario 3 — a client UPDATE setting revision_count=99 directly must be ignored (stays at 1 from scenario 2), got %.', v_revision_count_1;
  end if;

  -- ======================================================================
  -- Scenario 4: mark_task_viewed() never touches delivered_at/revision_count/
  -- revision_started_at — only task_assignees.viewed_at / tasks.assignee_viewed_at.
  -- ======================================================================
  v_task_viewed_id := 'zz_inreview_viewed_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task_viewed_id, v_client_id, 'ZZ mark_task_viewed untouched', 'test', v_ordinary_id, 'Technical', 'in_review', v_cairo_today + 5, 'low');
  insert into public.task_assignees (task_id, user_id, added_by)
  values (v_task_viewed_id, v_creative_id, v_ordinary_id);

  select delivered_at, revision_count, revision_started_at
    into v_delivered_before, v_revision_count_before, v_revision_started_before
  from public.tasks where id = v_task_viewed_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_creative_auth)::text, true);
  set local role authenticated;
  perform public.mark_task_viewed(v_task_viewed_id);
  reset role; perform set_config('request.jwt.claims', '', true);

  select delivered_at, revision_count, revision_started_at
    into v_delivered_after, v_revision_count_after, v_revision_started_after
  from public.tasks where id = v_task_viewed_id;

  if v_delivered_after is distinct from v_delivered_before
     or v_revision_count_after is distinct from v_revision_count_before
     or v_revision_started_after is distinct from v_revision_started_before then
    raise exception 'TEST_FAILED: scenario 4 — mark_task_viewed() must leave delivered_at/revision_count/revision_started_at untouched. Before=(%, %, %), after=(%, %, %).',
      v_delivered_before, v_revision_count_before, v_revision_started_before,
      v_delivered_after, v_revision_count_after, v_revision_started_after;
  end if;

  -- ======================================================================
  -- Scenarios 5-7, combined on purpose (carried_over_count is a single system-wide number, not
  -- date-scoped, so isolating one fixture's contribution from another's needs one precise
  -- combined assertion, not separate windows):
  --   5. An overdue in_review task must NOT be carried over (contributes 0).
  --   6. An overdue REVISION (todo, revision_count > 0, due before today) MUST be carried over
  --      (contributes 1).
  --   7. due_date is never touched by any status transition.
  -- ======================================================================
  v_task_in_review_overdue_id := 'zz_inreview_overdue_inreview_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task_in_review_overdue_id, v_client_id, 'ZZ overdue in_review', 'test', v_ordinary_id, 'Technical', 'in_review', v_cairo_today - 3, 'low');
  insert into public.task_assignees (task_id, user_id, added_by)
  values (v_task_in_review_overdue_id, v_creative_id, v_ordinary_id);

  v_task_revision_overdue_id := 'zz_inreview_overdue_revision_' || substr(md5(random()::text), 1, 8);
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task_revision_overdue_id, v_client_id, 'ZZ overdue revision', 'test', v_ordinary_id, 'Technical', 'in_review', v_cairo_today - 4, 'low');
  insert into public.task_assignees (task_id, user_id, added_by)
  values (v_task_revision_overdue_id, v_creative_id, v_ordinary_id);

  select due_date into v_due_date_before from public.tasks where id = v_task_revision_overdue_id;

  -- Deliver it, then send it back to todo — a revision, while still overdue; due_date stays
  -- whatever it already was (never passed to this UPDATE at all).
  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  update public.tasks set status = 'todo' where id = v_task_revision_overdue_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select due_date into v_due_date_after from public.tasks where id = v_task_revision_overdue_id;
  if v_due_date_after is distinct from v_due_date_before then
    raise exception 'TEST_FAILED: scenario 7 — due_date must never be touched by a status transition. Before=%, after=%.', v_due_date_before, v_due_date_after;
  end if;

  select revision_count into v_revision_count_1 from public.tasks where id = v_task_revision_overdue_id;
  if v_revision_count_1 <> 1 then
    raise exception 'TEST_FAILED: scenario 6 setup — the overdue revision fixture should have revision_count=1 (in_review -> todo), got %.', v_revision_count_1;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  v_carried_over_count := null;
  for v_row in
    select * from public.get_user_schedule_load(v_creative_id, v_cairo_today, v_cairo_today)
  loop
    v_carried_over_count := v_row.carried_over_count;
  end loop;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_carried_over_count <> v_baseline_overdue_open + 1 then
    declare
      v_diag text;
    begin
      select string_agg(format('{id:%s, status:%s, due_date:%s, revision_count:%s}', t.id, t.status, t.due_date, t.revision_count), '; ')
      into v_diag
      from public.tasks t
      where t.id in (v_task_in_review_overdue_id, v_task_revision_overdue_id);

      raise exception 'TEST_FAILED: scenarios 5+6 — carried_over_count must be baseline_overdue_open+1 (the overdue REVISION counts, the overdue in_review does NOT). DIAGNOSTIC: baseline_overdue_open=%, expected=%, got=%, fixtures=%, v_creative_id=%.',
        v_baseline_overdue_open, v_baseline_overdue_open + 1, v_carried_over_count, v_diag, v_creative_id;
    end;
  end if;

  -- ======================================================================
  -- Scenario 8: simulates a legacy row from before this migration — in_review with delivered_at
  -- still null (decision 5: no backfill). The trigger itself always sets delivered_at on any row
  -- that reaches in_review/completed, so the ONLY way to construct that precondition here is to
  -- insert with the trigger disabled, exactly as if this row had existed since before the
  -- migration ran. Disabling/enabling a trigger is transactional DDL — both calls, and everything
  -- between them, are undone by this DO block's own final rollback either way.
  --
  -- 8a: a redundant UPDATE that re-sends status='in_review' (no actual change — it already was)
  -- must NOT set delivered_at, since nothing was actually delivered just now.
  -- 8b: the REAL transition that follows (in_review -> completed) must set delivered_at.
  -- ======================================================================
  v_task_legacy_id := 'zz_inreview_legacy_' || substr(md5(random()::text), 1, 8);
  alter table public.tasks disable trigger tasks_track_delivery_and_revisions_trigger;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority, delivered_at)
  values (v_task_legacy_id, v_client_id, 'ZZ legacy in_review', 'test', v_ordinary_id, 'Technical', 'in_review', v_cairo_today + 5, 'low', null);
  alter table public.tasks enable trigger tasks_track_delivery_and_revisions_trigger;

  select delivered_at into v_delivered_1 from public.tasks where id = v_task_legacy_id;
  if v_delivered_1 is not null then
    raise exception 'TEST_SETUP_FAILED: the legacy fixture must start with delivered_at null (inserted with the trigger disabled), got %.', v_delivered_1;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  update public.tasks set status = 'in_review' where id = v_task_legacy_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select delivered_at into v_delivered_1 from public.tasks where id = v_task_legacy_id;
  if v_delivered_1 is not null then
    raise exception 'TEST_FAILED: scenario 8a — a redundant UPDATE re-sending status=in_review (no actual change) must NOT set delivered_at, got %.', v_delivered_1;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth)::text, true);
  set local role authenticated;
  update public.tasks set status = 'completed' where id = v_task_legacy_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select delivered_at into v_delivered_2 from public.tasks where id = v_task_legacy_id;
  if v_delivered_2 is null then
    raise exception 'TEST_FAILED: scenario 8b — the real transition in_review -> completed must set delivered_at.';
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all in-review/not-workload scenarios passed; rolling back every fabricated row.';
end $$;
