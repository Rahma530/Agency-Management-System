-- Incident fix (2026-11-28, Saturday morning): "Report sources changed"/realtime audit led into
-- investigating recurring 42501 ("new row violates row-level security policy for table
-- notifications") errors in the Postgres logs at 11:22/11:24 Cairo time, confirmed via the Logs
-- Explorer's Raw JSON panel to come from a genuine PostgREST 14.5 API request (not a dashboard SQL
-- session, not a cron job — none exists in this project, confirmed by grep across every
-- migration).
--
-- Root problem (confirmed by reading the live function body, not assumed): public.set_task_assignees()
-- (supabase/migrations/20270125100000_optimize_task_management_functions.sql) inserts a
-- 'task_assigned' notification for each newly-added assignee, in the SAME transaction as the
-- public.task_assignees insert/delete that actually performs the assignment — and that
-- notification insert has NO exception handling around it, unlike the sibling function
-- notify_key_task_status_changes() (supabase/migrations/20261129000000_notification_client_name_and_task_link.sql),
-- which already wraps its own notification loop in `exception when others then raise warning`
-- specifically so a notification failure can never take anything else down with it.
--
-- Practical effect of the gap: if the notifications_insert_rls WITH CHECK
-- ((sender_id = app_user_id()) OR (sender_id is null)) is ever violated for any reason, the
-- raised exception is NOT caught anywhere inside set_task_assignees() — so the entire function
-- call rolls back, including the task_assignees insert/delete that had already succeeded earlier
-- in the very same statement. The caller sees a failed RPC call, but the practical symptom
-- reported today was "the task assignment didn't stick" / "task missing for this person" — which
-- matches exactly, since the whole operation is silently undone.
--
-- This migration does not change WHO can be notified or WHEN — only isolates the notification
-- insert so a failure there can never again roll back the actual assignment. The exact trigger
-- for the underlying RLS violation (e.g. a stale/expired session at the moment of the call) is
-- still under investigation separately and is unaffected by this change — this is a containment
-- fix, not a diagnosis of that root cause.
--
-- Verified: the WHERE/validation/assignee-diff logic above the notification insert is copied
-- unchanged from the live function (20270125100000_optimize_task_management_functions.sql) —
-- only the notification insert itself (inside the v_to_add loop) is now wrapped in its own
-- begin/exception block, mirroring notify_key_task_status_changes()'s existing pattern exactly.

begin;

