-- Phase 4: confirm a client renewal as one atomic, durable operation. The role gate mirrors the
-- existing Close/Reopen lifecycle authorization exactly; no table policy or direct table grant is
-- changed by this migration.
begin;

create function public.confirm_client_renewal(p_client_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_caller_id text;
  v_caller_role text;
  v_max_sequence integer;
  v_next_sequence integer;
  v_completed_target_date date;
begin
  v_caller_id := public.app_user_id();

  if auth.role() is distinct from 'service_role' then
    v_caller_role := public.app_user_role();

    if auth.uid() is null or v_caller_id is null or v_caller_role is null then
      raise exception 'You must be signed in as a KMS employee to confirm a client renewal.';
    end if;

    if v_caller_role not in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'am_agent') then
      raise exception 'You do not have permission to confirm this client renewal.';
    end if;
  elsif v_caller_id is null then
    -- client_renewal_events.recorded_by is required and references public.users. Service-role
    -- automation must therefore run with a real KMS employee identity in its JWT context rather
    -- than fabricating or accepting an attribution value from the caller.
    raise exception 'A KMS employee identity is required to record this client renewal.';
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
    raise exception 'You do not have permission to confirm this client renewal.';
  end if;

  if v_client.status <> 'renewal' then
    raise exception 'Only a client in Renewal status can have its renewal confirmed.';
  end if;

  if v_client.renewal_date is null then
    raise exception 'This client has no renewal date set. Set one in Client Dates above before confirming renewal.';
  end if;

  v_completed_target_date := v_client.renewal_date;

  select max(renewal_sequence)
  into v_max_sequence
  from public.client_renewal_events
  where client_id = p_client_id;

  if v_client.renewal_history_count is not null then
    if v_client.renewal_history_count <> coalesce(v_max_sequence, 0) then
      raise exception 'Renewal history is inconsistent for this client. Confirmation was not recorded.';
    end if;

    v_next_sequence := v_client.renewal_history_count + 1;
  else
    -- NULL remains legacy/unknown before confirmation. Sequence 1 means only that this is the
    -- first durable event recorded by Phase 4 when no earlier event rows exist.
    v_next_sequence := coalesce(v_max_sequence, 0) + 1;
  end if;

  insert into public.client_renewal_events (
    id,
    client_id,
    completed_target_date,
    actual_renewal_date,
    renewal_sequence,
    recorded_by
  ) values (
    gen_random_uuid()::text,
    p_client_id,
    v_completed_target_date,
    current_date,
    v_next_sequence,
    v_caller_id
  );

  update public.clients
  set status = 'active',
      renewal_date = (v_completed_target_date + interval '1 year')::date,
      renewal_history_count = v_next_sequence
  where id = p_client_id;
end;
$$;

revoke all on function public.confirm_client_renewal(text) from public;
revoke all on function public.confirm_client_renewal(text) from anon;
grant execute on function public.confirm_client_renewal(text) to authenticated;
grant execute on function public.confirm_client_renewal(text) to service_role;

commit;
