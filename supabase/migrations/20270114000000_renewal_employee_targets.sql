-- Client Renewals page, employee panel: monthly renewal target per employee, set by that
-- employee's manager or team lead (owner decision, 2026-11-18) — never by the employee
-- themselves. "Achieved" is NOT stored here: the Renewals page computes it by summing
-- client_renewal_payments.amount_paid where recorded_by = employee and payment_date falls in
-- that month, so it can never drift from the actual payment ledger.
--
-- month is stored as the first-of-month date (e.g. 2026-11-01) — a plain, sortable, unique-
-- constraint-friendly key for "which month", with no day-of-month ambiguity.

begin;

create table public.renewal_employee_targets (
  id text primary key,
  employee_id text not null references public.users (id),
  month date not null,
  target_value numeric not null check (target_value >= 0),
  set_by text not null references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, month)
);

create index idx_renewal_employee_targets_month on public.renewal_employee_targets (month);

alter table public.renewal_employee_targets enable row level security;

-- Read: the employee themselves (sees their own target), their manager, or anyone who could set
-- targets agency-wide (executive/head_of_technical/am_team_lead — same reporting roles as
-- Payment Tracking) so the Renewals page's employee panel can show everyone at once for those
-- roles.
create policy "renewal_employee_targets_select_rls" on public.renewal_employee_targets
for select to authenticated
using (
  employee_id = public.app_user_id()
  or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or exists (
    select 1 from public.users u where u.id = renewal_employee_targets.employee_id and u.manager_id = public.app_user_id()
  )
);

create policy "renewal_employee_targets_insert_rls" on public.renewal_employee_targets
for insert to authenticated
with check (
  set_by = public.app_user_id()
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or exists (select 1 from public.users u where u.id = employee_id and u.manager_id = public.app_user_id())
  )
);

create policy "renewal_employee_targets_update_rls" on public.renewal_employee_targets
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or exists (select 1 from public.users u where u.id = employee_id and u.manager_id = public.app_user_id())
)
with check (
  set_by = public.app_user_id()
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or exists (select 1 from public.users u where u.id = employee_id and u.manager_id = public.app_user_id())
  )
);

grant select, insert, update on public.renewal_employee_targets to authenticated;

-- upsert_renewal_employee_target: the single write path (insert-or-replace for a given
-- employee+month) so the frontend never has to decide between insert/update itself or race the
-- unique constraint.
create function public.upsert_renewal_employee_target(
  p_employee_id text,
  p_month date,
  p_target_value numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_id text;
  v_caller_role text;
  v_month date;
begin
  v_caller_id := public.app_user_id();
  if auth.uid() is null or v_caller_id is null then
    raise exception 'You must be signed in as a KMS employee to set a renewal target.';
  end if;

  v_caller_role := public.app_user_role();

  if v_caller_role not in ('executive', 'head_of_technical', 'am_team_lead')
    and not exists (select 1 from public.users u where u.id = p_employee_id and u.manager_id = v_caller_id) then
    raise exception 'You do not have permission to set a renewal target for this employee.';
  end if;

  if p_target_value is null or p_target_value < 0 then
    raise exception 'Target value must be zero or a positive amount.';
  end if;

  -- Normalize to the first of the month regardless of what date the caller passed, so a
  -- duplicate attempt for the same month always hits the same row instead of creating a sibling.
  v_month := date_trunc('month', p_month)::date;

  insert into public.renewal_employee_targets (id, employee_id, month, target_value, set_by)
  values (gen_random_uuid()::text, p_employee_id, v_month, p_target_value, v_caller_id)
  on conflict (employee_id, month)
  do update set target_value = excluded.target_value, set_by = excluded.set_by, updated_at = now();
end;
$$;

revoke all on function public.upsert_renewal_employee_target(text, date, numeric) from public;
revoke all on function public.upsert_renewal_employee_target(text, date, numeric) from anon;
grant execute on function public.upsert_renewal_employee_target(text, date, numeric) to authenticated;

commit;
