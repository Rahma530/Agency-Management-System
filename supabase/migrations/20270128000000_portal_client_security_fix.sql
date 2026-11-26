-- ============================================================================
-- Client Portal security fix (2026-11-26 audit)
--
-- PROBLEM:
-- ClientPortalApp.tsx loaded the client's own row with:
--   supabaseRaw.from('clients').select(NON_SENSITIVE_CLIENT_COLUMNS).eq('id', pu.client_id)
-- NON_SENSITIVE_CLIENT_COLUMNS is a FRONTEND column allowlist. It is not a
-- real security boundary: Postgres RLS (clients_select_portal_rls) only
-- restricts which ROWS a client-portal session can see (id = portal_client_id()),
-- it does not restrict which COLUMNS of that row can be read. Any
-- authenticated client-portal session could call the Supabase REST API
-- directly (bypassing the frontend entirely) with `select=*` and read every
-- column on their own client row, including commercially sensitive fields:
-- contract_value, due_value, remaining_value, renewal_value, profit_margin_pct,
-- churn_reason, churned_at, sales_brief, am_renewal_registered_by, etc.
--
-- FIX:
-- 1. Drop clients_select_portal_rls entirely, so a client-portal session can
--    no longer read public.clients directly at all (RLS defaults to deny ->
--    0 rows for any direct select, select=* included).
-- 2. Add a SECURITY DEFINER RPC, portal_get_client(), that internally reads
--    the row scoped to portal_client_id() and returns ONLY a fixed, safe
--    column list, hard-coded in the function body. The caller cannot widen
--    this by requesting more columns, because the function's return type is
--    fixed at creation time.
-- ============================================================================

drop policy if exists "clients_select_portal_rls" on public.clients;

create or replace function public.portal_get_client()
returns table (
  id text,
  name text,
  sector text,
  industry text,
  company text,
  client_contact_name text,
  phone_number text,
  website_or_social_link text,
  services text[],
  other_services text[],
  portal_slug text,
  start_date date,
  design_drive_link text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.id,
    c.name,
    c.sector,
    c.industry,
    c.company,
    c.client_contact_name,
    c.phone_number,
    c.website_or_social_link,
    c.services,
    c.other_services,
    c.portal_slug,
    c.start_date,
    c.design_drive_link
  from public.clients c
  where c.id = public.portal_client_id();
$$;

grant execute on function public.portal_get_client() to authenticated;
