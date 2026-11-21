-- Same audit, task-management RPC functions and triggers: set_task_assignees, set_task_platforms,
-- tasks_log_events/task_assignees_log_events (triggers that log task/assignee change events),
-- mark_task_viewed. Each called app_user_role()/app_user_id()/app_user_team() more than once per
-- invocation (per task-save/trigger-fire, not per row under RLS). Same fix, same method: cache
-- each repeated value once in a local variable, replace every other direct call with it. No logic
-- change. Same signatures, so existing grants are untouched by CREATE OR REPLACE FUNCTION.
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
    if v_uid <> v_actor_id then
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
    end if;
  end loop;
end;
$$;

create or replace function public.set_task_platforms(p_task_id text, p_platform_ids text[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.tasks;
  v_ids text[] := array[]::text[];
  v_id text; v_cached_role text; v_cached_team text;
begin
  v_cached_role:=public.app_user_role();
  v_cached_team:=public.app_user_team();

  select * into v_task from public.tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found';
  end if;

  -- Gate — byte-identical to set_task_assignees' gate
  -- (20261105000000_task_assignees_rpcs.sql). See that migration's header comment for the full
  -- rationale; copied rather than shared so the two RPCs' authorization can never drift apart
  -- silently. sales is excluded explicitly (not just structurally).
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
    raise exception 'You do not have permission to modify this task''s platforms.';
  end if;

  -- Dedupe + drop null/blank ids, preserving first-occurrence order.
  foreach v_id in array coalesce(p_platform_ids, array[]::text[]) loop
    if v_id is not null and v_id <> '' and not (v_id = any(v_ids)) then
      v_ids := array_append(v_ids, v_id);
    end if;
  end loop;

  if array_length(v_ids, 1) is not null and array_length(v_ids, 1) > 10 then
    raise exception 'A task may have at most 10 platforms.';
  end if;

  -- Every id must exist and be active. Checked before anything is written, so a bad id leaves the
  -- task's existing platform set untouched rather than partially replaced.
  foreach v_id in array v_ids loop
    if not exists (select 1 from public.platforms where id = v_id and active = true) then
      raise exception 'Platform % does not exist or is not active.', v_id;
    end if;
  end loop;

  delete from public.task_platform_links where task_id = p_task_id;

  if array_length(v_ids, 1) is not null then
    insert into public.task_platform_links (task_id, platform_id)
    select p_task_id, u from unnest(v_ids) as u;
  end if;
end;
$$;

create or replace function public.tasks_log_events()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_cached_uid text;
begin
  v_cached_uid:=public.app_user_id();

  if TG_OP = 'INSERT' then
    insert into public.task_events (task_id, actor_id, event_type)
    values (new.id, coalesce(v_cached_uid, new.created_by), 'created');
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
    values (new.id, v_cached_uid, 'status_changed', old.status, new.status);
  end if;

  if new.priority is distinct from old.priority then
    insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
    values (new.id, v_cached_uid, 'priority_changed', old.priority, new.priority);
  end if;

  if new.due_date is distinct from old.due_date then
    insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
    values (new.id, v_cached_uid, 'due_date_changed', old.due_date::text, new.due_date::text);
  end if;

  if new.title is distinct from old.title then
    insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
    values (new.id, v_cached_uid, 'title_changed', old.title, new.title);
  end if;

  if new.team is distinct from old.team then
    insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
    values (new.id, v_cached_uid, 'team_changed', old.team, new.team);
  end if;

  return new;
end;
$$;

create or replace function public.task_assignees_log_events()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_cached_uid text;
begin
  v_cached_uid:=public.app_user_id();

  if TG_OP = 'INSERT' then
    insert into public.task_events (task_id, actor_id, event_type, new_value)
    values (new.task_id, coalesce(v_cached_uid, new.added_by), 'assignee_added', new.user_id);
    return new;
  end if;

  -- TG_OP = 'DELETE'
  if not exists (select 1 from public.tasks where id = old.task_id) then
    return old;
  end if;

  insert into public.task_events (task_id, actor_id, event_type, old_value)
  values (old.task_id, v_cached_uid, 'assignee_removed', old.user_id);
  return old;
end;
$$;

create or replace function public.mark_task_viewed(p_task_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_cached_uid text;
begin
  v_cached_uid:=public.app_user_id();

  update public.task_assignees
  set viewed_at = now()
  where task_id = p_task_id and user_id = v_cached_uid and viewed_at is null;

  -- Backward-compat mirror for MyWorkHub's existing `!assignee_viewed_at` badge check, which still
  -- reads the single legacy column — only meaningful while the caller IS the legacy assigned_to.
  update public.tasks
  set assignee_viewed_at = now()
  where id = p_task_id and assigned_to = v_cached_uid and assignee_viewed_at is null;
end;
$$;

commit;
