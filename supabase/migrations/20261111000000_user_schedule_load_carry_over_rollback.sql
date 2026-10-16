-- ROLLBACK for 20261111000000_user_schedule_load_carry_over.sql — restores the prior two-column
-- get_user_schedule_load(text, date, date, timestamptz) (due_date, task_count only, no
-- carried_over_count), byte-identical to 20261110000000_user_schedule_load.sql's own definition.
begin;

drop function if exists public.get_user_schedule_load(text, date, date, timestamptz);

create function public.get_user_schedule_load(
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
