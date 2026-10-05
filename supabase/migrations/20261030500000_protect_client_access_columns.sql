-- Removes the same "every select('*') ships every column to anyone who can see the row at all"
-- exposure this engagement already closed for public.users.password, now for the 10 "Client
-- Access" columns on public.clients (general_email, general_email_password,
-- store_platform_username, store_platform_password, social_media_username,
-- social_media_password, ad_account_username, ad_account_password, ad_account_setup_type,
-- payment_card_details).
--
-- Audit that led to this migration (read-only, no changes):
-- 1. Every real query against public.clients lives in src/App.tsx, src/ClientPortalApp.tsx, and
--    ClientDashboard.tsx's onUpdateClientAccess/onFetchClientAccess props threaded through
--    CampaignManagementModule.tsx/AMQueue.tsx/ServiceBriefsRoutingView.tsx — never in
--    supabase/functions/ or scripts/ (confirmed via grep, zero hits in either). Every one of those
--    call sites used select('*') or a bare .select() (same default), none of them actually needed
--    the 10 sensitive columns in the shared `clients` app state — those columns were only ever
--    displayed/edited in one place, ClientDashboard.tsx's gated "Client Access" section.
-- 2. The only function anywhere in this schema's history that selects/returns the full clients row
--    is update_client_access() (originally 20261011120000_client_access_am_agent_write.sql,
--    redefined by 20261018000000 and, currently, 20261019000000_ai_engineer_full_application_
--    authorization.sql) — `select * into v_client ...; update ... returning * into v_client`,
--    `returns public.clients`. No RLS policy, view, index, or other RPC selects clients.* or
--    returns the clients row type.
-- 3. ClientRecord's 25 non-sensitive columns (everything except the 10 above) are granted below;
--    the frontend's NON_SENSITIVE_CLIENT_COLUMNS constant (src/types/database.ts) is the same list,
--    kept in sync by convention the same way other duplicated-on-purpose allowlists in this schema
--    are (e.g. ComparisonDisplay.tsx's own note on taskRegistry.ts's CAMPAIGN_SUMMARY allowlist).
--
-- What this migration does, in order:
-- 1. Column-level SELECT grant on public.clients: revoke the blanket table-level SELECT
--    (20260907090000_table_grants.sql's `grant select on public.clients to authenticated`) and
--    replace it with a column-level grant naming every column EXCEPT the 10 sensitive ones. Postgres
--    checks `select *` against every column a table has, so this alone makes the frontend's old
--    select('*') calls fail outright (fixed in the same change set as this migration, not here) —
--    the 10 sensitive columns simply disappear from what `authenticated` can read from this table at
--    all, independent of row-level RLS. insert/update table-level grants are untouched (unchanged
--    from 20260907090000_table_grants.sql); service_role is never named here, so it keeps whatever
--    it already has.
-- 2. client_access_log: an audit trail of every successful read of the 10 sensitive columns via
--    get_client_access() below. RLS-protected read access is Executive/Head of Technical/AI
--    Engineer only (the three roles with blanket client visibility already, per clients_select_rls)
--    — am_team_lead/am_agent, who can also call get_client_access() for clients they manage, cannot
--    read this log themselves. No INSERT/UPDATE/DELETE policy exists for `authenticated` at all:
--    the table is append-only, and the only thing that ever appends to it is get_client_access()
--    itself (SECURITY DEFINER, so it writes regardless of the caller's own grants).
-- 3. get_client_access(p_client_id): the only way any of the 10 sensitive columns ever reach the
--    browser now. Role gate is copied verbatim from update_client_access()'s current check
--    (ai_engineer unconditionally; executive/head_of_technical/am_team_lead unconditionally;
--    am_agent only for a client where they are the assigned am_agent_id) — read and write access to
--    this data stay symmetric on purpose. Logs the access (client_id, accessed_by =
--    app_user_id()) BEFORE returning, so a short-circuiting client-side failure after the RPC
--    responds can never suppress the log entry.
-- 4. update_client_access() is redefined to `returns void` — it used to return the full persisted
--    clients row (including these 10 columns) back into the browser, which the frontend then merged
--    into the shared `clients` app state readable by every component that consumes it. The role gate
--    inside the function is otherwise byte-for-byte unchanged. Its existing grants (authenticated,
--    added across its revisions) are re-stated explicitly below rather than left implicit.
-- 5. (This comment block) — any new column added to public.clients in the future must be added to
--    the grant in step 1 explicitly (there is no "grant everything except" shorthand in Postgres);
--    forgetting to do so means the new column is simply unreadable by `authenticated` at all, not a
--    security gap — a missing grant fails closed. Likewise, every new function created in this
--    schema needs its own explicit `grant execute`: Postgres grants EXECUTE to PUBLIC by default on
--    function creation (the same default-grant gap 20261030300000_revoke_excess_privileges.sql
--    already closed for every then-existing function and for all FUTURE functions via `alter
--    default privileges ... revoke execute on functions from public, anon` — so a function created
--    after that migration starts with NO execute grant at all, not even to authenticated, until one
--    is added explicitly here or in its own migration).
begin;

-- 1. Column-level SELECT grant on public.clients: every column except the 10 Client Access ones.
revoke select on public.clients from authenticated;
grant select (
  id, name, sector, industry, client_contact_name, phone_number, website_or_social_link,
  services, status, sales_owner_id, am_agent_id, am_team_lead_id, contract_value, start_date,
  renewal_date, am_team_lead_viewed_at, churn_reason, churned_at, portal_slug, due_value,
  remaining_value, contract_duration_months, notes, am_agent_assigned_at, created_at
) on public.clients to authenticated;

-- 2. client_access_log: append-only audit trail of every successful get_client_access() call.
create table public.client_access_log (
  id uuid default gen_random_uuid() primary key,
  client_id text not null,
  accessed_by text not null,
  accessed_at timestamptz not null default now()
);

alter table public.client_access_log enable row level security;

create policy "client_access_log_select_rls" on public.client_access_log for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
);

-- No insert/update/delete policy for authenticated at all — only get_client_access() (SECURITY
-- DEFINER) ever writes this table.
grant select on public.client_access_log to authenticated;
grant select, insert on public.client_access_log to service_role;

-- 3. get_client_access(): the only path any of the 10 sensitive columns ever reach the browser.
create or replace function public.get_client_access(p_client_id text)
returns table (
  general_email text,
  general_email_password text,
  store_platform_username text,
  store_platform_password text,
  social_media_username text,
  social_media_password text,
  ad_account_username text,
  ad_account_password text,
  ad_account_setup_type text,
  payment_card_details text
)
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
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to view this client''s access details.';
  end if;

  insert into public.client_access_log (client_id, accessed_by)
  values (p_client_id, public.app_user_id());

  return query select
    v_client.general_email,
    v_client.general_email_password,
    v_client.store_platform_username,
    v_client.store_platform_password,
    v_client.social_media_username,
    v_client.social_media_password,
    v_client.ad_account_username,
    v_client.ad_account_password,
    v_client.ad_account_setup_type,
    v_client.payment_card_details;
end;
$$;

revoke execute on function public.get_client_access(text) from public, anon;
grant execute on function public.get_client_access(text) to authenticated, service_role;

-- 4. update_client_access() now returns void instead of public.clients — the role gate is
-- otherwise byte-for-byte unchanged from the current definition
-- (20261019000000_ai_engineer_full_application_authorization.sql). CREATE OR REPLACE FUNCTION
-- cannot change a function's return type (Postgres raises "cannot change return type of existing
-- function" and refuses), so the old public.clients-returning signature must be dropped first;
-- no cascade, so this fails loudly instead of silently dropping any dependent object.
drop function if exists public.update_client_access(
  text, text, text, text, text, text, text, text, text, text, text
);
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
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
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
  where id = p_client_id;
end;
$$;

revoke execute on function public.update_client_access(
  text, text, text, text, text, text, text, text, text, text, text
) from public, anon;
grant execute on function public.update_client_access(
  text, text, text, text, text, text, text, text, text, text, text
) to authenticated, service_role;

commit;
