-- Fix: live-tested failure — the employee-impersonation Edge Function's insert into
-- impersonation_sessions (using the service-role client) failed with:
--   permission denied for table impersonation_sessions (SQLSTATE 42501)
-- service_role has BYPASSRLS, but that only bypasses row-level security — it does not grant
-- table-level privileges, and this project's setup does not auto-grant service_role on newly
-- created tables the way authenticated/anon get explicit grants throughout this repo's own
-- migrations. impersonation_sessions was created (20261021000000) without one, so the very first
-- real insert against it failed.
--
-- Only INSERT is needed: the Edge Function (supabase/functions/employee-impersonation/index.ts)
-- performs exactly one operation on this table via its service-role client — the insert that
-- starts a session. The "close own row" exit path (App.tsx's handleExitImpersonation) and the
-- admin's own audit-history read both go through the browser's client, authenticated with the
-- anon key under the user's real session — never service_role — so they're already covered by
-- impersonation_sessions_select_rls / impersonation_sessions_close_rls and the existing
-- column-level grants to authenticated. No SELECT or UPDATE grant to service_role is added here,
-- since nothing in the codebase performs either as service_role against this table.
begin;

grant insert on public.impersonation_sessions to service_role;

commit;
