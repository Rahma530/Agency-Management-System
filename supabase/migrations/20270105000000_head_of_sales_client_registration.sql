-- Follow-up to 20270104000000_head_of_sales_role.sql (owner's explicit request, same day): widens
-- head_of_sales's scope to also register new clients exactly like `sales` does — a brand new
-- policy mirroring clients_insert_sales_rls (20260928100000_canonical_schema_v4.sql, unchanged by
-- this migration) verbatim for the new role, rather than editing that policy: each registering
-- role gets its own dedicated insert policy in this schema (clients_insert_sales_rls,
-- clients_insert_am_rls, clients_insert_leadership_rls all already follow this pattern), and
-- Postgres OR's every permissive policy together, so adding a new one changes nothing for `sales`.
--
-- No frontend logic change was needed for the insert payload itself: App.tsx's
-- handleRegisterClient/handleBulkAddClient already treat any role that is neither
-- AM (am_team_lead/am_agent) nor management (executive/head_of_technical/am_team_lead) as
-- "sales-shaped" — sales_owner_id = the submitting user, status starts at 'onboarding' — and
-- head_of_sales falls into that same branch automatically. Without this migration, the Register/
-- Bulk Upload buttons would be visible (lib/permissions.ts's CLIENT_REGISTRATION_ROLES already
-- includes head_of_sales) but every actual insert would be rejected by RLS.
--
-- Note: this does NOT grant any edit/update rights over a client after registration (the owner's
-- request was specifically "register clients like a normal Sales rep", not full Sales parity) —
-- clients_update_am_assignment_rls and lib/permissions.ts's canEditClient are both untouched, so a
-- client head_of_sales registers can only be edited afterward by AM/leadership, same as it would
-- be for anyone else once handed off.

begin;

create policy "clients_insert_head_of_sales_rls" on public.clients
for insert to authenticated
with check (
  public.app_user_role() = 'head_of_sales'
  and sales_owner_id = public.app_user_id()
);

commit;
