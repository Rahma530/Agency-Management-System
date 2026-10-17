-- Key-transition task notifications (for the Executive/Head of Technical pair and the right team
-- lead) + a team-scoped activity feed RPC for team leads, who the existing Live Activity Feed
-- (admin-only, sourced from public.activities) has never covered.
--
-- Facts below were confirmed live on production before writing this — not assumed, not copied
-- from older migrations in this repo, which have drifted from production before (see
-- 20261115000000_daily_task_target.sql's own header for that precedent):
--   - public.notifications columns: id text, user_id, title, message, sender_id, is_read, type,
--     link_url, created_at. type's check constraint accepts ONLY
--     ('task_assigned', 'task_updated', 'task_overdue', 'general') — 'task_updated' is used below,
--     the constraint itself is not touched.
--   - notifications RLS: select/update for the recipient only; insert with check
--     (sender_id = app_user_id() or sender_id is null).
--   - employee_manageable(target_id, target_role) does NOT cover graphic_designer or
--     video_editor — confirmed no supervisor role for either today.
--   - public.task_events columns: task_id, actor_id, event_type, old_value, new_value,
--     created_at, with only a (task_id, created_at desc) index — nothing useful for an
--     unfiltered, cross-task, created_at-ordered scan, hence section 3 below.
begin;

-- ----------------------------------------------------------------------------
-- 1. task_supervisor_role(p_role) — the one team-lead role (if any) that supervises a given
--    employee role, mirroring employee_manageable()'s own role-scoped branches
--    (20261101700000_users_edit_scope_hardening.sql) exactly: am_team_lead's own branch covers
--    am_agent, media_buying_team_lead covers media_buying_agent, seo_team_lead covers seo_agent/
--    programming_agent/seo_content_agent/seo_backlink_agent/store_manager, social_media_team_lead
--    covers social_media_agent. graphic_designer, video_editor, and every other role fall through
--    to null on purpose — no supervisor role covers them today (confirmed above), so their key
--    transitions only ever reach the two admin roles, handled as the "no extra recipient" case
--    everywhere this function is used. marketing_manager is deliberately never produced here —
--    it has no employee_manageable() branch of its own either.
create or replace function public.task_supervisor_role(p_role text)
returns text
language sql
immutable
as $$
  select case p_role
    when 'am_agent' then 'am_team_lead'
    when 'am_team_lead' then 'am_team_lead'
    when 'media_buying_agent' then 'media_buying_team_lead'
    when 'media_buying_team_lead' then 'media_buying_team_lead'
    when 'seo_agent' then 'seo_team_lead'
    when 'programming_agent' then 'seo_team_lead'
    when 'seo_content_agent' then 'seo_team_lead'
    when 'seo_backlink_agent' then 'seo_team_lead'
    when 'store_manager' then 'seo_team_lead'
    when 'seo_team_lead' then 'seo_team_lead'
    when 'social_media_agent' then 'social_media_team_lead'
    when 'social_media_team_lead' then 'social_media_team_lead'
    else null
  end;
$$;

revoke all on function public.task_supervisor_role(text) from public, anon;
grant execute on function public.task_supervisor_role(text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. notify_key_task_status_changes() — AFTER INSERT on task_events, status_changed rows only
--    (the WHEN clause below means the function body isn't even invoked for any other
--    event_type). "Key" transitions: reaching in_review/completed/closed/blocked, or a revision
--    (sent back from in_review/completed/closed to todo/in_progress). Recipients: both admin
--    roles, plus — for each role currently assigned to this task — whichever team lead role
--    supervises it (task_supervisor_role above), always excluding the event's own actor and any
--    deactivated user. No notification for the task's creator in this version (not asked for).
--
--    Wrapped entirely in its own exception handler: this AFTER trigger fires inside the very
--    same, still-open transaction as the UPDATE on tasks that produced this task_events row (via
--    tasks_log_events(), 20261116000000_task_events.sql) — nothing has committed yet. An
--    unhandled exception here would propagate out of the trigger and abort that whole
--    transaction, undoing the status change itself, not just this notification. The handler is
--    exactly what prevents that: any error is caught and downgraded to RAISE WARNING instead, so
--    the status change commits regardless of whether its notification side-effect succeeded.
-- ----------------------------------------------------------------------------
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
    -- or any other reason the row vanished) — nothing meaningful left to notify anyone about.
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

create trigger task_events_notify_key_status_changes_trigger
after insert on public.task_events
for each row
when (new.event_type = 'status_changed')
execute function public.notify_key_task_status_changes();

-- ----------------------------------------------------------------------------
-- 3. Index for team_task_activity_feed()'s unfiltered, cross-task, created_at-ordered scan
--    (section 4) — the existing (task_id, created_at desc) index only helps a single-task lookup
--    (TaskHistoryTab.tsx's own per-task History tab), not this one.
-- ----------------------------------------------------------------------------
create index if not exists idx_task_events_created_at on public.task_events (created_at desc);

-- ----------------------------------------------------------------------------
-- 4. team_task_activity_feed(p_limit, p_before) — a team-scoped equivalent of the admin-only
--    Live Activity Feed, for the four team-lead roles. Deliberately NOT task_visible_v2(task_id)
--    per row: that function runs several EXISTS subqueries per call, and evaluating it once per
--    row of an unfiltered, potentially-large cross-task scan is far more expensive than the
--    direct task_supervisor_role() EXISTS check used here, which only ever looks at this one
--    task's own current assignees. Tasks already hard-deleted are excluded via the inner join to
--    tasks (nothing meaningful to show for a task that no longer exists, unlike
--    TaskHistoryTab.tsx's own per-task History, which deliberately keeps orphaned rows since it's
--    inspecting one already-known task rather than browsing a general feed).
-- ----------------------------------------------------------------------------
create or replace function public.team_task_activity_feed(p_limit int default 50, p_before timestamptz default null)
returns table (
  id uuid,
  task_id text,
  task_title text,
  actor_id text,
  actor_name text,
  event_type text,
  old_value text,
  new_value text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := public.app_user_role();
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if v_role not in ('executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead') then
    raise exception 'You are not permitted to view the team activity feed.';
  end if;

  return query
  select
    te.id,
    te.task_id,
    t.title as task_title,
    te.actor_id,
    coalesce(u.name, 'System') as actor_name,
    te.event_type,
    te.old_value,
    te.new_value,
    te.created_at
  from public.task_events te
  join public.tasks t on t.id = te.task_id
  left join public.users u on u.id = te.actor_id
  where (p_before is null or te.created_at < p_before)
    and (
      v_role in ('executive', 'head_of_technical')
      or exists (
        select 1
        from public.task_assignees ta
        join public.users au on au.id = ta.user_id
        where ta.task_id = te.task_id
          and public.task_supervisor_role(au.role) = v_role
      )
    )
  order by te.created_at desc
  limit v_limit;
end;
$$;

revoke all on function public.team_task_activity_feed(int, timestamptz) from public, anon;
grant execute on function public.team_task_activity_feed(int, timestamptz) to authenticated;

commit;
