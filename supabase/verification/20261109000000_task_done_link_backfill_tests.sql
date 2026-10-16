-- ============================================================================
-- FUNCTION TESTS for 20261109000000_task_done_link_backfill.sql. NOT a migration — lives outside
-- supabase/migrations/ so nothing ever applies it automatically.
--
-- Run this AFTER the migration is applied, as a single statement (psql -f, or pasted whole into
-- the SQL editor) — no surrounding BEGIN/COMMIT needed. This is a plain data backfill, not an
-- RLS/RPC change, so there is no persona impersonation here — every scenario fabricates only
-- throwaway tasks (zz_ prefixed ids) on a throwaway client, created by a real active employee
-- (selected defensively — TEST_SETUP_FAILED, naming exactly what's missing). The final
-- `raise exception 'TEST_OK_ROLLED_BACK: ...'` aborts the implicit transaction wrapping this whole
-- DO block, rolling back every single write performed above it — nothing persists either way,
-- pass or fail.
--
-- Before fabricating anything, this also prints a PREVIEW COUNT via RAISE NOTICE: how many REAL,
-- already-existing rows the migration's UPDATE would touch (done_link blank, drive_link
-- non-blank) — run this once against the live database before applying the migration to see the
-- actual blast radius; it is read-only and changes nothing.
--
-- Coverage: done_link backfilled from drive_link only when done_link is null/blank; an existing
-- non-blank done_link is never overwritten, even if it differs from drive_link; a blank
-- (whitespace-only) drive_link never backfills anything; a task with no drive_link at all is a
-- no-op; re-running the migration's UPDATE a second time changes nothing further (idempotent);
-- and — backing up the migration's own trigger-audit comment with an actual behavioral check —
-- running it against a task that HAS an assignee causes no notification, no task_assignees
-- change, and no tasks.assigned_to change (scenario 6).
-- ============================================================================
do $$
declare
  v_creator_id text; v_creator_auth uuid;

  v_client_id text;
  v_task_blank_id text;      -- done_link blank, drive_link set -> should backfill
  v_task_existing_id text;   -- done_link already set -> must NOT be overwritten
  v_task_no_drive_id text;   -- drive_link null -> no-op
  v_task_blank_drive_id text; -- drive_link whitespace-only -> must NOT backfill
  v_task_sideeffect_id text; -- has an assignee -> backfill UPDATE must not disturb it
  v_preview_count integer;
  v_result_done_link text;
  v_notifications_before integer;
  v_notifications_after integer;
  v_task_assignees_before integer;
  v_task_assignees_after integer;
  v_assigned_to_before text;
  v_assigned_to_after text;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Preview (read-only, runs against REAL data, before any fabrication below).
  -- ======================================================================
  select count(*) into v_preview_count
  from public.tasks
  where (done_link is null or btrim(done_link) = '')
    and drive_link is not null
    and btrim(drive_link) <> '';
  raise notice 'PREVIEW: % existing task row(s) have a non-blank drive_link and a blank done_link — the migration''s UPDATE will set done_link on exactly these.', v_preview_count;

  -- ======================================================================
  -- Setup: one real active employee to act as creator.
  -- ======================================================================
  select id, auth_id into v_creator_id, v_creator_auth
    from public.users where auth_id is not null and deactivated_at is null order by id limit 1;
  if v_creator_id is null then
    raise exception 'TEST_SETUP_FAILED: need one active employee with auth_id.';
  end if;

  -- ======================================================================
  -- Fabricate a throwaway client and 4 throwaway tasks covering each scenario.
  -- ======================================================================
  v_client_id := 'zz_donelink_client_' || substr(md5(random()::text), 1, 8);
  insert into public.clients (id, name, services, status, sales_owner_id)
  values (v_client_id, 'ZZ Done Link Backfill Test Client', array['seo'], 'active', v_creator_id);

  v_task_blank_id := 'zz_donelink_blank_' || substr(md5(random()::text), 1, 8);
  v_task_existing_id := 'zz_donelink_existing_' || substr(md5(random()::text), 1, 8);
  v_task_no_drive_id := 'zz_donelink_nodrive_' || substr(md5(random()::text), 1, 8);
  v_task_blank_drive_id := 'zz_donelink_blankdrive_' || substr(md5(random()::text), 1, 8);
  v_task_sideeffect_id := 'zz_donelink_sideeffect_' || substr(md5(random()::text), 1, 8);

  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority, drive_link, done_link)
  values
    (v_task_blank_id, v_client_id, 'ZZ blank done_link', 'test', v_creator_id, 'Technical', 'todo', current_date, 'low', 'https://drive.example.com/blank-case', null),
    (v_task_existing_id, v_client_id, 'ZZ existing done_link', 'test', v_creator_id, 'Technical', 'todo', current_date, 'low', 'https://drive.example.com/existing-case', 'https://existing.example.com/already-set'),
    (v_task_no_drive_id, v_client_id, 'ZZ no drive_link', 'test', v_creator_id, 'Technical', 'todo', current_date, 'low', null, null),
    (v_task_blank_drive_id, v_client_id, 'ZZ blank drive_link', 'test', v_creator_id, 'Technical', 'todo', current_date, 'low', '   ', null);

  -- Fabricated separately, with assigned_to set at INSERT time — this fires the (unrelated)
  -- forward sync trigger once, creating its own task_assignees row. Scenario 6 below captures a
  -- baseline AFTER this insert, so that trigger's own effect is excluded from what it checks.
  insert into public.tasks (id, client_id, title, description, assigned_to, created_by, team, status, due_date, priority, drive_link, done_link)
  values (v_task_sideeffect_id, v_client_id, 'ZZ side-effect check', 'test', v_creator_id, v_creator_id, 'Technical', 'todo', current_date, 'low', 'https://drive.example.com/sideeffect-case', null);

  -- ======================================================================
  -- Snapshot, immediately before the backfill UPDATE, of everything the trigger audit claims
  -- won't move: global notifications count, this task's task_assignees rows, and its
  -- tasks.assigned_to value.
  -- ======================================================================
  select count(*) into v_notifications_before from public.notifications;
  select count(*) into v_task_assignees_before from public.task_assignees where task_id = v_task_sideeffect_id;
  select assigned_to into v_assigned_to_before from public.tasks where id = v_task_sideeffect_id;

  -- ======================================================================
  -- Run the migration's exact UPDATE statement.
  -- ======================================================================
  update public.tasks
  set done_link = drive_link
  where (done_link is null or btrim(done_link) = '')
    and drive_link is not null
    and btrim(drive_link) <> '';

  -- ======================================================================
  -- Scenario 6: the same UPDATE, applied to a task that HAS an assignee, causes no notification,
  -- no task_assignees change, and no tasks.assigned_to change — confirming the migration's own
  -- trigger-audit comment (neither tasks trigger's column list includes done_link).
  -- ======================================================================
  select count(*) into v_notifications_after from public.notifications;
  select count(*) into v_task_assignees_after from public.task_assignees where task_id = v_task_sideeffect_id;
  select assigned_to into v_assigned_to_after from public.tasks where id = v_task_sideeffect_id;

  if v_notifications_after <> v_notifications_before then
    raise exception 'TEST_FAILED: scenario 6 — the done_link backfill must never create a notification, but the global count changed from % to %.', v_notifications_before, v_notifications_after;
  end if;
  if v_task_assignees_after <> v_task_assignees_before then
    raise exception 'TEST_FAILED: scenario 6b — the done_link backfill must never change task_assignees membership, but this task''s row count changed from % to %.', v_task_assignees_before, v_task_assignees_after;
  end if;
  if v_assigned_to_after is distinct from v_assigned_to_before then
    raise exception 'TEST_FAILED: scenario 6c — the done_link backfill must never change tasks.assigned_to, but it went from % to %.', v_assigned_to_before, v_assigned_to_after;
  end if;
  select done_link into v_result_done_link from public.tasks where id = v_task_sideeffect_id;
  if v_result_done_link <> 'https://drive.example.com/sideeffect-case' then
    raise exception 'TEST_FAILED: scenario 6d — this task''s own done_link should still have been backfilled, got %.', v_result_done_link;
  end if;

  -- ======================================================================
  -- Scenario 1: blank done_link + non-blank drive_link -> backfilled.
  -- ======================================================================
  select done_link into v_result_done_link from public.tasks where id = v_task_blank_id;
  if v_result_done_link <> 'https://drive.example.com/blank-case' then
    raise exception 'TEST_FAILED: scenario 1 — expected done_link to be backfilled from drive_link, got %.', v_result_done_link;
  end if;

  -- ======================================================================
  -- Scenario 2: already-set done_link -> left untouched, even though it differs from drive_link.
  -- ======================================================================
  select done_link into v_result_done_link from public.tasks where id = v_task_existing_id;
  if v_result_done_link <> 'https://existing.example.com/already-set' then
    raise exception 'TEST_FAILED: scenario 2 — an existing done_link must never be overwritten, got %.', v_result_done_link;
  end if;

  -- ======================================================================
  -- Scenario 3: no drive_link at all -> done_link stays null (no-op).
  -- ======================================================================
  select done_link into v_result_done_link from public.tasks where id = v_task_no_drive_id;
  if v_result_done_link is not null then
    raise exception 'TEST_FAILED: scenario 3 — a task with no drive_link must stay with a null done_link, got %.', v_result_done_link;
  end if;

  -- ======================================================================
  -- Scenario 4: whitespace-only drive_link -> must NOT backfill (btrim(drive_link) <> '' guard).
  -- ======================================================================
  select done_link into v_result_done_link from public.tasks where id = v_task_blank_drive_id;
  if v_result_done_link is not null then
    raise exception 'TEST_FAILED: scenario 4 — a whitespace-only drive_link must never backfill done_link, got %.', v_result_done_link;
  end if;

  -- ======================================================================
  -- Scenario 5: idempotency — running the exact same UPDATE again changes nothing further.
  -- ======================================================================
  update public.tasks
  set done_link = drive_link
  where (done_link is null or btrim(done_link) = '')
    and drive_link is not null
    and btrim(drive_link) <> '';

  select done_link into v_result_done_link from public.tasks where id = v_task_blank_id;
  if v_result_done_link <> 'https://drive.example.com/blank-case' then
    raise exception 'TEST_FAILED: scenario 5 — re-running the backfill must be a no-op on an already-backfilled row, got %.', v_result_done_link;
  end if;
  select done_link into v_result_done_link from public.tasks where id = v_task_existing_id;
  if v_result_done_link <> 'https://existing.example.com/already-set' then
    raise exception 'TEST_FAILED: scenario 5b — re-running the backfill must still never touch an existing done_link, got %.', v_result_done_link;
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all done_link backfill scenarios passed; rolling back every fabricated row (preview count above was read-only and reflects real, unmodified data).';
end $$;
