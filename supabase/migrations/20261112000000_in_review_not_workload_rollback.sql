-- ROLLBACK for 20261112000000_in_review_not_workload.sql.
--
-- Restores get_user_schedule_load() to 20261111000000_user_schedule_load_carry_over.sql's exact
-- body (status not in ('completed', 'closed') for the future-day/carried-over filters), drops the
-- trigger and its function, then drops the three columns. Order matters: the trigger/function must
-- go before the columns they reference, and get_user_schedule_load has no column dependency so its
-- order relative to the others doesn't matter — restored first here only for readability (grouped
-- with part 2 of the forward migration).
begin;

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

drop trigger if exists tasks_track_delivery_and_revisions_trigger on public.tasks;
drop function if exists public.track_delivery_and_revisions();

alter table public.tasks
  drop column if exists delivered_at,
  drop column if exists revision_count,
  drop column if exists revision_started_at;

commit;
