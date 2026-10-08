-- Separate employee Auth provisioning and recent activity from explicit portal-entry confirmation.
-- Invitation, authentication, presence, and impersonation behavior remain unchanged.
begin;

alter table public.users
  add column portal_entry_confirmed_at timestamptz;

create function public.confirm_employee_portal_entry(employee_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_role text;
  v_target public.users;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in as a KMS employee to confirm portal entry.';
  end if;

  select role
  into v_caller_role
  from public.users
  where auth_id = auth.uid()
    and deactivated_at is null;

  if not found or v_caller_role not in ('executive', 'head_of_technical', 'ai_engineer') then
    raise exception 'You do not have permission to confirm employee portal entry.';
  end if;

  if exists (
    select 1
    from public.impersonation_sessions
    where employee_auth_id = auth.uid()
      and ended_at is null
  ) then
    raise exception 'Portal entry cannot be confirmed from an impersonation session.';
  end if;

  select *
  into v_target
  from public.users
  where id = employee_id
  for update;

  if not found then
    raise exception 'Employee not found.';
  end if;

  if v_target.auth_id is null then
    raise exception 'Employee does not have a linked Auth account.';
  end if;

  if v_target.deactivated_at is not null then
    raise exception 'A deactivated employee cannot be marked Done.';
  end if;

  update public.users
  set portal_entry_confirmed_at = coalesce(portal_entry_confirmed_at, now())
  where id = employee_id;
end;
$$;

revoke all on function public.confirm_employee_portal_entry(text) from public;
revoke all on function public.confirm_employee_portal_entry(text) from anon;
grant execute on function public.confirm_employee_portal_entry(text) to authenticated;
grant execute on function public.confirm_employee_portal_entry(text) to service_role;
grant execute on function public.confirm_employee_portal_entry(text) to postgres;

commit;
