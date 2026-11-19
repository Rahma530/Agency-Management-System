-- AM Renewal rework (2026-11-19): record_client_renewal_payment now also takes the NEXT renewal
-- date as a required, hand-typed argument — no auto-calculated default from renewal_duration.
-- Owner's own example: a client due 10/10 might actually renew 10/15; relying on duration-math to
-- predict the next date silently drifts from reality, so the AM must look at what actually
-- happened and type the real next renewal date every time. clients.renewal_date is updated in the
-- same transaction as the payment row for the same reason the original version already kept
-- renewal_value in sync there: the date and the payment that confirms it must never be written
-- separately.

begin;

create or replace function public.record_client_renewal_payment(
  p_client_id text,
  p_renewal_value numeric,
  p_amount_paid numeric,
  p_payment_channel text,
  p_renewal_duration_months integer,
  p_transfer_screenshot_path text,
  p_next_renewal_date date,
  p_new_contract_path text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_caller_id text;
  v_caller_role text;
  v_sequence integer;
  v_payment_id text;
begin
  v_caller_id := public.app_user_id();

  if auth.uid() is null or v_caller_id is null then
    raise exception 'You must be signed in as a KMS employee to record a renewal payment.';
  end if;

  v_caller_role := public.app_user_role();

  select * into v_client from public.clients where id = p_client_id for update;
  if not found then
    raise exception 'Client not found.';
  end if;

  if v_caller_role not in ('executive', 'head_of_technical', 'am_team_lead')
    and not (v_caller_role = 'am_agent' and v_client.am_agent_id is not distinct from v_caller_id) then
    raise exception 'You do not have permission to record a renewal payment for this client.';
  end if;

  if p_renewal_value is null or p_renewal_value <= 0 then
    raise exception 'Renewal value must be a positive amount.';
  end if;

  if p_amount_paid is null or p_amount_paid <= 0 then
    raise exception 'Amount paid must be a positive amount.';
  end if;

  if p_payment_channel not in ('mahdy', 'masry', 'tabby', 'tamara', 'kesra') then
    raise exception 'Unknown payment channel.';
  end if;

  if p_renewal_duration_months not in (1, 3, 6, 12) then
    raise exception 'Renewal duration must be 1, 3, 6, or 12 months.';
  end if;

  if p_transfer_screenshot_path is null or length(trim(p_transfer_screenshot_path)) = 0 then
    raise exception 'A transfer screenshot is required to record a renewal payment.';
  end if;

  if p_next_renewal_date is null then
    raise exception 'The next renewal date is required — it is never auto-calculated.';
  end if;

  v_sequence := coalesce(v_client.renewal_history_count, 0) + 1;
  v_payment_id := gen_random_uuid()::text;

  insert into public.client_renewal_payments (
    id, client_id, renewal_sequence, renewal_value, amount_paid, payment_channel,
    renewal_duration_months, transfer_screenshot_path, new_contract_path, recorded_by
  ) values (
    v_payment_id, p_client_id, v_sequence, p_renewal_value, p_amount_paid, p_payment_channel,
    p_renewal_duration_months, p_transfer_screenshot_path, p_new_contract_path, v_caller_id
  );

  update public.clients
  set renewal_value = p_renewal_value, renewal_date = p_next_renewal_date
  where id = p_client_id;

  return v_payment_id;
end;
$$;

-- Old 7-arg signature (without p_next_renewal_date) is dropped — PR #327's version never
-- shipped a working caller against production (the client-loading outage on 2026-11-18 meant
-- the Renewals page itself was broken from the moment it went live), so there is no in-flight
-- caller to keep both signatures for.
drop function if exists public.record_client_renewal_payment(text, numeric, numeric, text, integer, text, text);

revoke all on function public.record_client_renewal_payment(text, numeric, numeric, text, integer, text, date, text) from public;
revoke all on function public.record_client_renewal_payment(text, numeric, numeric, text, integer, text, date, text) from anon;
grant execute on function public.record_client_renewal_payment(text, numeric, numeric, text, integer, text, date, text) to authenticated;

commit;
