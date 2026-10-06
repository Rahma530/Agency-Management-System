-- Adds public.clients.other_services (free-text/non-core service entries, see
-- src/lib/clientServices.ts's getClientServices()/getClientCustomServices()/splitClientServices(),
-- added as type-only infrastructure by the previous client-services-helper change) and
-- public.clients.sales_brief (replacing the never-fully-wired `notes` column with the same
-- free-text-at-registration, same-visibility-gate field under its real name). Does NOT touch
-- 20261030500000_protect_client_access_columns.sql — that migration is already applied; this is a
-- new, separate migration that layers on top of its column-level grant.
--
-- Storage split this migration's own check constraint (item 4) enforces, already implemented by
-- the frontend's splitClientServices() (src/lib/clientServices.ts) at every write path
-- (ClientRegistrationModal, BulkClientUploadModal): `services` only ever holds seo/social_media/
-- media_buying; interface/creation/branding and any genuinely free-text entry go in
-- `other_services`. "شاملة" expands to seo+social_media+media_buying in `services` plus interface
-- in `other_services`. clients_services_check and the briefs constraints are untouched — they
-- still technically permit interface/creation/branding inside `services` at the database layer
-- (unneeded to narrow, since every real write path now routes those values into `other_services`
-- instead) — so no existing row or RLS predicate referencing those constraints is affected.
--
-- What this migration does, in order:
-- 1. Three column changes on public.clients:
--    - other_services text[] not null default '{}': parallel to `services`, free-form.
--    - sales_brief text: `notes`'s replacement, same column type, same purpose, real name.
--    - drop column notes: the live database never actually had this column (see note below) — its
--      own migration (20261015100000_client_notes.sql) was never applied, and the prior
--      20261030500000_protect_client_access_columns.sql only added it defensively, immediately
--      before granting select on it, to avoid failing on a database state where it also didn't
--      exist. Both migrations have landed by the time this one runs, so the column the drop
--      targets here is always the one 20261030500000 itself just added (or a no-op on any database
--      where 20261015100000 DID also apply) — this drop can never target data nothing produced.
-- 2. Column-level SELECT grant replaces the one 20261030500000_protect_client_access_columns.sql
--    put in place: the same 25 non-sensitive columns from that migration, with `notes` replaced by
--    `sales_brief`, plus the new `other_services` — 26 total. The 10 Client Access columns
--    (general_email, general_email_password, store_platform_username, store_platform_password,
--    social_media_username, social_media_password, ad_account_username, ad_account_password,
--    ad_account_setup_type, payment_card_details) are still never named, so they remain
--    unreadable by `authenticated` exactly as that migration left them. insert/update table-level
--    grants are untouched (`grant select (...)` only ever narrows SELECT; it cannot and does not
--    touch INSERT/UPDATE, which stay table-level from 20260907090000_table_grants.sql).
-- 3. public.client_has_service(p_client_id, p_service) redefined, same signature/language/
--    stable/security definer/search_path public.client_has_service has always had (originally
--    20260926100000_canonical_schema_v3.sql, last redefined by 20260928100000_canonical_schema_v4.sql)
--    — every ~32 RLS policy and predicate that already calls it by name keeps working unchanged.
--    Body now also matches `other_services`, so a client whose only connection to a service is
--    through a free-text/non-core entry (e.g. 'interface') is still correctly recognized by every
--    caller of this function (brief-visibility RLS, department routing, etc.) without those
--    callers needing to know this column exists at all. EXECUTE is re-granted explicitly:
--    confirmed via audit that client_has_service has never had an explicit grant statement in its
--    own migration history, and 20261030300000_revoke_excess_privileges.sql's blanket
--    `alter default privileges ... revoke execute on functions from public, anon` only applies to
--    functions created AFTER that migration ran — client_has_service predates it, so it has
--    carried Postgres's original PUBLIC-on-creation default execute grant (meaning anon could
--    already call it) completely unexamined until now. This redefinition is this schema's first
--    chance to close that gap, the same way 20261030300000 already did for chat_directory()/
--    assignable_employees(text).
-- 4. clients_services_other_services_disjoint_check: `not (services && other_services)` (array
--    overlap operator) — belt-and-suspenders on top of splitClientServices() already making this
--    structurally impossible from every real write path (services and other_services are built
--    from entirely disjoint value sets, by construction, every time). Added only if not already
--    present, so re-running this migration is a no-op.
-- 5. (This comment block) — per 20261030500000_protect_client_access_columns.sql's own closing
--    note, any new public.clients column still needs an explicit SELECT grant added by hand (no
--    "grant everything except" shorthand exists in Postgres) or it is simply unreadable by
--    `authenticated`, fails closed. The live database never had a `notes` column before this
--    change set (20261015100000_client_notes.sql was defined but never applied) — dropping it here
--    is a no-op on that database, not a destructive change to real data.
begin;

-- 1. Column changes.
alter table public.clients
  add column if not exists other_services text[] not null default '{}',
  add column if not exists sales_brief text,
  drop column if exists notes;

-- 2. Column-level SELECT grant: the 25 columns from 20261030500000, `notes` replaced by
-- `sales_brief`, plus `other_services` — 26 total. The 10 Client Access columns are still never
-- named here.
revoke select on public.clients from authenticated;
grant select (
  id, name, sector, industry, client_contact_name, phone_number, website_or_social_link,
  services, other_services, status, sales_owner_id, am_agent_id, am_team_lead_id, contract_value,
  start_date, renewal_date, am_team_lead_viewed_at, churn_reason, churned_at, portal_slug,
  due_value, remaining_value, contract_duration_months, sales_brief, am_agent_assigned_at,
  created_at
) on public.clients to authenticated;

-- 3. client_has_service(): now also matches other_services, so free-text/non-core service entries
-- (interface/creation/branding, or genuinely custom text) are recognized the same way a core
-- `services` entry already is, by every RLS policy/predicate that calls this function by name.
create or replace function public.client_has_service(p_client_id text, p_service text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.clients c
    where c.id = p_client_id
      and (p_service = any(c.services) or p_service = any(c.other_services))
  );
$$;

revoke execute on function public.client_has_service(text, text) from public, anon;
grant execute on function public.client_has_service(text, text) to authenticated, service_role;

-- 4. Disjointness guard: belt-and-suspenders on top of the frontend's splitClientServices(),
-- which already makes this structurally impossible by construction. Added only if not already
-- present, so this migration stays safely re-runnable.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.clients'::regclass
      and conname = 'clients_services_other_services_disjoint_check'
  ) then
    alter table public.clients add constraint clients_services_other_services_disjoint_check
      check (not (services && other_services));
  end if;
end $$;

commit;
