-- record_client_renewal_payment: the single write path for the Client Renewals page's payment
-- form (amount, channel, duration, transfer screenshot, optional new contract). security definer
-- so it can also keep clients.renewal_value in sync in the same transaction as the payment row —
-- the two must never be written separately from the client, or a renewal_value update could land
-- without its payment (or vice versa) if the second statement failed.
--
-- renewal_sequence is computed server-side as clients.renewal_history_count + 1 (never passed by
-- the caller) — this is exactly "the renewal round currently open", the same convention
-- confirm_client_renewal (20270109000000) already uses, so payments stay attributed correctly
-- even if the client's renewal is confirmed (advancing the counter) between two payments that
-- were actually meant for the same cycle — the caller always means "this renewal", not a specific
-- number it has to track itself.

begin;

create function public.record_client_renewal_payment(
  p_client_id text,
  p_renewal_value numeric,
  p_amount_paid numeric,
  p_payment_channel text,
  p_renewal_duration_months integer,
  p_transfer_screenshot_path text,
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

  v_sequence := coalesce(v_client.renewal_history_count, 0) + 1;
  v_payment_id := gen_random_uuid()::text;

  insert into public.client_renewal_payments (
    id, client_id, renewal_sequence, renewal_value, amount_paid, payment_channel,
    renewal_duration_months, transfer_screenshot_path, new_contract_path, recorded_by
  ) values (
    v_payment_id, p_client_id, v_sequence, p_renewal_value, p_amount_paid, p_payment_channel,
    p_renewal_duration_months, p_transfer_screenshot_path, p_new_contract_path, v_caller_id
  );

  update public.clients set renewal_value = p_renewal_value where id = p_client_id;

  return v_payment_id;
end;
$$;

revoke all on function public.record_client_renewal_payment(text, numeric, numeric, text, integer, text, text) from public;
revoke all on function public.record_client_renewal_payment(text, numeric, numeric, text, integer, text, text) from anon;
grant execute on function public.record_client_renewal_payment(text, numeric, numeric, text, integer, text, text) to authenticated;

commit;
