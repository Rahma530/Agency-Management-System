-- ============================================================================
-- Module 14: phone_number field on clients.
-- ============================================================================
--
-- A plain nullable text column, no format/constraint enforcement (client
-- phone numbers here span multiple countries and formats, same posture as
-- every other free-text contact field in this schema). No backfill — starts
-- empty for every existing row, filled in going forward via
-- ClientRegistrationModal or (later) the bulk-upload template. Fully
-- independent of the package_id -> services migration; no RLS changes
-- needed since it's just another column on the already-covered clients
-- table (existing clients_select/clients_update policies apply as-is).
-- ============================================================================

begin;

alter table public.clients add column if not exists phone_number text;

commit;
