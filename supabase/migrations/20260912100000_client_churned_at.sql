-- ============================================================================
-- Dashboards (Module 5): a genuinely period-scoped churn rate needs to know
-- *when* a client churned, not just that it eventually did. clients.status
-- flipping to 'churned' was never timestamped separately from created_at, so
-- there was no way to answer "who churned in Q2" from existing columns.
-- ============================================================================
--
-- Adds clients.churned_at (nullable timestamptz), set by the app the moment
-- handleUpdateClientStatus transitions a client to 'churned' (src/App.tsx).
-- Not retroactive: any client already churned before this column existed has
-- churned_at = NULL and stays that way forever (there's no reliable date to
-- backfill it from) — DepartmentComparisonPanel/ExecutiveDashboard treat a
-- NULL churned_at on a churned client as "predates tracking", not as "not
-- churned" or "churned today".
--
-- No RLS/grant changes: clients already has a blanket
-- `grant select, insert, update on public.clients to authenticated` (no
-- column-level restriction, unlike users.capacity_limit), and the existing
-- clients_update_am_assignment_rls policy is already the sole gate on every
-- clients UPDATE — including the status-transition writes this column rides
-- along with. A new column on an already-permitted row needs nothing further.
-- ============================================================================

begin;

alter table public.clients
  add column if not exists churned_at timestamptz;

commit;
