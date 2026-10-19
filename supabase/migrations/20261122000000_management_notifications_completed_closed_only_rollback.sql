-- Rollback for 20261122000000_management_notifications_completed_closed_only.sql.
--
-- Restores public.notify_key_task_status_changes() to the exact body confirmed live on
-- production before 20261122000000 was written (pg_get_functiondef) -- byte-for-byte, including
-- the ASCII-hyphen comment. Undoes ONLY the recipient WHERE clause change: executive/
-- head_of_technical go back to receiving all five key transitions unconditionally, and the
-- "u.role not in ('executive', 'head_of_technical')" exclusion on the task_supervisor_role branch
-- is removed (it was always a no-op defensively added by 20261122000000, never a behavior change
-- by itself, so removing it changes nothing on its own -- the admin branch's own condition is
-- what actually restores the old behavior).
begin;

create or replace function public.notify_key_task_status_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task_title text;
  v_actor_name text;
  v_is_revision boolean;
  v_status_label text;
  v_notif_title text;
  v_notif_message text;
  v_recipient record;
begin
  v_is_revision := new.old_value in ('in_review', 'completed', 'closed') and new.new_value in ('todo', 'in_progress');
  if not (new.new_value in ('in_review', 'completed', 'closed', 'blocked') or v_is_revision) then
    return new;
  end if;

  select title into v_task_title from public.tasks where id = new.task_id;
  if v_task_title is null then
    -- The task no longer exists (hard-deleted between the status write and this AFTER trigger,
    -- or any other reason the row vanished) - nothing meaningful left to notify anyone about.
    return new;
  end if;

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
    v_notif_message := v_actor_name || ' sent "' || v_task_title || '" back for revision (now ' || v_status_label || ').';
  elsif new.new_value = 'in_review' then
    v_notif_title := 'Task Ready for Review';
    v_notif_message := v_actor_name || ' moved "' || v_task_title || '" to In Review.';
  elsif new.new_value = 'completed' then
    v_notif_title := 'Task Completed';
    v_notif_message := v_actor_name || ' marked "' || v_task_title || '" as Completed.';
  elsif new.new_value = 'closed' then
    v_notif_title := 'Task Closed';
    v_notif_message := v_actor_name || ' closed "' || v_task_title || '".';
  else
    v_notif_title := 'Task Blocked';
    v_notif_message := v_actor_name || ' marked "' || v_task_title || '" as Blocked.';
  end if;

  for v_recipient in
    select u.id
    from public.users u
    where u.auth_id is not null
      and u.deactivated_at is null
      and u.id is distinct from new.actor_id
      and (
        u.role in ('executive', 'head_of_technical')
        or u.role in (
          select distinct public.task_supervisor_role(au.role)
          from public.task_assignees ta
          join public.users au on au.id = ta.user_id
          where ta.task_id = new.task_id
            and public.task_supervisor_role(au.role) is not null
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
      'module:tasks',
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

commit;
