-- get_user_schedule_load(p_user_id, p_from, p_to, p_as_of) — SECURITY DEFINER, counts only, no
-- task or client content. Backs the designer-scheduling due-date/estimated-hours suggestion
-- feature (src/lib/designerScheduling.ts): the frontend needs per-day task counts for a CHOSEN
-- creative assignee to suggest their next open day, but client-side RLS (tasks_select_rls) hides
-- most other people's tasks from the caller entirely — this function is the one door that
-- returns just the aggregate counts a suggestion needs, never the underlying rows.
--
-- Also adds get_server_today(p_as_of) — a tiny companion function so the FRONTEND never has to
-- guess "today" either (see the Timezone section below): it calls this instead of deriving
-- today's date from the browser's own clock/timezone, for the same anchor date the suggestion
-- algorithm (suggestDueDateAndHours in src/lib/designerScheduling.ts) walks forward from.
--
-- Deviation from the literal spec worth flagging explicitly: p_user_id is TEXT, not UUID.
-- public.users.id is `text` throughout this schema (canonical_schema_v4.sql: `id text primary
-- key`), and every other RPC in this codebase takes `p_task_id text`/`p_user_ids text[]`/etc. — a
-- uuid parameter would simply never match a real users.id value. Using uuid here would be a
-- silent no-op bug, not a stricter type.
--
-- Return shape: (due_date, task_count) ONLY — no titles, ids, client names, or status column.
-- One row per calendar day in [p_from, p_to], including empty days (count 0), via
-- generate_series + a LEFT JOIN, so a caller can walk the whole window without separately having
-- to know which days have zero tasks.
--
-- ----------------------------------------------------------------------------------------------
-- Timezone: why "today" is Africa/Cairo, never current_date/UTC, and never client-guessed.
-- ----------------------------------------------------------------------------------------------
-- Whether a given day counts ALL tasks or only open ones hinges entirely on whether that day is
-- "today or earlier" from the AGENCY's own calendar, not from whatever timezone the Postgres
-- session happens to be running in (Supabase sessions default to UTC) and not from whatever
-- timezone an individual employee's browser happens to report. Cairo is 2-3 hours ahead of UTC
-- (standard/DST) — so for roughly the first 2-3 hours of every Cairo calendar day, a bare
-- `current_date` read under a UTC session would still report the PREVIOUS day. A task due on
-- that just-started Cairo day would then be wrongly treated as "future" (open-only counting)
-- instead of "today" (count-all) during exactly that window — silently letting a 7th task get
-- defaulted onto a day whose 6th task already quietly completed, the one thing this whole
-- feature exists to prevent.
--
-- Fix: every "is this today-or-earlier" decision below reads v_today, computed as
-- `(p_as_of at time zone 'Africa/Cairo')::date` — never `current_date` (session-timezone-
-- dependent) and never a value the caller supplies as "today" directly (a text/date parameter
-- named p_today would just move the guessing into client code, exactly what this function exists
-- to avoid). p_as_of defaults to `now()` (the real current instant) for every real caller; it
-- exists as a parameter ONLY so the verification file can pass a FIXED, known instant and
-- deterministically exercise the Cairo-midnight-crossing window without touching the real system
-- clock (see that file's own comment) — this is "simulate via a parameter," not a backdoor that
-- changes behavior for a real caller, who never passes it.
--
-- The frontend needs its own notion of "today" too, as the anchor suggestDueDateAndHours() walks
-- forward from (and as part of the [p_from, p_to] window it asks this function for) — it must
-- not derive that from the browser's own clock/timezone either, since an employee's machine could
-- be set to any timezone. get_server_today() below is the one door for that: same Cairo
-- conversion, same p_as_of-for-testability shape, called by the frontend instead of any client-
-- side "what's today" computation.
--
-- ----------------------------------------------------------------------------------------------
-- Counting rule (byte-identical to buildScheduleLoadByDate() in src/lib/designerScheduling.ts,
-- which exists so the same rule is independently unit-testable without a database): for a day
-- that is v_today or earlier, count ALL of this user's tasks due that day, done or not — so a 7th
-- task is never defaulted onto a day whose 6th task already quietly completed. For a day after
-- v_today, count only tasks that are still open (status not in ('completed', 'closed') —
-- byte-identical to isTaskDone() in src/lib/taskLifecycle.ts). Counts via task_assignees
-- membership (join task_assignees -> tasks), same real multi-assignee measure
-- get_capacity_snapshot() already uses in 20261105000000_task_assignees_rpcs.sql, not the legacy
-- single assigned_to column.
--
-- "Archived excluded": public.tasks has NO archived_at column and no archived status today —
-- confirmed via `grep -rn "archived_at" supabase/migrations/*.sql src/types/database.ts`, which
-- finds archived_at only on public.reports. There is therefore nothing additional to exclude
-- here beyond the done/open distinction the counting rule above already draws; this comment
-- documents that check rather than adding a no-op `and t.archived_at is null` clause against a
-- column that doesn't exist. IMPORTANT, ACTION REQUIRED LATER: if an archive/archived_at column
-- is EVER added to public.tasks, this function MUST be updated to exclude archived tasks (add
-- `and t.archived_at is null` to the join predicate below) in the SAME change that adds the
-- column — and buildScheduleLoadByDate() in src/lib/designerScheduling.ts must gain the matching
-- `if (task.archived_at) continue;` behavior at the same time (it already defensively supports
-- that field today), so the two counting rules can never drift apart.
--
-- ----------------------------------------------------------------------------------------------
-- Caller gate — "authenticated and allowed to assign to that user," reusing
-- assignable_employees()'s own per-row target filter (20261101100000_task_cross_team_visibility.sql)
-- as the "is this a legitimate assignment target" check, PLUS an explicit sales-caller exclusion
-- that function doesn't itself need (its own row list already excludes sales as a possible
-- TARGET, but says nothing about who may CALL it — this function's caller check is stricter on
-- purpose, per "never expose counts to sales"):
--   1. sales may never call this function at all, regardless of target.
--   2. the target user must be an active employee (auth_id is not null, deactivated_at is null).
--   3. the target user's role must not be 'sales'.
--   4. the target user's role must not be 'marketing_manager' — this feature's own exclusion
--      (isCreativeAssignee() in src/lib/designerScheduling.ts), enforced here too so a direct RPC
--      call can't bypass what the UI already filters out.
--   5. the target user's role must not be 'executive'/'head_of_technical' UNLESS the caller
--      themselves is 'executive' (byte-identical to assignable_employees()'s own exec/HOT branch).
-- In production use the target is always a creative role (graphic_designer/video_editor/
-- ui_ux_designer), so branches 3-5 are defensive rather than load-bearing for this feature, but
-- the function is written to be correct for any target, not just the Creative-department case.
begin;

create or replace function public.get_server_today(p_as_of timestamptz default now())
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (p_as_of at time zone 'Africa/Cairo')::date;
$$;

revoke all on function public.get_server_today(timestamptz) from public, anon;
grant execute on function public.get_server_today(timestamptz) to authenticated, service_role;

create or replace function public.get_user_schedule_load(
  p_user_id text,
  p_from date,
  p_to date,
  p_as_of timestamptz default now()
)
returns table(due_date date, task_count integer)
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

  return query
    select
      gs.d::date as due_date,
      count(t.id)::integer as task_count
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
