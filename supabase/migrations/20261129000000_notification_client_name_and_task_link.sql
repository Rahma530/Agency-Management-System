-- Task notifications now name the client and link straight to the task.
--
-- Per the agency owner: a notification like "Ahmed marked 'Design Instagram post' as Completed"
-- doesn't say WHICH client that post was for, and clicking it never went anywhere useful — both
-- notify_key_task_status_changes() (20261122000000_management_notifications_completed_closed_only.sql,
-- the live body, confirmed unchanged since) and set_task_assignees()
-- (20261105000000_task_assignees_rpcs.sql, also unchanged since — confirmed via grep across every
-- later migration) have always written link_url = 'module:tasks', a generic "go to the Tasks
-- module" link with no specific task attached, and neither message included the task's client.
--
-- This migration:
--   1. Adds the client's name to both functions' notification messages, as " (Client: X)" right
--      after the task title — omitted entirely for a task with no client_id, exactly like every
--      other place in this app that already handles a nullable client this way.
--   2. Changes link_url from the generic 'module:tasks' to 'task:<task id>' in both functions, so
--      the notification can point at one specific task. The app side (App.tsx's
--      handleNotificationClick, CrossTeamTaskBoard.tsx's new initialOpenTaskId prop) is what
--      actually opens that task's Details modal when the link is clicked — this migration only
--      changes what gets written, never read.
--
-- Both functions are reproduced here byte-identical to their live bodies except for these two
-- changes (message wording + link_url) — no other column, branch, recipient rule, or exception
-- handler is touched.
begin;

create or replace function public.notify_key_task_status_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task_title text;
  v_client_name text;
  v_actor_name text;
  v_is_revision boolean;
  v_status_label text;
  v_notif_title text;
  v_notif_message text;
  v_client_suffix text;
  v_recipient record;
begin
  v_is_revision := new.old_value in ('in_review', 'completed', 'closed') and new.new_value in ('todo', 'in_progress');
  if not (new.new_value in ('in_review', 'completed', 'closed', 'blocked') or v_is_revision) then
    return new;
  end if;

  select t.title, c.name into v_task_title, v_client_name
  from public.tasks t
  left join public.clients c on c.id = t.client_id
  where t.id = new.task_id;
  if v_task_title is null then
    -- The task no longer exists (hard-deleted between the status write and this AFTER trigger,
    -- or any other reason the row vanished) - nothing meaningful left to notify anyone about.
    return new;
  end if;

  v_client_suffix := case when v_client_name is not null then ' (Client: ' || v_client_name || ')' else '' end;

  v_actor_name := coalesce((select name from public.users where id = new.actor_id), 'System');

  v_status_label := case new.new_value
    when 'todo' then 'To Do'
    when 'in_progress' then 'In Progress'
    when 'in_review' then 'In Review'
    when 'completed' then 'Completed'
    when 'blocked' then 'Blocked'
    when 'closed' then 'Closed'
    else new.new_value
  end;

  if v_is_revision then
    v_notif_title := 'Task Sent Back for Revision';
    v_notif_message := v_actor_name || ' sent "' || v_task_title || '"' || v_client_suffix || ' back for revision (now ' || v_status_label || ').';
  elsif new.new_value = 'in_review' then
    v_notif_title := 'Task Ready for Review';
    v_notif_message := v_actor_name || ' moved "' || v_task_title || '"' || v_client_suffix || ' to In Review.';
  elsif new.new_value = 'completed' then
    v_notif_title := 'Task Completed';
    v_notif_message := v_actor_name || ' marked "' || v_task_title || '"' || v_client_suffix || ' as Completed.';
  elsif new.new_value = 'closed' then
    v_notif_title := 'Task Closed';
    v_notif_message := v_actor_name || ' closed "' || v_task_title || '"' || v_client_suffix || '.';
  else
    v_notif_title := 'Task Blocked';
    v_notif_message := v_actor_name || ' marked "' || v_task_title || '"' || v_client_suffix || ' as Blocked.';
  end if;

  for v_recipient in
    select u.id
    from public.users u
    where u.auth_id is not null
      and u.deactivated_at is null
      and u.id is distinct from new.actor_id
      and (
        -- Leadership: only for the two transitions that matter to them -- completed and closed.
        -- Never in_review, blocked, or a revision.
        (u.role in ('executive', 'head_of_technical') and new.new_value in ('completed', 'closed'))
        or (
          -- Team leads: unchanged for all five key transitions -- explicitly excludes leadership
          -- so this branch alone can never re-admit them (defensive; see the prior migration's
          -- own header comment for why task_supervisor_role() cannot produce either role today).
          u.role not in ('executive', 'head_of_technical')
          and u.role in (
            select distinct public.task_supervisor_role(au.role)
            from public.task_assignees ta
            join public.users au on au.id = ta.user_id
            where ta.task_id = new.task_id
              and public.task_supervisor_role(au.role) is not null
          )
        )
      )
  loop
    insert into public.notifications (id, user_id, title, message, sender_id, is_read, type, link_url, created_at)
    values (
      'notif-' || gen_random_uuid()::text,
      v_recipient.id,
      v_notif_title,
      v_notif_message,
      new.actor_id,
      false,
      'task_updated',
      'task:' || new.task_id,
      now()
    );
  end loop;

  return new;
exception when others then
  raise warning 'notify_key_task_status_changes failed for task_event % (task %): %', new.id, new.task_id, sqlerrm;
  return new;
end;
$$;

revoke all on function public.notify_key_task_status_changes() from public, anon, authenticated;

-- set_task_assignees(text, text[]) — reproduced byte-identical to its live body
-- (20261105000000_task_assignees_rpcs.sql, confirmed unchanged by every later migration that
-- mentions it) except for the "New Task Assigned" notification's message/link_url, exactly as
-- described in this migration's own header above.
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
  v_deactivated_at timestamptz;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found';
  end if;

  -- Gate — see this function's original migration (20261105000000_task_assignees_rpcs.sql) for
  -- the full rationale. Unchanged by this migration.
  if public.app_user_role() = 'sales' or not (
    public.task_closable(p_task_id)
    or (
      public.app_user_role() = 'am_agent'
      and v_task.client_id is not null
      and public.client_am_agent_is_caller(v_task.client_id)
    )
    or (
      public.app_user_role() = 'am_team_lead'
      and v_task.client_id is not null
      and exists (
        select 1 from public.clients c
        join public.users ua on ua.id = c.am_agent_id
        where c.id = v_task.client_id and ua.team = public.app_user_team()
      )
    )
    or (
      public.app_user_role() in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
      and (
        exists (select 1 from public.users u where u.id = v_task.created_by and u.team = public.app_user_team())
        or exists (
          select 1 from public.task_assignees ta
          join public.users u on u.id = ta.user_id
          where ta.task_id = p_task_id and u.team = public.app_user_team()
        )
        or (
          public.app_user_role() = 'seo_team_lead'
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
      or (public.app_user_role() = 'executive' and v_target_role = 'head_of_technical')
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

revoke all on function public.set_task_assignees(text, text[]) from public, anon;
grant execute on function public.set_task_assignees(text, text[]) to authenticated, service_role;

commit;
