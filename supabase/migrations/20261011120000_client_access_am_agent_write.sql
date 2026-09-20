-- Grant AM Agent full edit rights on the "Client Access" fields, matching Executive/Head of
-- Technical/AM Team Leader — all four roles in canAccessClientSensitiveInfo() have both view AND
-- edit rights here.
--
-- Why an RPC instead of widening clients_update_am_assignment_rls: that policy is the ONLY UPDATE
-- policy on public.clients, and RLS is row-level, not column-level — adding an am_agent branch to
-- it would let an AM Agent update EVERY column on their own client (contract_value, status,
-- am_team_lead_id, due_value/remaining_value, etc.), silently reopening the Payment Tracking
-- write restriction that ClientDashboard.tsx's canEditPaymentTracking deliberately keeps
-- am_agent out of ("am_agent is read-only here"). A SECURITY DEFINER function scoped to exactly
-- these Client Access columns grants the write access this section needs without touching that
-- boundary. Every parameter is nullable — none of these fields may ever be required.
create or replace function public.update_client_access(
  p_client_id text,
  p_general_email text,
  p_general_email_password text,
  p_store_platform_username text,
  p_store_platform_password text,
  p_social_media_username text,
  p_social_media_password text,
  p_ad_account_username text,
  p_ad_account_password text,
  p_ad_account_setup_type text,
  p_payment_card_details text
)
returns public.clients
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to edit this client''s access details.';
  end if;

  update public.clients
  set
    general_email = p_general_email,
    general_email_password = p_general_email_password,
    store_platform_username = p_store_platform_username,
    store_platform_password = p_store_platform_password,
    social_media_username = p_social_media_username,
    social_media_password = p_social_media_password,
    ad_account_username = p_ad_account_username,
    ad_account_password = p_ad_account_password,
    ad_account_setup_type = p_ad_account_setup_type,
    payment_card_details = p_payment_card_details
  where id = p_client_id
  returning * into v_client;

  return v_client;
end;
$$;

grant execute on function public.update_client_access(
  text, text, text, text, text, text, text, text, text, text, text
) to authenticated;
