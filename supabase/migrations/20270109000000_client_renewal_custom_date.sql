-- confirm_client_renewal previously always set the new renewal_date to exactly
-- (old renewal_date + 1 year), with no way to record a different agreed renewal period (e.g. a
-- 6-month renewal). Adds an optional p_new_renewal_date parameter: when provided, it's used as
-- the new renewal_date (after validating it's strictly after the renewal being confirmed, so a
-- stale/past date can't be recorded by mistake); when omitted (the default), behavior is
-- unchanged — the existing +1 year calculation — so the one existing caller
-- (App.tsx's handleConfirmClientRenewal, called with just a client id from AMQueue's quick-action
-- menu) keeps working exactly as before unless it opts in to passing a date.
begin;

-- Must drop the old single-argument signature first: `create or replace` with a different
-- parameter list creates a second, overloaded function rather than replacing this one (Postgres
-- identifies a function by name + parameter types together). Leaving both in place would make
-- PostgREST's RPC call with only p_client_id ambiguous between "the old signature" and "the new
-- signature using its default" — a real "function is not unique" error, not a theoretical one.
drop function if exists public.confirm_client_renewal(text);

create function public.confirm_client_renewal(p_client_id text, p_new_renewal_date date default null)
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
  v_next_renewal_date date;
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

  if p_new_renewal_date is not null then
    if p_new_renewal_date <= v_completed_target_date then
      raise exception 'The new renewal date must be after the renewal date being confirmed (%).', v_completed_target_date;
    end if;
    v_next_renewal_date := p_new_renewal_date;
  else
    v_next_renewal_date := (v_completed_target_date + interval '1 year')::date;
  end if;

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
      renewal_date = v_next_renewal_date,
      renewal_history_count = v_next_sequence
  where id = p_client_id;
end;
$$;

revoke all on function public.confirm_client_renewal(text, date) from public;
revoke all on function public.confirm_client_renewal(text, date) from anon;
grant execute on function public.confirm_client_renewal(text, date) to authenticated;
grant execute on function public.confirm_client_renewal(text, date) to service_role;

commit;
