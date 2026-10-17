-- Verification for 20261119000000_capacity_snapshot_v2.sql.
--
-- Single DO block, real personas, ends in a raised exception so every fabricated change (test
-- clients, assignments, tasks, and the one status update) is rolled back regardless of outcome:
-- TEST_OK_ROLLED_BACK on success, a descriptive TEST_FAILED/TEST_SETUP_FAILED exception otherwise.
--
-- Every impersonation sets request.jwt.claims to {"sub": ..., "role": "authenticated"} and
-- self-checks auth.role() right after switching Postgres role, per this session's established
-- pattern. Every delta check reads get_capacity_snapshot BEFORE and AFTER the change under test,
-- rather than asserting an absolute count — real, pre-existing production data for these same
-- real persona accounts must never make a test pass or fail by accident.
--
-- Every exception handler re-raises unconditionally on its own TEST_FAILED/TEST_SETUP_FAILED
-- marker BEFORE checking the real rejection text, so a bug that lets a rejected call silently
-- succeed can never be mistaken for a pass via a loose substring match.
--
-- public.assignments is NOT separately exercised here: assignments_insert_rls is itself scoped to
-- the caller's own department role AND requires agent_id's role to belong to that same service's
-- department (seo/media_buying/social_media) — an am_agent (this file's "else"-branch persona)
-- can never legitimately be the agent_id on an assignments row at all, so fabricating one for this
-- test would need a second, department-matched persona and an existing client already subscribed
-- to that service, for no behavior this requested scenario list actually asks to prove. Scenario 5
-- below proves the UNION's de-duplication via its other two sources (clients.am_agent_id and a
-- workload-open task_assignees task), which is exactly "the same client from two sources counted
-- once" as asked — the migration's own header documents why assignments is still in the UNION.
do $$
declare
  v_client_id text;
  v_agent_id text;      -- a non-creative, non-TL role (am_agent) — the "else" branch
  v_agent_auth uuid;
  v_tl_id text;         -- a team-lead role with capacity_limit = 0 specifically
  v_tl_auth uuid;
  v_designer_id text;   -- ui_designer — the creative branch
  v_designer_auth uuid;
  v_sales_id text;
  v_sales_auth uuid;
  v_before integer;
  v_after integer;
  v_client1_id text := 'zz_cap_c1_' || substr(md5(random()::text), 1, 8);
  v_client2_id text := 'zz_cap_c2_' || substr(md5(random()::text), 1, 8);
  v_task1_id text := 'zz_cap_t1_' || substr(md5(random()::text), 1, 8);
  v_task2_id text := 'zz_cap_t2_' || substr(md5(random()::text), 1, 8);
  v_task3_id text := 'zz_cap_t3_' || substr(md5(random()::text), 1, 8);
