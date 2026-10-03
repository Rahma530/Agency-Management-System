-- Real-time delivery for public.users, additive only.
--
-- Confirmed root cause of a production data-integrity bug: EmployeeAdminHub's "Awaiting Setup"
-- view (and any other users-driven view) is populated once per admin session by App.tsx's
-- loadData(), which only re-runs when the viewing admin's OWN authenticatedUser.id changes
-- (login/logout). There was no postgres_changes subscription for `users` at all — the existing
-- `online-users` channel is an unrelated ephemeral Presence tracker that carries no column data —
-- so another employee completing their password setup (via either the admin-invitation link or
-- the separate self-service "Forgot Password" flow; both funnel through the same
-- handlePasswordRecoveryComplete path and update the same last_seen_at column) was invisible to an
-- already-open admin session until a manual page reload re-ran loadData().
--
-- Safe to add to the realtime publication as-is: Realtime enforces each subscriber's own RLS
-- SELECT policy per row before delivering a postgres_changes event, so a given employee only ever
-- receives a `users` row (and the full set of columns on it) that users_select_rls's
-- employee_visible() predicate would already let that same employee pull via a plain
-- `select('*')` today (exactly what App.tsx's loadData() already does). This adds a push channel
-- for data already exposed to that role, not a new exposure.
begin;

alter publication supabase_realtime add table public.users;

commit;
