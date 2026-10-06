-- Why a function instead of widening clients_update_am_assignment_rls (the only UPDATE policy on
-- public.clients, 20261018000000_align_ai_engineer_with_head_of_technical.sql) to add an am_agent
-- clause: a row-level policy cannot restrict which COLUMNS an update touches, only which ROWS are
-- visible to it. Adding `or (app_user_role() = 'am_agent' and am_agent_id = app_user_id())` to that
-- policy's USING/WITH CHECK would let an am_agent UPDATE every column on their own assigned
-- client's row through a direct table update — including sales_owner_id, am_team_lead_id,
-- contract_value, status, or any Client Access column grant that might ever loosen — not just
-- start_date/renewal_date, since Postgres RLS has no per-column equivalent of a column-level GRANT
-- for UPDATE. update_client_dates() is SECURITY DEFINER and only ever sets these two columns in its
-- own body, so it can safely grant am_agent (and sales, who already could reach these two columns
-- via a direct update under the existing policy, but goes through this RPC too now for one single
-- code path and one single audit point) exactly this one capability without widening anything else
-- they can touch on the row.
--
-- Role gate here is byte-for-byte canEditClientDates (src/lib/permissions.ts): executive/
-- head_of_technical/ai_engineer/am_team_lead unconditionally; am_agent only for a client where
-- they are the assigned am_agent_id; sales only for a client where they are the sales_owner_id.
begin;

create or replace function public.update_client_dates(
  p_client_id text,
  p_start_date date,
  p_renewal_date date
)
returns void
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
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
    or (public.app_user_role() = 'sales' and v_client.sales_owner_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to edit this client''s dates.';
  end if;

  update public.clients
  set start_date = p_start_date, renewal_date = p_renewal_date
  where id = p_client_id;
end;
$$;

revoke execute on function public.update_client_dates(text, date, date) from public, anon;
grant execute on function public.update_client_dates(text, date, date) to authenticated, service_role;

commit;
