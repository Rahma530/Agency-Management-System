-- task_events — append-only history of tracked task changes, backing a future "History" tab in
-- Task Details, a live activity feed, and TL notifications. Additive only: one new table plus two
-- new triggers. Nothing on tasks or task_assignees is altered, and none of the four triggers
-- already firing on those two tables — sync_legacy_assigned_to_to_task_assignees_trigger (AFTER on
-- tasks), sync_task_assignees_to_legacy_assigned_to_trigger (AFTER on task_assignees), and
-- tasks_enforce_nesting_depth and tasks_track_delivery_and_revisions_trigger (both BEFORE on
-- tasks) — confirmed live by name before writing this, is touched, renamed, or raced with.
-- task_assignee_log is untouched too.
--
-- Facts below were confirmed live on production — not assumed, not copied from older migrations in
-- this repo, which have drifted from production before (see 20261115000000_daily_task_target.sql's
-- own header for that precedent):
--   - RLS today calls task_visible_v2(p_task_id text), not the older task_visible(text,text,text).
--   - tasks.id, users.id, and task_assignees.task_id/user_id/added_by are all text.
--   - tasks.title and tasks.status/priority are text; tasks.team is text and nullable;
--     tasks.due_date is date.
--
-- Deliberately NOT tracked: tasks.assigned_to. It's a legacy column mirrored from/to
-- task_assignees by its own pre-existing two-way trigger pair named above — logging it here on top
-- of the task_assignees-sourced assignee_added/assignee_removed events below would double-count
-- the exact same assignment under two different event rows for the same real-world change.
begin;

-- ----------------------------------------------------------------------------
-- 1. public.task_events
-- ----------------------------------------------------------------------------
create table public.task_events (
  id uuid primary key default gen_random_uuid(),
  -- No FK to tasks(id), deliberately: delete_tasks() (20261113000000_task_hard_delete.sql)
  -- hard-deletes a task row outright, and these events must survive that — the point of a history
  -- table is to still show what happened to a task that no longer exists. Same reasoning
  -- task_assignee_log.task_id already uses (it is "a plain text column", not a real FK, per that
  -- migration's own comment).
  task_id text not null,
  -- Who performed the change. No FK to users(id) either, for the same "must not block or lose
  -- history" reasoning — matching the choice task_assignee_log.actor_id already makes (also plain
  -- text, unreferenced). Nullable in the schema; both trigger functions below always supply one in
  -- practice.
  actor_id text,
  event_type text not null check (event_type in (
    'created',
    'status_changed',
    'priority_changed',
    'due_date_changed',
    'title_changed',
    'team_changed',
    'assignee_added',
    'assignee_removed'
  )),
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);

create index idx_task_events_task_id_created_at on public.task_events (task_id, created_at desc);

alter table public.task_events enable row level security;

-- ----------------------------------------------------------------------------
-- 2. RLS — select-only, same visibility door as the task itself: task_visible_v2 (confirmed live
--    signature above) plus the two admin roles unconditionally — mirroring how task_assignees and
--    every other task-adjacent table in this schema already gates read access. No insert/update/
--    delete policy at all, and both grants are revoked explicitly below — every row is written
--    only by the two SECURITY DEFINER trigger functions in sections 3/4, which bypass RLS/grants
--    entirely as their own function owner regardless of what's revoked here.
-- ----------------------------------------------------------------------------
create policy "task_events_select_rls" on public.task_events
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  or public.task_visible_v2(task_id)
);

revoke all on public.task_events from public, anon, authenticated;
grant select on public.task_events to authenticated;

