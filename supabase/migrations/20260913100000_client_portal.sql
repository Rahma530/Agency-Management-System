-- ============================================================================
-- Module 8: Client Portal — a genuinely new principal type (external clients),
-- parallel to the employee identity model in public.users, not an extension
-- of it. See the design discussion this migration implements:
--   - client_portal_users: the client-side analog of public.users. One row
--     per client login, auth_id nullable until claimed (invite-then-claim —
--     this app's browser client has no service-role key and cannot create
--     another user's Supabase Auth account, so a login starts as a
--     staff-created placeholder and is claimed by the client's own signUp).
--   - portal_client_id(): the client-portal analog of app_user_id().
--   - portal_am_agent_name(): a narrow, single-column function so a client
--     can see their assigned AM's name without any SELECT access to
--     public.users at all — not even their own AM's full row, let alone
--     anyone else's.
--   - clients.portal_slug: a dedicated, rotatable URL identifier — not the
--     client's internal id, so a leaked/rotated link never touches the
--     client's actual primary key or anything referencing it.
--
-- Every new SELECT policy below is ADDITIVE: Postgres OR's multiple
-- permissive policies for the same command together automatically, so none
-- of the existing employee-facing policies from prior phases change at all.
-- A client-portal session has no public.users row, so app_user_role() and
-- app_user_id() are both NULL for it — every existing employee policy's
-- `role() in (...)` check already evaluates false for such a session, which
-- is why this is safe to layer on rather than something that could
-- accidentally widen employee-side access.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. clients.portal_slug
-- ----------------------------------------------------------------------------
alter table public.clients
  add column if not exists portal_slug text;

create unique index if not exists idx_clients_portal_slug on public.clients (portal_slug) where portal_slug is not null;

-- ----------------------------------------------------------------------------
-- 2. client_portal_users
-- ----------------------------------------------------------------------------
create table if not exists public.client_portal_users (
  id text primary key,
  client_id text not null references public.clients (id),
  auth_id uuid unique references auth.users (id),
  email text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_client_portal_users_client_id on public.client_portal_users (client_id);
create unique index if not exists idx_client_portal_users_email on public.client_portal_users (lower(email));

alter table public.client_portal_users enable row level security;

grant select, insert, update on public.client_portal_users to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Helper functions
-- ----------------------------------------------------------------------------

-- The calling client-portal session's own client_id, resolved from their
-- Supabase Auth session. Null for anon/employee/unclaimed sessions, which
-- safely makes every `= public.portal_client_id()` comparison below false.
create or replace function public.portal_client_id()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select client_id from public.client_portal_users where auth_id = auth.uid();
$$;

-- Single-column, session-derived — deliberately not a general "read a
-- client's assigned AM" function. Returns null if the caller isn't a
-- client-portal session, or their client has no am_agent_id set.
create or replace function public.portal_am_agent_name()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.name
  from public.clients c
  join public.users u on u.id = c.am_agent_id
  where c.id = public.portal_client_id();
$$;

-- ----------------------------------------------------------------------------
-- 4. client_portal_users policies
-- ----------------------------------------------------------------------------

-- A claimed session reads its own row (the app needs this to resolve
-- client_id/email after login); an unclaimed session can't yet (auth_id is
-- still null, nothing to match against auth.uid()) — that lookup instead
-- goes through the claim flow below, keyed by email, not by reading rows.
create policy "client_portal_users_select_self_rls" on public.client_portal_users
for select
to authenticated
using (auth_id = auth.uid());

-- Staff creates the placeholder invite row. Same audience as reports/
-- client_comparisons insert from prior phases: executive, head_of_technical,
-- am_team_lead, or the client's own assigned am_agent.
create policy "client_portal_users_insert_staff_rls" on public.client_portal_users
for insert
to authenticated
with check (
  auth_id is null
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  )
);

-- The claim: a freshly-signed-up client links their new auth.uid() to the
-- one pre-provisioned row matching their own session email — never anyone
-- else's, and never a row that's already been claimed.
create policy "client_portal_users_claim_rls" on public.client_portal_users
for update
to authenticated
using (auth_id is null and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
with check (auth_id = auth.uid() and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Staff needs to see whether a client already has a portal login (and its
-- pending/active state) to render the AM-side status card — same audience as
-- the insert policy above, and the same predicate as reports_select_rls
-- (20260906120000) for this exact role set.
create policy "client_portal_users_select_staff_rls" on public.client_portal_users
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

-- ----------------------------------------------------------------------------
-- 5. Client-scoped read policies on existing tables
-- ----------------------------------------------------------------------------

create policy "clients_select_portal_rls" on public.clients
for select
to authenticated
using (id = public.portal_client_id());

-- Package definitions aren't sensitive — every employee can already read all
-- of them (packages_select_all_employees, 20260906120000); widening that
-- same policy to also admit a portal session is simpler than a parallel one.
drop policy if exists "packages_select_all_employees" on public.packages;
create policy "packages_select_all_employees" on public.packages
for select
to authenticated
using (public.app_user_role() is not null or public.portal_client_id() is not null);

create policy "briefs_select_portal_rls" on public.briefs
for select
to authenticated
using (client_id = public.portal_client_id());

create policy "client_comparisons_select_portal_rls" on public.client_comparisons
for select
to authenticated
using (client_id = public.portal_client_id());

-- type = 'client' only — 'internal' reports are staff-facing regardless of
-- whose client_id they carry.
create policy "reports_select_portal_rls" on public.reports
for select
to authenticated
using (client_id = public.portal_client_id() and type = 'client');

commit;
