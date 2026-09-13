-- ============================================================================
-- Module 12, Phase 7: AM Team Lead payment-tracking fields on clients.
-- ============================================================================
--
-- due_value/remaining_value/contract_duration_months are manually-editable
-- bookkeeping fields distinct from contract_value: contract_value is the
-- Sales-set monthly retainer figure (set once at registration, never edited
-- after), while these track the actual payment schedule against a signed
-- contract's total value over its lifetime — an AM Team Lead concern, not
-- Sales's.
--
-- No RLS change needed: clients_update_am_assignment_rls already grants
-- UPDATE on the whole clients row to executive/head_of_technical/
-- am_team_lead (plus the client's own Sales owner) — this schema has no
-- column-level RLS anywhere, so a new column rides the same policy as
-- every other one on this table.
-- ============================================================================

begin;

alter table public.clients
  add column if not exists due_value numeric,
  add column if not exists remaining_value numeric,
  add column if not exists contract_duration_months integer;

commit;
