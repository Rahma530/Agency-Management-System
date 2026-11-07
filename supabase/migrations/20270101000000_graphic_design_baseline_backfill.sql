-- Backfill: Graphic Design becomes a baseline service every client has (owner decision,
-- 2026-11-07), already resolved on the read side (src/lib/clientServices.ts's
-- getClientServices()) with no migration needed for most of the app — every screen that reads
-- "what services does this client have" (reports, Client Dashboard, Capacity, the Tasks brief
-- preview, etc.) already shows every client as having it, immediately, with zero backend change.
--
-- This migration exists only to close ONE remaining gap: the RLS policies added in
-- 20261217300000_graphic_design_service.sql for public.assignments (who can create/view a
-- graphic_design agent assignment for a given client) call
-- client_has_service(client_id, 'graphic_design'), which reads the ACTUAL stored
-- services/other_services columns directly in SQL — unaffected by any frontend-only change.
-- Without this backfill, an AM/team lead trying to assign a graphic designer to a pre-existing
-- client that never had 'graphic_design' explicitly in its other_services would still be blocked
-- by RLS, even though the rest of the app now shows that client as having the service everywhere
-- else.
--
-- One-time, idempotent (safe to run more than once): appends 'graphic_design' to other_services
-- for every client that doesn't already have it in either services or other_services. The
-- clients_services_other_services_disjoint_check constraint (added in
-- 20261030700000_client_other_services_sales_brief.sql) is respected by construction — this never
-- adds the value to other_services for a client where it's already (incorrectly) in services.
--
-- Going forward, every new/edited client already gets 'graphic_design' written out automatically
-- by splitClientServices() (src/lib/clientServices.ts) on every Register/Edit Client save — this
-- migration only catches up clients saved before that change shipped.
begin;

update public.clients
set other_services = array_append(coalesce(other_services, '{}'), 'graphic_design')
where not ('graphic_design' = any(coalesce(services, '{}')))
  and not ('graphic_design' = any(coalesce(other_services, '{}')));

commit;