create or replace function public.set_task_assignees(p_task_id text, p_user_ids text[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.tasks;
  v_client_name text;
  v_actor_id text := public.app_user_id();
  v_ordered_ids text[] := array[]::text[];
  v_current_ids text[];
  v_to_add text[] := array[]::text[];
  v_to_remove text[] := array[]::text[];
  v_uid text;
  v_target_role text;
  v_auth_id text;
  v_deactivated_at timestamptz; v_cached_role text; v_cached_team text;
begin
  v_cached_role:=public.app_user_role();
  v_cached_team:=public.app_user_team();

  select * into v_task from public.tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found';
  end if;

  -- Gate — see this function's original migration (20261105000000_task_assignees_rpcs.sql) for
  -- the full rationale. Unchanged by this migration.
  if v_cached_role = 'sales' or not (
    public.task_closable(p_task_id)
    or (
      v_cached_role = 'am_agent'
      and v_task.client_id is not null
      and public.client_am_agent_is_caller(v_task.client_id)
    )
    or (
      v_cached_role = 'am_team_lead'
      and v_task.client_id is not null
      and exists (
        select 1 from public.clients c
        join public.users ua on ua.id = c.am_agent_id
        where c.id = v_task.client_id and ua.team = v_cached_team
      )
    )
    or (
      v_cached_role in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
      and (
        exists (select 1 from public.users u where u.id = v_task.created_by and u.team = v_cached_team)
        or exists (
          select 1 from public.task_assignees ta
          join public.users u on u.id = ta.user_id
          where ta.task_id = p_task_id and u.team = v_cached_team
        )
        or (
          v_cached_role = 'seo_team_lead'
          and (
            exists (select 1 from public.users u where u.id = v_task.created_by and u.team = 'Programming')
            or exists (
              select 1 from public.task_assignees ta
              join public.users u on u.id = ta.user_id
              where ta.task_id = p_task_id and u.team = 'Programming'
            )
          )
        )
      )
    )
  ) then
    raise exception 'You do not have permission to modify this task''s assignees.';
  end if;

  if v_task.client_id is not null then
    select name into v_client_name from public.clients where id = v_task.client_id;
  end if;

  -- Dedupe + drop nulls, preserving first-occurrence order. Order matters: among brand-new
  -- additions below, the first one listed gets the earliest clock_timestamp() and so becomes the
  -- oldest assignee (tasks.assigned_to, via the reverse trigger) if the task had none before.
  foreach v_uid in array coalesce(p_user_ids, array[]::text[]) loop
    if v_uid is not null and not (v_uid = any(v_ordered_ids)) then
      v_ordered_ids := array_append(v_ordered_ids, v_uid);
    end if;
  end loop;

  select coalesce(array_agg(user_id), array[]::text[]) into v_current_ids
  from public.task_assignees where task_id = p_task_id;

  foreach v_uid in array v_ordered_ids loop
    if not (v_uid = any(v_current_ids)) then
      v_to_add := array_append(v_to_add, v_uid);
    end if;
  end loop;

  foreach v_uid in array v_current_ids loop
    if not (v_uid = any(v_ordered_ids)) then
      v_to_remove := array_append(v_to_remove, v_uid);
    end if;
  end loop;

  -- The creator can never be removed from their own task's assignee list — independent of who is
  -- calling, and checked against the diff (not the raw requested list) so it fires exactly when
  -- the creator is CURRENTLY assigned and the new list would drop them.
  if v_task.created_by = any(v_to_remove) then
    raise exception 'The task''s creator cannot be removed from its assignee list.';
  end if;

  if array_length(v_to_add, 1) is null and array_length(v_to_remove, 1) is null then
    return;
  end if;

  -- Validity + escalation guard, applied ONLY to ids actually entering the list (v_to_add) — see
  -- this function's original migration's header comment. A pre-existing assignee is never
  -- re-validated just because the list is being re-saved.
  foreach v_uid in array v_to_add loop
    v_target_role := public.user_role_by_id(v_uid);
    if v_target_role is null then
      raise exception 'User % not found', v_uid;
    end if;
    if v_target_role = 'sales' then
      raise exception 'sales may not be assigned to tasks';
    end if;
    if not (
      v_uid = v_actor_id
      or v_target_role not in ('executive', 'head_of_technical')
      or (v_cached_role = 'executive' and v_target_role = 'head_of_technical')
    ) then
      raise exception 'You are not permitted to assign %.', v_uid;
    end if;

    select auth_id, deactivated_at into v_auth_id, v_deactivated_at
    from public.users where id = v_uid;
    if v_auth_id is null or v_deactivated_at is not null then
      raise exception 'User % is not an active employee and cannot be newly assigned.', v_uid;
    end if;
  end loop;

  foreach v_uid in array v_to_remove loop
    delete from public.task_assignees where task_id = p_task_id and user_id = v_uid;
    insert into public.task_assignee_log (task_id, user_id, action, actor_id)
    values (p_task_id, v_uid, 'removed', v_actor_id);
    -- Deliberately no notification: the removed person would open a link into a task
    -- task_visible_v2 has already stopped showing them, the moment their row is gone.
  end loop;

  foreach v_uid in array v_to_add loop
    insert into public.task_assignees (task_id, user_id, added_by, created_at)
    values (p_task_id, v_uid, v_actor_id, clock_timestamp());
    insert into public.task_assignee_log (task_id, user_id, action, actor_id)
    values (p_task_id, v_uid, 'added', v_actor_id);

    -- No notification when you assign yourself — nothing to tell yourself you don't already know.
    -- THE FIX: the insert below is now isolated in its own exception-handling sub-block (an
    -- implicit savepoint in plpgsql), exactly like notify_key_task_status_changes() already does
    -- for its own notification loop. A failure here (e.g. an RLS check violation) is caught,
    -- logged as a warning, and swallowed — it can never again roll back the task_assignees
    -- insert/log rows above, which are the actual assignment and must survive regardless of
    -- whether the courtesy notification succeeds.
    if v_uid <> v_actor_id then
      begin
        insert into public.notifications (id, user_id, title, message, sender_id, is_read, type, link_url, created_at)
        values (
          'notif-' || gen_random_uuid()::text,
          v_uid,
          'New Task Assigned',
          'You have been assigned a new task: ' || v_task.title
            || case when v_client_name is not null then ' (Client: ' || v_client_name || ')' else '' end
            || '.',
          v_actor_id,
          false,
          'task_assigned',
          'task:' || p_task_id,
          now()
        );
      exception when others then
        raise warning 'set_task_assignees: notification insert failed for task % / user % (assignment still applied): %',
          p_task_id, v_uid, sqlerrm;
      end;
    end if;
  end loop;
end;
$$;

revoke all on function public.set_task_assignees(text, text[]) from public, anon;
grant execute on function public.set_task_assignees(text, text[]) to authenticated;

commit;