-- ----------------------------------------------------------------------------
-- 3. tasks_log_events() — AFTER INSERT OR UPDATE on tasks. One row per tracked field that actually
--    changed, not one row per UPDATE statement — an update touching only untracked columns (e.g.
--    estimated_hours, description) writes nothing at all. actor_id for UPDATE is always
--    app_user_id() — whoever is actually making this specific edit right now, which created_by is
--    not (that would misattribute every edit after the first to the task's original creator). For
--    INSERT it's coalesce(app_user_id(), new.created_by): the two normally agree (tasks_insert_rls
--    already requires created_by = caller), but app_user_id() reads auth.uid(), which is null
--    whenever request.jwt.claims carries no "sub" (no authenticated caller in context at all, e.g.
--    a service-context insert) — new.created_by is then the only identity actually available, and
--    is still correct, since it's who this row itself says created it.
-- ----------------------------------------------------------------------------
create or replace function public.tasks_log_events()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.task_events (task_id, actor_id, event_type)
    values (new.id, coalesce(public.app_user_id(), new.created_by), 'created');
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
    values (new.id, public.app_user_id(), 'status_changed', old.status, new.status);
  end if;

  if new.priority is distinct from old.priority then
    insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
    values (new.id, public.app_user_id(), 'priority_changed', old.priority, new.priority);
  end if;

  if new.due_date is distinct from old.due_date then
    insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
    values (new.id, public.app_user_id(), 'due_date_changed', old.due_date::text, new.due_date::text);
  end if;

  if new.title is distinct from old.title then
    insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
    values (new.id, public.app_user_id(), 'title_changed', old.title, new.title);
  end if;

  if new.team is distinct from old.team then
    insert into public.task_events (task_id, actor_id, event_type, old_value, new_value)
    values (new.id, public.app_user_id(), 'team_changed', old.team, new.team);
  end if;

  return new;
end;
$$;

revoke all on function public.tasks_log_events() from public, anon, authenticated;

create trigger tasks_log_events_trigger
after insert or update on public.tasks
for each row execute function public.tasks_log_events();

-- ----------------------------------------------------------------------------
-- 4. task_assignees_log_events() — AFTER INSERT OR DELETE on task_assignees. actor_id differs by
--    direction on purpose: an addition's actor is coalesce(app_user_id(), new.added_by) — the
--    adder, already captured on the row itself by set_task_assignees()/the legacy sync trigger
--    (see 20261105000000_task_assignees_rpcs.sql and 20261103000000_task_assignees_foundation.sql),
--    with the same service-context fallback as tasks_log_events()'s 'created' event above. A
--    removal's actor isn't on the row at all, so it's always app_user_id() (whoever is making the
--    call right now) with no such fallback to fall back to.
--
--    The DELETE branch's existence check is what keeps a hard task delete from writing a flood of
--    bogus "assignee_removed" events: task_assignees.task_id -> tasks(id) is ON DELETE CASCADE
--    (confirmed above), so delete_tasks() hard-deleting a task cascades into deleting every one of
--    its task_assignees rows without that function ever touching task_assignees directly itself
--    (its own header comment: "Postgres cascades them on its own"). By the time THIS trigger fires
--    for such a cascade-induced row, the parent tasks row has already been removed earlier in the
--    very same statement/transaction — a cascade-delete action only runs after that removal is
--    applied — so a plain existence check on tasks correctly reads it as already gone, telling a
--    real standalone removal (task still exists) apart from a cascade removal (it doesn't) with no
--    extra state to carry or pass in.
-- ----------------------------------------------------------------------------
create or replace function public.task_assignees_log_events()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.task_events (task_id, actor_id, event_type, new_value)
    values (new.task_id, coalesce(public.app_user_id(), new.added_by), 'assignee_added', new.user_id);
    return new;
  end if;

  -- TG_OP = 'DELETE'
  if not exists (select 1 from public.tasks where id = old.task_id) then
    return old;
  end if;

  insert into public.task_events (task_id, actor_id, event_type, old_value)
  values (old.task_id, public.app_user_id(), 'assignee_removed', old.user_id);
  return old;
end;
$$;

revoke all on function public.task_assignees_log_events() from public, anon, authenticated;

create trigger task_assignees_log_events_trigger
after insert or delete on public.task_assignees
for each row execute function public.task_assignees_log_events();

commit;
