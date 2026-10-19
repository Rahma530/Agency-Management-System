-- Narrows which key-task-status-change notifications reach leadership (executive,
-- head_of_technical): from now on they are notified only when a task reaches 'completed' or
-- 'closed', never for in_review, blocked, or a revision (sent back from in_review/completed/
-- closed to todo/in_progress). Team leads (via task_supervisor_role) are completely unaffected:
-- they still receive all five key transitions exactly as before. ai_engineer is untouched too --
-- it was never a recipient of this trigger's notifications in the first place (confirmed: the
-- live function's admin branch only ever checked role in ('executive', 'head_of_technical')), and
-- this migration does not add it.
--
-- Body confirmed live on production before writing this (pg_get_functiondef), not assumed, not
-- copied from migration 20261118000000_key_task_notifications_team_feed.sql without checking --
-- that file's drift precedent (20261115000000_daily_task_target.sql) is exactly why this check was
-- done first. The live body matches 20261118000000's own notify_key_task_status_changes()
-- byte-for-byte except for one non-functional difference: the live comment "nothing meaningful
-- left to notify anyone about" uses a plain ASCII hyphen, where 20261118000000's own copy uses an
-- em dash. This migration's own CREATE OR REPLACE is built from that live body verbatim (ASCII
-- hyphen kept), with ONLY the recipient WHERE clause inside the loop changed, exactly as follows:
--   - executive/head_of_technical: now additionally gated on new.new_value in ('completed',
--     'closed') -- they no longer receive in_review, blocked, or a revision notification.
--   - the task_supervisor_role branch: unchanged for all five key transitions, but now explicitly
--     excludes executive/head_of_technical (u.role not in ('executive', 'head_of_technical')) so
--     that branch alone can never re-admit them -- it cannot match either role today anyway, since
--     task_supervisor_role() never returns 'executive' or 'head_of_technical' for any input, but
--     the exclusion is added defensively so a future task_supervisor_role change could never
--     silently widen this back without being obvious here.
--   - every other role, every other branch, every column, every message/title, the exception
--     handler, SECURITY DEFINER, and search_path are all byte-for-byte identical to the live body.
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
        -- Leadership: only for the two transitions that matter to them -- completed and closed.
        -- Never in_review, blocked, or a revision.
        (u.role in ('executive', 'head_of_technical') and new.new_value in ('completed', 'closed'))
        or (
          -- Team leads: unchanged for all five key transitions -- explicitly excludes leadership
          -- so this branch alone can never re-admit them (defensive; see this migration's own
          -- header comment for why task_supervisor_role() cannot produce either role today).
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
