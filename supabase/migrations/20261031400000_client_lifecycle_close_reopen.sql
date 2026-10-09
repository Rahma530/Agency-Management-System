-- Phase 2: route client Close/Reopen through atomic, lifecycle-aware operations.
-- The role gate mirrors ClientDashboard's existing canManageLifecycle check exactly:
-- leadership/AM Team Lead may manage any client, while an AM Agent may manage only
-- the client currently assigned to them. No existing table policy is changed.
begin;

create function public.close_client(
  p_client_id text,
  p_stop_date date,
  p_closure_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_caller_id text;
  v_caller_role text;
  v_open_period_id text;
  v_open_period_started_on date;
  v_closure_reason text;
begin
  if auth.role() is distinct from 'service_role' then
    v_caller_id := public.app_user_id();
    v_caller_role := public.app_user_role();

    if auth.uid() is null or v_caller_id is null or v_caller_role is null then
      raise exception 'You must be signed in as a KMS employee to close a client.';
    end if;

    if v_caller_role not in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'am_agent') then
      raise exception 'You do not have permission to close this client.';
    end if;
  end if;

  select *
  into v_client
  from public.clients
  where id = p_client_id
  for update;

  if not found then
    raise exception 'Client not found.';
  end if;

  if auth.role() is distinct from 'service_role'
    and v_caller_role = 'am_agent'
    and v_client.am_agent_id is distinct from v_caller_id then
    raise exception 'You do not have permission to close this client.';
  end if;

  if v_client.status = 'closed' then
    raise exception 'This client is already closed.';
  end if;

  if p_stop_date is null then
    raise exception 'Stop / Loss Date is required.';
  end if;

  if p_stop_date > current_date then
    raise exception 'Stop / Loss Date cannot be in the future.';
  end if;

  if v_client.start_date is not null and p_stop_date < v_client.start_date then
    raise exception 'Stop / Loss Date cannot be earlier than the Start Date.';
  end if;

  v_closure_reason := nullif(btrim(p_closure_reason), '');
  if v_closure_reason is null then
    raise exception 'Closure Reason is required.';
  end if;

  select id, started_on
  into v_open_period_id, v_open_period_started_on
  from public.client_lifecycle_periods
  where client_id = p_client_id
    and ended_on is null
  for update;

  if v_open_period_id is not null then
    if p_stop_date < v_open_period_started_on then
      raise exception 'Stop / Loss Date cannot be earlier than the current lifecycle period start date.';
    end if;

    update public.client_lifecycle_periods
    set ended_on = p_stop_date,
        closure_reason = v_closure_reason,
        updated_at = now()
    where id = v_open_period_id;
  elsif v_client.start_date is not null then
    insert into public.client_lifecycle_periods (
      id,
      client_id,
      started_on,
      ended_on,
      closure_reason
    ) values (
      gen_random_uuid()::text,
      p_client_id,
      v_client.start_date,
      p_stop_date,
      v_closure_reason
    );
  end if;

  update public.clients
  set status = 'closed',
      churned_at = p_stop_date::timestamp at time zone 'UTC',
      churn_reason = v_closure_reason
  where id = p_client_id;
end;
$$;

create function public.reopen_client(
  p_client_id text,
  p_reopen_date date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_caller_id text;
  v_caller_role text;
  v_existing_open_period_id text;
  v_has_lifecycle_history boolean;
  v_latest_ended_on date;
  v_legacy_ended_on date;
begin
  if auth.role() is distinct from 'service_role' then
    v_caller_id := public.app_user_id();
    v_caller_role := public.app_user_role();

    if auth.uid() is null or v_caller_id is null or v_caller_role is null then
      raise exception 'You must be signed in as a KMS employee to reopen a client.';
    end if;

    if v_caller_role not in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'am_agent') then
      raise exception 'You do not have permission to reopen this client.';
    end if;
  end if;

  select *
  into v_client
  from public.clients
  where id = p_client_id
  for update;

  if not found then
    raise exception 'Client not found.';
  end if;

  if auth.role() is distinct from 'service_role'
    and v_caller_role = 'am_agent'
    and v_client.am_agent_id is distinct from v_caller_id then
    raise exception 'You do not have permission to reopen this client.';
  end if;

  if v_client.status <> 'closed' then
    raise exception 'Only a closed client can be reopened.';
  end if;

  if p_reopen_date is null then
    raise exception 'Reopen Date is required.';
  end if;

  if p_reopen_date > current_date then
    raise exception 'Reopen Date cannot be in the future.';
  end if;

  select id
  into v_existing_open_period_id
  from public.client_lifecycle_periods
  where client_id = p_client_id
    and ended_on is null
  for update;

  if v_existing_open_period_id is not null then
    raise exception 'This client already has an open lifecycle period.';
  end if;

  select exists (
    select 1
    from public.client_lifecycle_periods
    where client_id = p_client_id
  ) into v_has_lifecycle_history;

  select max(ended_on)
  into v_latest_ended_on
  from public.client_lifecycle_periods
  where client_id = p_client_id;

  if not v_has_lifecycle_history
    and v_client.start_date is not null
    and p_reopen_date < v_client.start_date then
    raise exception 'Reopen Date cannot be earlier than the original Start Date.';
  end if;

  if not v_has_lifecycle_history
    and v_client.start_date is not null
    and v_client.churned_at is not null then
    v_legacy_ended_on := (v_client.churned_at at time zone 'UTC')::date;

    if v_legacy_ended_on >= v_client.start_date
      and v_legacy_ended_on <= current_date then
      v_latest_ended_on := v_legacy_ended_on;
    end if;
  end if;

  if v_latest_ended_on is not null and p_reopen_date < v_latest_ended_on then
    raise exception 'Reopen Date cannot be earlier than the latest lifecycle period end date.';
  end if;

  if not v_has_lifecycle_history
    and v_legacy_ended_on is not null
    and v_legacy_ended_on >= v_client.start_date
    and v_legacy_ended_on <= current_date then
    insert into public.client_lifecycle_periods (
      id,
      client_id,
      started_on,
      ended_on,
      closure_reason
    ) values (
      gen_random_uuid()::text,
      p_client_id,
      v_client.start_date,
      v_legacy_ended_on,
      v_client.churn_reason
    );
  end if;

  insert into public.client_lifecycle_periods (
    id,
    client_id,
    started_on,
    ended_on,
    closure_reason
  ) values (
    gen_random_uuid()::text,
    p_client_id,
    p_reopen_date,
    null,
    null
  );

  update public.clients
  set status = 'active',
      churned_at = null,
      churn_reason = null
  where id = p_client_id;
end;
$$;

revoke execute on function public.close_client(text, date, text) from public, anon;
grant execute on function public.close_client(text, date, text) to authenticated, service_role;

revoke execute on function public.reopen_client(text, date) from public, anon;
grant execute on function public.reopen_client(text, date) to authenticated, service_role;

commit;
