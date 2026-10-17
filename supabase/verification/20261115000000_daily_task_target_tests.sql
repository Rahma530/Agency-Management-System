-- Verification for 20261115000000_daily_task_target.sql.
--
-- Single DO block, distinct real personas, ends in a raised exception so every change is rolled
-- back regardless of outcome: TEST_OK_ROLLED_BACK on success, a descriptive TEST_FAILED/
-- TEST_SETUP_FAILED exception otherwise.
--
-- Every impersonation below sets request.jwt.claims to {"sub": ..., "role": "authenticated"},
-- not just {"sub": ...} — users_update_guard() (the trigger backing scenarios 4/6/7 below)
-- short-circuits with a bare `return new` (no rule enforced at all) whenever
-- `auth.role() is distinct from 'authenticated'`, and auth.role() reads the JWT's own "role"
-- claim from request.jwt.claims, NOT the Postgres session role `set local role authenticated`
-- switches to (a separate mechanism, for RLS) — confirmed by that trigger's own header comment in
-- 20261030000000_users_update_guard_trigger.sql ("auth.role() reads the JWT's own `role` claim
-- via current_setting('request.jwt.claims', ...)"). Omitting it does not fail loudly: the trigger
-- just no-ops, so a self-edit silently succeeds instead of being rejected — exactly what produced
-- a false TEST_FAILED on scenario 4 before this fix. Each impersonation block below self-checks
-- auth.role() right after switching role, so any future regression here fails at
-- TEST_SETUP_FAILED instead of masquerading as a real scenario failure.
do $$
declare
  v_admin_id text;
  v_admin_auth uuid;
  v_tl_id text;
  v_tl_auth uuid;
  v_agent_id text;
  v_ordinary_id text;
  v_ordinary_auth uuid;
  v_seo_tl_id text;
  v_seo_tl_auth uuid;
  v_store_manager_id text;
  v_after integer;
  v_affected integer;
  v_role_after text;
begin
  select id, auth_id into v_admin_id, v_admin_auth from public.users
  where role in ('executive', 'head_of_technical') and auth_id is not null and deactivated_at is null
  limit 1;
  if v_admin_id is null then
    raise exception 'TEST_SETUP_FAILED: no active executive/head_of_technical persona found.';
  end if;

  select id, auth_id into v_tl_id, v_tl_auth from public.users
  where role = 'am_team_lead' and auth_id is not null and deactivated_at is null and id <> v_admin_id
  limit 1;
  if v_tl_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_team_lead persona found.';
  end if;

  select id into v_agent_id from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_tl_id
  limit 1;
  if v_agent_id is null then
    raise exception 'TEST_SETUP_FAILED: no active am_agent persona found.';
  end if;

  select id, auth_id into v_ordinary_id, v_ordinary_auth from public.users
  where role = 'am_agent' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_tl_id and id <> v_agent_id
  limit 1;
  if v_ordinary_id is null then
    raise exception 'TEST_SETUP_FAILED: need a second active am_agent persona distinct from the scoped target.';
  end if;

  select id, auth_id into v_seo_tl_id, v_seo_tl_auth from public.users
  where role = 'seo_team_lead' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_tl_id and id <> v_agent_id and id <> v_ordinary_id
  limit 1;
  if v_seo_tl_id is null then
    raise exception 'TEST_SETUP_FAILED: no active seo_team_lead persona found.';
  end if;

  select id into v_store_manager_id from public.users
  where role = 'store_manager' and auth_id is not null and deactivated_at is null
    and id <> v_admin_id and id <> v_tl_id and id <> v_agent_id and id <> v_ordinary_id and id <> v_seo_tl_id
  limit 1;
  if v_store_manager_id is null then
    raise exception 'TEST_SETUP_FAILED: no active store_manager persona found.';
  end if;

  -- ======================================================================
  -- Scenario 1: executive/head_of_technical sets an in-scope employee's target — succeeds.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 1).';
  end if;
  update public.users set daily_task_target = 10 where id = v_agent_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select daily_task_target into v_after from public.users where id = v_agent_id;
  if v_after <> 10 then
    raise exception 'TEST_FAILED: scenario 1 — admin must be able to set an in-scope employee''s daily_task_target, got %.', v_after;
  end if;

  -- ======================================================================
  -- Scenario 2: the am_team_lead sets it for their own department's am_agent — succeeds.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 2).';
  end if;
  update public.users set daily_task_target = 8 where id = v_agent_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select daily_task_target into v_after from public.users where id = v_agent_id;
  if v_after <> 8 then
    raise exception 'TEST_FAILED: scenario 2 — a team lead must be able to set a target for their own department''s agent, got %.', v_after;
  end if;

  -- ======================================================================
  -- Scenario 3: an ordinary am_agent (neither admin nor a team lead) tries to set someone else's
  -- target — rejected silently by RLS (that role is not in the allowed list at all): 0 rows
  -- affected, value unchanged, no exception raised.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_ordinary_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 3).';
  end if;
  update public.users set daily_task_target = 20 where id = v_agent_id;
  get diagnostics v_affected = row_count;
  reset role; perform set_config('request.jwt.claims', '', true);

  if v_affected <> 0 then
    raise exception 'TEST_FAILED: scenario 3 — an ordinary am_agent must not be able to update anyone''s daily_task_target (RLS), % row(s) affected.', v_affected;
  end if;
  select daily_task_target into v_after from public.users where id = v_agent_id;
  if v_after <> 8 then
    raise exception 'TEST_FAILED: scenario 3 — the value must be unchanged after the rejected update, got %.', v_after;
  end if;

  -- ======================================================================
  -- Scenario 4 (bonus — the actual point of this migration vs. capacity_limit's own precedent):
  -- the team lead tries to set THEIR OWN target — rejected by the trigger's new Rule 5, not RLS
  -- (employee_manageable()'s self-branch would otherwise let this exact row through).
  -- ======================================================================
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.role() is distinct from 'authenticated' then
      raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 4).';
    end if;
    update public.users set daily_task_target = 5 where id = v_tl_id;
    raise exception 'TEST_FAILED: scenario 4 — a team lead must not be able to set their own daily_task_target.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' or sqlerrm like 'TEST_SETUP_FAILED%' then
      raise;
    end if;
    if sqlerrm is distinct from 'You cannot change your own daily task target.' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Scenario 5: an out-of-range value is rejected by users_daily_task_target_check.
  -- ======================================================================
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin_auth, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.role() is distinct from 'authenticated' then
      raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 5).';
    end if;
    update public.users set daily_task_target = 51 where id = v_agent_id;
    raise exception 'TEST_FAILED: scenario 5 — 51 must be rejected by users_daily_task_target_check.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' or sqlerrm like 'TEST_SETUP_FAILED%' then
      raise;
    end if;
    if sqlstate is distinct from '23514' or sqlerrm not like '%users_daily_task_target_check%' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Regression scenario 6: users_update_guard()'s pre-existing role-change rules must still hold
  -- after this migration's Rule 5 was appended — a team lead trying to change their OWN role is
  -- still rejected with the exact live message "You cannot change your own role.".
  -- ======================================================================
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_tl_auth, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.role() is distinct from 'authenticated' then
      raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 6).';
    end if;
    update public.users set role = 'am_agent' where id = v_tl_id;
    raise exception 'TEST_FAILED: scenario 6 — a team lead must not be able to change their own role.';
  exception when others then
    if sqlerrm like 'TEST_FAILED%' or sqlerrm like 'TEST_SETUP_FAILED%' then
      raise;
    end if;
    if sqlerrm is distinct from 'You cannot change your own role.' then
      raise;
    end if;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);

  -- ======================================================================
  -- Regression scenario 7: an seo_team_lead changing a store_manager's role to seo_agent still
  -- succeeds — proves the live 5-role seo_dept_roles list (including store_manager, not the
  -- stale 4-role list this migration's own file used to carry) is what's actually in effect.
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_seo_tl_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if auth.role() is distinct from 'authenticated' then
    raise exception 'TEST_SETUP_FAILED: auth.role() must read ''authenticated'' from request.jwt.claims (scenario 7).';
  end if;
  update public.users set role = 'seo_agent' where id = v_store_manager_id;
  reset role; perform set_config('request.jwt.claims', '', true);

  select role into v_role_after from public.users where id = v_store_manager_id;
  if v_role_after <> 'seo_agent' then
    raise exception 'TEST_FAILED: scenario 7 — an seo_team_lead must be able to change a store_manager''s role to seo_agent, got %.', v_role_after;
  end if;

  raise exception 'TEST_OK_ROLLED_BACK: all daily_task_target scenarios passed; rolling back every fabricated change.';
end $$;