begin
  select id into v_client_id from public.clients limit 1;
  if v_client_id is null then
    raise exception 'TEST_SETUP_FAILED: no client row found at all.';
  end if;

  select id, auth_id into v_agent_id, v_agent_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_agent_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_agent persona found.';
  end if;

  -- The one TL account known to carry capacity_limit = 0 live (am_team_lead) — if that's changed,
  -- any of the 4 TL roles with capacity_limit = 0 still proves the same thing: the RPC itself
  -- never reads capacity_limit at all, so a real, non-zero count must come back regardless.
  select id, auth_id into v_tl_id, v_tl_auth from public.users
  where role in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
    and auth_id is not null and deactivated_at is null and coalesce(capacity_limit, 0) = 0
  limit 1;
  if v_tl_id is null then
    raise exception 'TEST_SETUP_FAILED: no active team-lead persona with capacity_limit = 0 found.';
  end if;

  select id, auth_id into v_designer_id, v_designer_auth from public.users
  where role = 'ui_designer' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_designer_id is null then
    raise exception 'TEST_SETUP_FAILED: no active ui_designer persona found.';
  end if;

  select id, auth_id into v_sales_id, v_sales_auth from public.users
  where role = 'sales' and auth_id is not null and deactivated_at is null
  limit 1;
  if v_sales_id is null then
    raise exception 'TEST_SETUP_FAILED: no active sales persona found.';
  end if;

  -- ======================================================================
  -- Scenario 1: sales is rejected outright — exact rejection text, no partial-match.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 1).';
  end if;
  begin
    perform public.get_capacity_snapshot(array[v_agent_id]);
    raise exception 'TEST_FAILED: scenario 1 — a sales caller must be rejected by get_capacity_snapshot.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' or sqlerrm like 'TEST_SETUP_FAILED%' then
      raise;
    end if;
    if sqlerrm is distinct from 'sales may not query capacity data.' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 2: ui_designer is measured by today's delivered count (Africa/Cairo), not by the
  -- else branch's client-membership formula. delivered_at is entirely trigger-owned
  -- (track_delivery_and_revisions(), 20261112000000_in_review_not_workload.sql) — it cannot be
  -- set directly by any UPDATE, is stamped to now() only on a real transition INTO
  -- in_review/completed, and is immutable afterward — so this proves the branch the only way
  -- that trigger allows: a task still 'todo' (delivered_at null) contributes 0, and the SAME
  -- task reaching in_review (delivered_at stamped to now(), today) contributes exactly 1 —
  -- which also shows the creative branch does NOT count a merely-assigned, not-yet-delivered
  -- task the way the else branch's workload-open membership would.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 2 setup, creator).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task1_id, v_client_id, 'ZZ capacity test delivered-today', 'test', v_agent_id, 'Creative & Design', 'todo', current_date + 5, 'low');
  perform public.set_task_assignees(v_task1_id, array[v_designer_id]);
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_designer_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 2a).';
  end if;
  select used_capacity into v_before from public.get_capacity_snapshot(array[v_designer_id]) where user_id = v_designer_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_designer_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 2b).';
  end if;
  update public.tasks set status = 'in_review' where id = v_task1_id;
  select used_capacity into v_after from public.get_capacity_snapshot(array[v_designer_id]) where user_id = v_designer_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_after - v_before <> 1 then
    raise exception 'TEST_FAILED: scenario 2 — reaching in_review (stamping delivered_at to now()) must add exactly 1 to a ui_designer''s capacity, before % after %.', v_before, v_after;
  end if;

  -- ======================================================================
  -- Scenario 3: in_review is not workload — a task in in_review on an otherwise-unreachable
  -- client must not count for v_agent_id (am_agent, the "else" branch), but the same task
  -- reaching in_progress (workload-open) must.
  -- ======================================================================
  -- clients_insert_leadership_rls only accepts executive/head_of_technical/ai_engineer/
  -- am_team_lead as the inserting caller (am_agent is not in that list) — v_tl_auth creates the
  -- client, then v_agent_auth creates/assigns the task on it, same split real registration flows
  -- already use (a team lead or admin registers a client; an agent is then assigned work on it).
  perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 3 setup, client).';
  end if;
  insert into public.clients (id, name, status)
  values (v_client1_id, 'ZZ Capacity Test Client 1', 'active');
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 3 setup, task).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task2_id, v_client1_id, 'ZZ capacity test in_review', 'test', v_agent_id, 'Account Management', 'in_review', current_date + 5, 'low');
  perform public.set_task_assignees(v_task2_id, array[v_agent_id]);

  select used_capacity into v_before from public.get_capacity_snapshot(array[v_agent_id]) where user_id = v_agent_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_before is null then
    raise exception 'TEST_SETUP_FAILED: get_capacity_snapshot returned no row for v_agent_id (scenario 3 baseline).';
  end if;

  -- v_client1_id is reachable ONLY via this in_review task (no am_agent_id, no assignments row)
  -- — the baseline just captured above must already exclude it, so the real check is that
  -- flipping the SAME task to in_progress is what finally adds it.
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 3b).';
  end if;
  update public.tasks set status = 'in_progress' where id = v_task2_id;
  select used_capacity into v_after from public.get_capacity_snapshot(array[v_agent_id]) where user_id = v_agent_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_after - v_before <> 1 then
    raise exception 'TEST_FAILED: scenario 3 — client1 must be excluded while its only task is in_review and included once that task reaches in_progress; before %, after %.', v_before, v_after;
  end if;

  -- ======================================================================
  -- Scenario 4: closed/paused clients never count, even when otherwise reachable. v_client1_id
  -- is now reachable via the in_progress task from scenario 3 above — pausing it must drop the
  -- count back down, and reactivating it must restore it.
  --
  -- clients_update_am_assignment_rls (the only UPDATE policy on public.clients) accepts
  -- executive/head_of_technical/ai_engineer/am_team_lead, or sales for their own client — am_agent
  -- is not in that list, so these status updates run as v_tl_auth, not v_agent_auth.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 4a).';
  end if;
  update public.clients set status = 'paused' where id = v_client1_id;
  select used_capacity into v_after from public.get_capacity_snapshot(array[v_agent_id]) where user_id = v_agent_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_after <> v_before then
    raise exception 'TEST_FAILED: scenario 4a — a paused client must not count even with a workload-open task, expected %, got %.', v_before, v_after;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 4b).';
  end if;
  update public.clients set status = 'active' where id = v_client1_id;
  select used_capacity into v_after from public.get_capacity_snapshot(array[v_agent_id]) where user_id = v_agent_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_after - v_before <> 1 then
    raise exception 'TEST_FAILED: scenario 4b — reactivating the client must restore the count, before %, after %.', v_before, v_after;
  end if;

  -- ======================================================================
  -- Scenario 5: the SAME client reachable via TWO sources at once (clients.am_agent_id AND a
  -- workload-open task_assignees task, both for the same agent) must still count exactly once —
  -- distinct, not summed. (See this file's header for why public.assignments, the UNION's third
  -- source, isn't separately exercised here.)
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 5 setup, client).';
  end if;
  insert into public.clients (id, name, status, am_agent_id)
  values (v_client2_id, 'ZZ Capacity Test Client 2', 'active', v_agent_id);
  reset role; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 5 baseline).';
  end if;
  select used_capacity into v_before from public.get_capacity_snapshot(array[v_agent_id]) where user_id = v_agent_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- Second source: a workload-open task on the SAME client, assigned to the SAME agent — must
  -- add 0 (not 1), since am_agent_id already counted this client in the baseline above.
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 5b).';
  end if;
  insert into public.tasks (id, client_id, title, description, created_by, team, status, due_date, priority)
  values (v_task3_id, v_client2_id, 'ZZ capacity test dedupe', 'test', v_agent_id, 'Account Management', 'todo', current_date + 5, 'low');
  perform public.set_task_assignees(v_task3_id, array[v_agent_id]);
  select used_capacity into v_after from public.get_capacity_snapshot(array[v_agent_id]) where user_id = v_agent_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_after <> v_before then
    raise exception 'TEST_FAILED: scenario 5 — client2 reachable via BOTH am_agent_id and a workload-open task_assignees task must still count exactly once (no change once the second source is added), before %, after %.', v_before, v_after;
  end if;

  -- ======================================================================
  -- Scenario 6: a team-lead role with capacity_limit = 0 still returns a real, non-null count —
  -- proving the RPC never reads/applies capacity_limit at all (that's a UI-layer decision, out of
  -- scope for this function).
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 6).';
  end if;
  select used_capacity into v_after from public.get_capacity_snapshot(array[v_tl_id]) where user_id = v_tl_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_after is null then
    raise exception 'TEST_FAILED: scenario 6 — a team lead with capacity_limit = 0 must still get a real row back, got null.';
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all capacity_snapshot_v2 scenarios passed; rolling back every fabricated change.';
end $$;
