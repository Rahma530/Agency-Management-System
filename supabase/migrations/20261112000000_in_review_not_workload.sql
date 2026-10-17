-- "in_review is not workload" — owner decisions (see PR description for the full list):
--   1. in_review = delivered, waiting on the client: NOT workload, never Overdue.
--   2. A delivered task (was in_review/completed/closed) that goes back to todo/in_progress is a
--      REVISION: it IS workload (real work), but must NEVER count or show as the assignee's
--      Overdue/late.
--   3. Workload-open = todo, in_progress, blocked.
--   4. Day-count rule UNCHANGED: today and past days still count ALL tasks dated that day,
--      whatever their status (get_user_schedule_load's due_date/task_count columns, and the
--      front-end's own mirror in buildScheduleLoadByDate, are NOT touched here beyond the
--      future-day open-status filter — see part 2 below).
--   5. No task date is ever changed and no history is backfilled — existing in_review/completed/
--      closed rows simply keep delivered_at = NULL forever unless they transition status again
--      after this migration is applied. Nothing here needs delivered_at to be non-null for
--      in_review/revision detection: both the new trigger (part 1) and every UI/SQL consumer of
--      "is this a revision" use status + revision_count, never delivered_at.
--
-- ================================================================================================
-- PART 1 — delivered_at / revision_count / revision_started_at, and the trigger that owns them.
-- ================================================================================================
--
-- Three new nullable-by-default columns on public.tasks:
--   delivered_at        — when the task FIRST reached in_review or completed. Set once, never
--                          moved by a later transition (not even a later re-delivery after a
--                          revision) — "set once" is the literal spec; this column answers "did we
--                          ever deliver this," not "when was the most recent delivery."
--   revision_count       — how many times a delivered task (was in_review/completed/closed) has
--                          been sent back to todo/in_progress. 0 means "never revised."
--   revision_started_at — when the MOST RECENT revision began (overwritten on each new revision,
--                          unlike delivered_at). Not currently read by any UI added in part 3 below
--                          — included because the owner's column list asks for it, for whatever a
--                          later PR builds (a "how long has this revision been open" display).
--
-- public.tasks has table-level grants only (`grant select, insert, update on public.tasks to
-- authenticated` — confirmed via grep across every canonical_schema*.sql; this schema has never
-- used column-level GRANT/REVOKE), so there is no privilege mechanism stopping an authenticated
-- client from setting these three columns directly in an ordinary UPDATE. The BEFORE trigger below
-- is therefore the ONLY enforcement — same posture as users_update_guard_trigger
-- (20261030000000_users_update_guard_trigger.sql) restricting which columns an ordinary UPDATE may
-- actually change, just for a different table.
begin;

alter table public.tasks
  add column if not exists delivered_at timestamptz null,
  add column if not exists revision_count integer not null default 0,
  add column if not exists revision_started_at timestamptz null;

