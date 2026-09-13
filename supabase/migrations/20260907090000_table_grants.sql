-- ============================================================================
-- Base table grants for all 16 application tables
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- --------------------------
-- 20260906120000_rls_policies.sql enabled Row Level Security and added
-- per-role policies on all 16 tables, on the assumption (stated in that
-- file's header) that `authenticated`/`anon` already held the standard
-- Supabase default table-level grants (SELECT/INSERT/UPDATE/DELETE), and
-- that RLS would only need to narrow that down further per row.
--
-- That assumption was wrong for this project. Checked directly via the SQL
-- Editor:
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon','authenticated');
-- `anon`/`authenticated` only hold TRUNCATE, TRIGGER, and REFERENCES on
-- these tables — never SELECT, INSERT, UPDATE, or DELETE. In Postgres, the
-- GRANT system and Row Level Security are two independent layers: GRANT is
-- checked FIRST, before any RLS policy is ever evaluated. With no base
-- GRANT, every request is rejected outright ("permission denied for table
-- X" / HTTP 401 via PostgREST) regardless of how correct the RLS policies
-- or the Authorization header are — which is exactly the 401s seen on
-- users/packages/briefs/daily_logs/extra_notes/assignments, and would be
-- true of the other 10 tables too once anything actually queries them.
--
-- This migration is the missing piece: it grants each table exactly the
-- operations the app's code actually performs against it (verified against
-- every `supabase.from(...)` call site in src/App.tsx), no more. RLS policies
-- from the other migration then narrow each grant down per row/role — GRANT
-- and RLS are additive restrictions, not alternatives; both are required.
--
-- WHY `authenticated` ONLY, NOT `anon`
-- --------------------------------------
-- Every policy in 20260906120000_rls_policies.sql is scoped `to authenticated`.
-- The app's "Demo Accounts" picker (VITE_ENABLE_DEMO_LOGIN) never calls
-- supabase.auth.signInWithPassword, so it never holds a real Supabase Auth
-- session — at the database level, its requests carry no valid JWT and are
-- evaluated as the `anon` role, not `authenticated`. Granting `anon` access
-- here would be pointless (no policy is scoped to `anon`, so it couldn't see
-- any rows anyway) and, if the RLS migration hasn't been applied yet in some
-- environment, actively dangerous (unrestricted anonymous access to every
-- row). So: only `authenticated` gets grants. Practically, this means demo
-- accounts keep working exactly as before — every live fetch in App.tsx
-- already treats an empty/errored response as "keep the current in-memory
-- data" (see e.g. `if (!err && data && data.length > 0) setX(data)`), so a
-- demo session will silently continue running on local seed data. Only a
-- real, signed-in session gets live Supabase data, filtered by RLS.
--
-- NOTHING here grants DELETE on any table: verified via search that the app
-- never issues a DELETE against any of these 16 tables. Admin/back-office
-- deletes remain possible via the Supabase service-role key, which bypasses
-- GRANT and RLS entirely.
-- ============================================================================

begin;

-- 1. users
-- SELECT only. UPDATE is deliberately NOT granted here: the RLS policies
-- migration already grants a column-scoped UPDATE (capacity_limit only) via
--   revoke update on public.users from authenticated;
--   grant update (capacity_limit) on public.users to authenticated;
-- Adding a broad `grant update on public.users` here would silently widen
-- that back to every column. If you haven't run that migration yet, run it
-- too — this file and that one are companions; both are needed together.
grant select on public.users to authenticated;

-- 2. packages — read-only reference data, the app never writes to it.
grant select on public.packages to authenticated;

-- 3. clients — app registers new clients (Sales) and updates am_agent_id
-- (AM assignment). No delete.
grant select, insert, update on public.clients to authenticated;

-- 4. briefs — service teams submit/update briefs. No delete.
grant select, insert, update on public.briefs to authenticated;

-- 5. assignments — service team leads create/reassign agent assignments.
-- No delete.
grant select, insert, update on public.assignments to authenticated;

-- 6. tasks — any operational employee can create tasks and move/edit them
-- on the shared task board. No delete.
grant select, insert, update on public.tasks to authenticated;

-- 7. campaigns — Media Buying creates campaigns; Media Buying/AM roles with
-- edit rights update them. No delete.
grant select, insert, update on public.campaigns to authenticated;

-- 8. social_insights — read-only from the app (populated by an external
-- platform-metrics integration via the service-role key, not the browser).
grant select on public.social_insights to authenticated;

-- 9. reports — read-only from the app; same as social_insights.
grant select on public.reports to authenticated;

-- 10. capacity_logs — append-only: the app only ever inserts new capacity
-- readings, never updates or deletes existing ones.
grant select, insert on public.capacity_logs to authenticated;

-- 11. daily_logs — append-only personal activity logs.
grant select, insert on public.daily_logs to authenticated;

-- 12. extra_notes — append-only personal notes.
grant select, insert on public.extra_notes to authenticated;

-- 13. performance_reviews — read-only from the app; no authoring UI exists
-- yet (see the RLS migration's note on this table).
grant select on public.performance_reviews to authenticated;

-- 14. meetings — read-only from the app.
grant select on public.meetings to authenticated;

-- 15. kpi_scores — read-only from the app.
grant select on public.kpi_scores to authenticated;

-- 16. client_comparisons — read-only from the app.
grant select on public.client_comparisons to authenticated;

commit;
