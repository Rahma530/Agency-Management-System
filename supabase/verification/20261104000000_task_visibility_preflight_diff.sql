-- ============================================================================
-- PREFLIGHT diagnostic — run AFTER 20261104000000_task_visibility_functions.sql is applied,
-- BEFORE 20261104100000_task_visibility_cutover.sql. NOT a migration — lives outside
-- supabase/migrations/ so nothing ever applies it automatically.
--
-- Pure read-only: no row is inserted, updated, or deleted anywhere.
--
-- IMPORTANT: this intentionally does NOT `set local role authenticated`. Only
-- request.jwt.claims is set, so app_user_id()/app_user_role()/app_user_team() resolve to the
-- simulated user (those functions read the JWT claim directly, with no role dependency), while
-- the outer `from public.tasks t` itself still runs as the admin/service connection and so is
-- NOT filtered by tasks_select_rls. That's deliberate: switching to `authenticated` would make
-- this query only ever see tasks already visible to the caller under the CURRENT policy, which
-- forces "gained" to always be 0 — exactly backwards for a diff that's supposed to show both
-- losses and gains. Evaluating task_visible()/task_visible_v2() per row over the FULL,
-- unfiltered table is what makes both directions of the diff meaningful.
--
-- For every active employee with an auth_id: counts tasks visible under the CURRENT policy
-- formula (task_visible(assigned_to, parent_task_id, client_id) OR the creator carve-out —
-- exactly what tasks_select_rls evaluates today) versus the NEW task_visible_v2(id); the exact
-- count LOST (visible today, not after cutover) and GAINED (not visible today, visible after);
-- and, for any user with lost > 0, up to 5 example lost tasks (id, title, status, client_id,
-- creator name, assignee names) so you can see exactly which rows are affected, not just a count.
--
-- The whole report is raised as a single exception so it prints in one shot in the SQL Editor;
-- nothing persists because nothing was ever written, but the final RAISE still follows the same
-- "TEST_OK_ROLLED_BACK" convention as every other verification file in this project for
-- consistency. Read the message, don't worry about the "error" framing.
-- ============================================================================
do $$
declare
  r record;
  lost_task record;
  v_old_count int;
  v_new_count int;
  v_lost int;
  v_gained int;
  v_report text := '';
  v_users_checked int := 0;
  v_lost_line text;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);

  for r in
    select id, name, role, team, auth_id
    from public.users
    where auth_id is not null and deactivated_at is null
    order by role, team, name
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.auth_id)::text, true);

    select
      count(*) filter (where old_visible),
      count(*) filter (where new_visible),
      count(*) filter (where old_visible and not new_visible),
      count(*) filter (where new_visible and not old_visible)
    into v_old_count, v_new_count, v_lost, v_gained
    from (
      select
        (
          public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
          or (t.created_by = public.app_user_id() and public.app_user_role() <> 'sales')
        ) as old_visible,
        public.task_visible_v2(t.id) as new_visible
      from public.tasks t
    ) sub;

    v_users_checked := v_users_checked + 1;
    v_report := v_report || format(
      E'\n%-28s | role=%-22s team=%-20s | old=%-4s new=%-4s lost=%-4s gained=%-4s',
      r.name, r.role, coalesce(r.team, '(none)'), v_old_count, v_new_count, v_lost, v_gained
    );

    if v_lost > 0 then
      for lost_task in
        select
          t.id, t.title, t.status, t.client_id,
          creator.name as creator_name,
          coalesce(
            (select string_agg(au.name, ', ') from public.task_assignees ta join public.users au on au.id = ta.user_id where ta.task_id = t.id),
            '(none)'
          ) as assignee_names
        from public.tasks t
        left join public.users creator on creator.id = t.created_by
        where (
          public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
          or (t.created_by = public.app_user_id() and public.app_user_role() <> 'sales')
        )
        and not public.task_visible_v2(t.id)
        limit 5
      loop
        v_lost_line := format(
          E'\n    LOST: id=%s title=%s status=%s client_id=%s creator=%s assignees=%s',
          lost_task.id, lost_task.title, lost_task.status, lost_task.client_id,
          coalesce(lost_task.creator_name, '(unknown)'), lost_task.assignee_names
        );
        v_report := v_report || v_lost_line;
      end loop;
    end if;

    perform set_config('request.jwt.claims', '', true);
  end loop;

  raise exception 'TEST_OK_ROLLED_BACK: PREFLIGHT VISIBILITY DIFF — % active users checked (nothing written, read-only; up to 5 example lost tasks listed under any user with lost > 0).%',
    v_users_checked, v_report;
end $$;
