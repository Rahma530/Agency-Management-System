-- Grant AM Agent full edit rights on the "Client Access" tab (access_username, access_password,
-- ad_account_access_details, payment_card_details), matching Executive/Head of Technical/AM Team
-- Leader — all four roles in canAccessClientSensitiveInfo() now have both view AND edit rights on
-- this tab.
--
-- Why an RPC instead of widening clients_update_am_assignment_rls: that policy is the ONLY UPDATE
-- policy on public.clients, and RLS is row-level, not column-level — adding an am_agent branch to
-- it would let an AM Agent update EVERY column on their own client (contract_value, status,
-- am_team_lead_id, due_value/remaining_value, etc.), silently reopening the Payment Tracking
-- write restriction that ClientDashboard.tsx's canEditPaymentTracking deliberately keeps
-- am_agent out of ("am_agent is read-only here"). A SECURITY DEFINER function scoped to exactly
-- these four columns grants the write access this tab needs without touching that boundary.
create or replace function public.update_client_access(
  p_client_id text,
  p_access_username text,
  p_access_password text,
  p_ad_account_access_details text,
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
    access_username = p_access_username,
    access_password = p_access_password,
    ad_account_access_details = p_ad_account_access_details,
    payment_card_details = p_payment_card_details
  where id = p_client_id
  returning * into v_client;

  return v_client;
end;
$$;

grant execute on function public.update_client_access(text, text, text, text, text) to authenticated;