-- Trigger function. Fires BEFORE INSERT unconditionally, and BEFORE UPDATE only when the
-- statement's SET list includes status, delivered_at, revision_count, or revision_started_at
-- (Postgres's own "UPDATE OF <columns>" trigger semantics — not a condition this function has to
-- check itself). This is what makes "must not fire on mark_task_viewed / assignee-sync updates"
-- automatic rather than something to special-case in the body:
--   - mark_task_viewed() (20261105000000_task_assignees_rpcs.sql) only ever sets
--     task_assignees.viewed_at and tasks.assignee_viewed_at — never any of the four columns above.
--   - sync_legacy_assigned_to_to_task_assignees_trigger (AFTER, on tasks) fires on
--     `update of assigned_to, assignee_viewed_at` — a disjoint column set.
--   - sync_task_assignees_to_legacy_assigned_to_trigger (AFTER, on task_assignees) issues
--     `update tasks set assigned_to = ...` only — again disjoint.
-- None of those three ever appears in this trigger's own column list, so Postgres never invokes it
-- for them — confirmed by reading each one's actual UPDATE statement above, not assumed.
--
-- pg_trigger_depth(): the existing assigned_to <-> task_assignees forward/reverse triggers guard
-- against THEIR OWN cascade (one side's UPDATE re-triggering the other). This function never
-- issues any UPDATE/INSERT of its own and never touches assigned_to/task_assignees — it only
-- assigns into NEW inside a BEFORE trigger, which cannot itself cause recursion or re-enter any
-- other trigger — so it needs no pg_trigger_depth() guard, and cannot interfere with the existing
-- ones (disjoint column sets, as above).
--
-- tasks_enforce_nesting_depth (BEFORE INSERT OR UPDATE OF parent_task_id on public.tasks) is the
-- only other BEFORE trigger on this table; its column set (parent_task_id) is also disjoint from
-- this one's, so the two never interact regardless of firing order.
create or replace function public.track_delivery_and_revisions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    -- Defaults on insert — a client that includes these columns in the INSERT payload itself
    -- (bypassing the column DEFAULT, which only applies when a column is omitted entirely) gets
    -- overridden here just the same as on UPDATE.
    new.revision_count := 0;
    new.revision_started_at := null;
    new.delivered_at := null;
    if new.status in ('in_review', 'completed') then
      new.delivered_at := now();
    end if;
    return new;
  end if;

  -- TG_OP = 'UPDATE'. Restore first — clients can never write these three directly, whatever
  -- they put in the UPDATE payload (scenario: "client UPDATE setting revision_count=99 is
  -- ignored").
  new.delivered_at := old.delivered_at;
  new.revision_count := old.revision_count;
  new.revision_started_at := old.revision_started_at;

  -- Delivered: set once, only while still unset, and only on a REAL status change — `new.status
  -- is distinct from old.status` guards against a no-op UPDATE that merely re-sends the current
  -- status (e.g. a full-row re-save) while delivered_at still happens to be null (a legacy row
  -- from before this migration, per decision 5 — no backfill). Without this guard, that redundant
  -- UPDATE would wrongly stamp delivered_at even though nothing was actually delivered just now.
  -- A later re-delivery after a revision still does NOT move this — "delivered_at set once" is
  -- the literal spec.
  if new.status in ('in_review', 'completed') and old.delivered_at is null and new.status is distinct from old.status then
    new.delivered_at := now();
  end if;

  -- Revision: a previously-delivered task (was in_review/completed/closed) sent back to
  -- todo/in_progress. Counts even if it was never actually "delivered" in the delivered_at sense
  -- (e.g. a pre-this-migration row with delivered_at still NULL per decision 5) — this condition
  -- reads old.status, never delivered_at, on purpose.
  if old.status in ('in_review', 'completed', 'closed') and new.status in ('todo', 'in_progress') then
    new.revision_count := old.revision_count + 1;
    new.revision_started_at := now();
  end if;

  return new;
end;
$$;

revoke all on function public.track_delivery_and_revisions() from public, anon, authenticated;

drop trigger if exists tasks_track_delivery_and_revisions_trigger on public.tasks;
create trigger tasks_track_delivery_and_revisions_trigger
before insert or update of status, delivered_at, revision_count, revision_started_at on public.tasks
for each row
execute function public.track_delivery_and_revisions();

-- ================================================================================================
-- PART 2 — get_user_schedule_load(): "future-day open" and carried_over_count now use
-- Workload-open (todo, in_progress, blocked) instead of "not in (completed, closed)" — so a
-- future-dated in_review task no longer counts as load, and an overdue in_review task is never
-- carried over. A revision (todo/in_progress after being delivered) IS in this set, so it still
-- counts as load and still gets carried over if overdue — exactly decision 2.
--
-- Same signature (text, date, date, timestamptz), same return shape
-- (due_date, task_count, carried_over_count), same grants, same `security definer` /
-- `set search_path = public, pg_temp` as 20261111000000_user_schedule_load_carry_over.sql — only
-- the two status predicates below changed; CREATE OR REPLACE is safe here (no return-type change,
-- unlike 20261111's own drop+create).
--
-- The TODAY/PAST branch (`gs.d::date <= v_today`, decision 4) is UNTOUCHED: a today-or-past day
-- still counts every task due that day regardless of status, in_review included — only the
-- FUTURE-day branch's status predicate changes.
-- ================================================================================================
create or replace function public.get_user_schedule_load(
  p_user_id text,
  p_from date,
  p_to date,
  p_as_of timestamptz default now()
)
returns table(due_date date, task_count integer, carried_over_count integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_role text;
  v_target_auth_id text;
  v_target_deactivated_at timestamptz;
  v_today date := (p_as_of at time zone 'Africa/Cairo')::date;
  v_carried_over_count integer;
  v_first_working_day date;
begin
  if public.app_user_role() = 'sales' then
    raise exception 'sales may not query schedule load.';
  end if;

  if p_from is null or p_to is null then
    raise exception 'p_from and p_to are required.';
  end if;
  if p_from > p_to then
    raise exception 'p_from must not be after p_to.';
  end if;

  select u.role, u.auth_id, u.deactivated_at
    into v_target_role, v_target_auth_id, v_target_deactivated_at
  from public.users u
  where u.id = p_user_id;

  if v_target_role is null then
    raise exception 'User not found.';
  end if;
  if v_target_auth_id is null or v_target_deactivated_at is not null then
    raise exception 'User is not an active employee.';
  end if;
  if v_target_role = 'sales' then
    raise exception 'sales users are never assignable.';
  end if;
  if v_target_role = 'marketing_manager' then
    raise exception 'marketing_manager is excluded from schedule-load lookups.';
  end if;
  if v_target_role in ('executive', 'head_of_technical')
     and not (v_target_role = 'head_of_technical' and public.app_user_role() = 'executive') then
    raise exception 'You are not permitted to view this user''s schedule.';
  end if;

  -- All of this assignee's overdue, still-open (Workload-open) tasks, system-wide — independent
  -- of [p_from, p_to]. An overdue in_review task is excluded (decision 1); an overdue revision
  -- (todo/in_progress) is included (decision 2).
  select count(*)
    into v_carried_over_count
  from public.tasks t
  where t.due_date < v_today
    and t.status in ('todo', 'in_progress', 'blocked')
    and exists (
      select 1 from public.task_assignees ta
      where ta.task_id = t.id and ta.user_id = p_user_id
    );

  -- The one row carried_over_count attaches to: the first working day (dow <> 5, i.e. not
  -- Friday) in [p_from, p_to]. NULL (and therefore attached to nothing) if the whole window is
  -- non-working days.
  select min(gs.d::date)
    into v_first_working_day
  from generate_series(p_from, p_to, interval '1 day') as gs(d)
  where extract(dow from gs.d::date) <> 5;

  return query
    select
      gs.d::date as due_date,
      count(t.id)::integer as task_count,
      case when gs.d::date = v_first_working_day then v_carried_over_count else 0 end as carried_over_count
    from generate_series(p_from, p_to, interval '1 day') as gs(d)
    left join public.tasks t
      on t.due_date = gs.d::date
      and exists (
        select 1 from public.task_assignees ta
        where ta.task_id = t.id and ta.user_id = p_user_id
      )
      and (
        gs.d::date <= v_today
        or t.status in ('todo', 'in_progress', 'blocked')
      )
    group by gs.d
    order by gs.d;
end;
$$;

revoke all on function public.get_user_schedule_load(text, date, date, timestamptz) from public, anon;
grant execute on function public.get_user_schedule_load(text, date, date, timestamptz) to authenticated, service_role;

commit;
