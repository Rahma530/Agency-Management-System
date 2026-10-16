-- Extends get_user_schedule_load() (20261110000000_user_schedule_load.sql) with a THIRD return
-- column, carried_over_count — the count of this assignee's OVERDUE OPEN tasks (due before
-- "today," Africa/Cairo, status not in ('completed', 'closed')) — so the designer-scheduling
-- suggestion banner (CrossTeamTaskBoard.tsx: Create, Edit, and the Details-modal Add-assignee
-- flow) can show WHY a day's apparent load is high: some of it may be old, unfinished work still
-- hanging over the assignee, not new tasks landing on that specific day.
--
-- Existing columns (due_date, task_count) are completely unchanged — same generate_series +
-- LEFT JOIN, same counting rule, same caller gate, byte-identical to the current migration. This
-- is a pure addition; it does NOT touch the still-open question on scenario 2b from the prior
-- migration's own verification suite (tracked separately) — that counting logic is carried over
-- here exactly as-is, deliberately, so the two changes stay independently reviewable.
--
-- carried_over_count is NOT scoped to [p_from, p_to] — an overdue open task may be due on ANY
-- past date, not necessarily inside the window the caller asked for — so it's computed once,
-- system-wide for this assignee, and reported on exactly ONE row: the first WORKING day (Sat-Thu;
-- Friday excluded, byte-identical to DAY_OFF_WEEKDAY in src/config/designerScheduling.ts) inside
-- [p_from, p_to]. Every other row reports 0. If no working day falls in the window at all (e.g.
-- a single Friday), every row reports 0 — there is no row to attach it to. It is never folded
-- into task_count itself: these tasks are already counted on their own original due_date's row
-- via the existing today/past counting rule; this column is purely additional context for the
-- UI, not a new count of anything the existing columns didn't already account for somewhere.
--
-- CREATE OR REPLACE FUNCTION cannot add a RETURNS TABLE column to an already-live function (the
-- return type would change) — this drops and recreates it instead. Same signature
-- (text, date, date, timestamptz), same grants (revoke all from public/anon, grant execute to
-- authenticated/service_role — unchanged from 20261110000000_user_schedule_load.sql), same
-- `security definer` / `set search_path = public, pg_temp`; safe to re-run against the
-- already-applied live DB (drop + create, not a bare create or replace, specifically because of
-- that return-type change).
--
-- APPLY ORDER: 20261110000000_user_schedule_load.sql (already live) MUST be applied before this
-- one — this migration only ADDS the carried_over_count column on top of that function; it does
-- not create get_server_today() or any of the other objects 20261110 is responsible for.
--
-- IMPORTANT — this migration's drop+create REPLACES THE ENTIRE LIVE FUNCTION BODY, regardless of
-- what is currently live. Concretely: whatever get_user_schedule_load() is actually running on
-- the live DB right now — whether that's exactly 20261110's committed text, or (per the still-
-- open scenario 2b investigation) some other/stale body left over from an earlier draft of that
-- migration — applying THIS migration overwrites it completely with the text in this file. So if
-- 2b's prod failure turns out to have been caused by a stale/mismatched live body rather than a
-- genuine logic bug, applying this migration resolves that as a side effect, without needing to
-- separately re-apply 20261110 first. If 2b was instead caused by a real bug in the counting
-- logic itself, that bug is carried over unchanged here (see the note above) and 2b would still
-- fail after this migration too — re-run 20261110000000_user_schedule_load_tests.sql's own
-- scenario 2 after applying this migration to find out which case it was.
begin;

drop function if exists public.get_user_schedule_load(text, date, date, timestamptz);

create function public.get_user_schedule_load(
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

  -- All of this assignee's overdue, still-open tasks, system-wide — independent of [p_from, p_to].
  select count(*)
    into v_carried_over_count
  from public.tasks t
  where t.due_date < v_today
    and t.status not in ('completed', 'closed')
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
        or t.status not in ('completed', 'closed')
      )
    group by gs.d
    order by gs.d;
end;
$$;

revoke all on function public.get_user_schedule_load(text, date, date, timestamptz) from public, anon;
grant execute on function public.get_user_schedule_load(text, date, date, timestamptz) to authenticated, service_role;

commit;
