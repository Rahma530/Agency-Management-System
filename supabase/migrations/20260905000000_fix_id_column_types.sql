-- ============================================================================
-- Fix id / foreign-key column types: uuid -> text
-- (and drop AI Studio's pre-existing RLS policies that block the ALTER)
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- --------------------------
-- Confirmed directly against the live database: every id and foreign-key
-- column across all 16 tables is `uuid`, not `text` as every migration in
-- this repo (20260906120000_rls_policies.sql, 20260907090000_table_grants.sql,
-- 20260908000000_brief_revisions.sql) has assumed from the start. Those base
-- tables were never created by anything tracked in this repo's migration
-- history -- most likely by Google AI Studio's own "Connect to Supabase"
-- auto-schema-generation step, which defaults new primary keys to
-- `uuid default gen_random_uuid()`, run directly against the project
-- independent of and prior to any file here.
--
-- The app itself has never used database-generated uuids: every insert
-- across src/App.tsx supplies its own human-readable string id
-- (`` `cl-${Date.now()...}` ``, hardcoded seed ids like "usr-am-lead" in
-- src/data/initialData.ts, etc.), and every query filters on those same
-- string ids. Confirmed via direct query that all 16 tables are currently
-- empty in the live database, so this is a pure schema correction -- no
-- data to preserve or cast, and no application code changes needed.
--
-- This migration must run BEFORE the three migrations named above (hence
-- the earlier timestamp): their RLS policies compare these columns against
-- text-returning helper functions (app_user_id(), etc.), which would fail
-- to even CREATE against uuid-typed columns.
--
-- users.auth_id is explicitly excluded and left untouched: it is Supabase
-- Auth's own foreign key into auth.users(id), which always holds real
-- Supabase-generated uuids -- that is correct as-is and is not part of the
-- app's own id scheme (users.id, the app's internal primary key, is a
-- separate column). users_auth_id_fkey is therefore never dropped.
--
-- Foreign key constraints below (confirmed against the live database via
-- pg_constraint) are dropped before the type changes and re-added
-- afterward with identical names and directions, now text-to-text. One
-- app-level FK-shaped column, clients.am_team_lead_id, has no live
-- constraint to drop/re-add (confirmed absent from the live constraint
-- list) -- its type is still converted below, just without a matching
-- constraint step. Same for daily_logs.linked_task_ids (an array of task
-- ids -- Postgres foreign keys don't apply to array columns).
--
-- ALSO DISCOVERED: these 16 tables already carry RLS policies from AI
-- Studio's original schema-generation step (independent of and predating
-- anything in this repo, same origin as the uuid columns above) --
-- Postgres refuses ALTER COLUMN TYPE while any policy's USING/WITH CHECK
-- expression references that column, regardless of the policy's command
-- type (SELECT/INSERT/UPDATE all block it equally). Confirmed live, for
-- reference/audit -- not relied on for correctness, see below:
--   assignments: assignments_select_by_role, assignments_update_leads_only, assignments_write_leads_only
--   briefs: briefs_insert_am_agent, briefs_select_by_role
--   campaigns: campaigns_select_by_assignment, campaigns_update_media_team, campaigns_write_media_team
--   capacity_logs: capacity_logs_insert_self_or_admin, capacity_logs_select_self_or_management
--   client_comparisons: client_comparisons_select_by_assignment, client_comparisons_write_admin_only
--   clients: clients_insert_sales_only, clients_select_by_role, clients_update_owner_or_admin
--   daily_logs: daily_logs_insert_self_only, daily_logs_select_self_or_lead
--   extra_notes: extra_notes_insert_self_only, extra_notes_select_self_or_lead
--   kpi_scores: kpi_scores_select_self_or_reviewer, kpi_scores_write_leads_only
--   meetings: meetings_insert_am_and_admin, meetings_select_by_role
--   performance_reviews: performance_reviews_write_leads_only (unconfirmed whether a
--     SELECT policy also exists -- irrelevant to this migration, see below)
--   reports: reports_select_by_role, reports_write_am_and_admin
--   social_insights: social_insights_select_by_assignment, social_insights_update_social_team, social_insights_write_social_team
--   tasks: tasks_insert_leads_and_agents, tasks_select_by_role, tasks_update_owner_or_lead
--   users: users_insert_admin_only, users_select_self_or_management, users_update_self_or_admin
-- Rather than drop these by the exact names above (which risks the exact
-- gap noted for performance_reviews -- an unlisted policy would still
-- block its column's ALTER), step 1 below dynamically discovers and drops
-- EVERY policy on these 16 tables directly from pg_policies, so
-- completeness of the list above never matters. None of these old
-- policies are recreated -- they're fully superseded by the policies
-- 20260906120000_rls_policies.sql creates immediately after this
-- migration runs.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Drop every existing RLS policy on these 16 tables, whatever it's
--    named -- see header. Not recreated here; superseded by
--    20260906120000_rls_policies.sql, which runs immediately after.
-- ----------------------------------------------------------------------------
do $$
declare
  pol record;
begin
  for pol in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'users', 'packages', 'clients', 'briefs', 'assignments', 'tasks',
        'campaigns', 'social_insights', 'reports', 'capacity_logs',
        'daily_logs', 'extra_notes', 'performance_reviews', 'meetings',
        'kpi_scores', 'client_comparisons'
      )
  loop
    execute format('drop policy if exists %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Drop foreign key constraints (users_auth_id_fkey excluded -- untouched)
-- ----------------------------------------------------------------------------
alter table public.assignments drop constraint if exists assignments_agent_id_fkey;
alter table public.assignments drop constraint if exists assignments_client_id_fkey;
alter table public.assignments drop constraint if exists assignments_team_lead_id_fkey;
alter table public.briefs drop constraint if exists briefs_client_id_fkey;
alter table public.briefs drop constraint if exists briefs_submitted_by_fkey;
alter table public.campaigns drop constraint if exists campaigns_client_id_fkey;
alter table public.capacity_logs drop constraint if exists capacity_logs_agent_id_fkey;
alter table public.client_comparisons drop constraint if exists client_comparisons_client_id_fkey;
alter table public.clients drop constraint if exists clients_am_agent_id_fkey;
alter table public.clients drop constraint if exists clients_package_id_fkey;
alter table public.clients drop constraint if exists clients_sales_owner_id_fkey;
alter table public.daily_logs drop constraint if exists daily_logs_user_id_fkey;
alter table public.extra_notes drop constraint if exists extra_notes_user_id_fkey;
alter table public.kpi_scores drop constraint if exists kpi_scores_reviewed_by_fkey;
alter table public.kpi_scores drop constraint if exists kpi_scores_user_id_fkey;
alter table public.meetings drop constraint if exists meetings_am_agent_id_fkey;
alter table public.meetings drop constraint if exists meetings_client_id_fkey;
alter table public.performance_reviews drop constraint if exists performance_reviews_reviewed_by_fkey;
alter table public.performance_reviews drop constraint if exists performance_reviews_user_id_fkey;
alter table public.reports drop constraint if exists reports_client_id_fkey;
alter table public.reports drop constraint if exists reports_generated_by_fkey;
alter table public.social_insights drop constraint if exists social_insights_client_id_fkey;
alter table public.tasks drop constraint if exists tasks_assigned_to_fkey;
alter table public.tasks drop constraint if exists tasks_client_id_fkey;
alter table public.tasks drop constraint if exists tasks_created_by_fkey;
alter table public.users drop constraint if exists users_manager_id_fkey;

-- ----------------------------------------------------------------------------
-- 3. Primary keys: drop the gen_random_uuid() default (the app always
--    supplies its own id, never relies on server-side generation), then
--    convert uuid -> text. A USING clause is included explicitly on every
--    ALTER below even though all tables are confirmed empty, so the cast
--    path is always explicit rather than left to Postgres's own implicit-
--    cast resolution.
-- ----------------------------------------------------------------------------
alter table public.users alter column id drop default;
alter table public.users alter column id type text using id::text;

alter table public.packages alter column id drop default;
alter table public.packages alter column id type text using id::text;

alter table public.clients alter column id drop default;
alter table public.clients alter column id type text using id::text;

alter table public.briefs alter column id drop default;
alter table public.briefs alter column id type text using id::text;

alter table public.assignments alter column id drop default;
alter table public.assignments alter column id type text using id::text;

alter table public.tasks alter column id drop default;
alter table public.tasks alter column id type text using id::text;

alter table public.campaigns alter column id drop default;
alter table public.campaigns alter column id type text using id::text;

alter table public.social_insights alter column id drop default;
alter table public.social_insights alter column id type text using id::text;

alter table public.reports alter column id drop default;
alter table public.reports alter column id type text using id::text;

alter table public.capacity_logs alter column id drop default;
alter table public.capacity_logs alter column id type text using id::text;

alter table public.daily_logs alter column id drop default;
alter table public.daily_logs alter column id type text using id::text;

alter table public.extra_notes alter column id drop default;
alter table public.extra_notes alter column id type text using id::text;

alter table public.performance_reviews alter column id drop default;
alter table public.performance_reviews alter column id type text using id::text;

alter table public.meetings alter column id drop default;
alter table public.meetings alter column id type text using id::text;

alter table public.kpi_scores alter column id drop default;
alter table public.kpi_scores alter column id type text using id::text;

alter table public.client_comparisons alter column id drop default;
alter table public.client_comparisons alter column id type text using id::text;

-- ----------------------------------------------------------------------------
-- 4. Foreign-key-shaped columns: uuid -> text (auth_id excluded, see header)
-- ----------------------------------------------------------------------------
alter table public.users alter column manager_id type text using manager_id::text;

alter table public.clients alter column sales_owner_id type text using sales_owner_id::text;
alter table public.clients alter column am_agent_id type text using am_agent_id::text;
alter table public.clients alter column am_team_lead_id type text using am_team_lead_id::text;
alter table public.clients alter column package_id type text using package_id::text;

alter table public.briefs alter column client_id type text using client_id::text;
alter table public.briefs alter column submitted_by type text using submitted_by::text;

alter table public.assignments alter column client_id type text using client_id::text;
alter table public.assignments alter column team_lead_id type text using team_lead_id::text;
alter table public.assignments alter column agent_id type text using agent_id::text;

alter table public.tasks alter column client_id type text using client_id::text;
alter table public.tasks alter column assigned_to type text using assigned_to::text;
alter table public.tasks alter column created_by type text using created_by::text;

alter table public.campaigns alter column client_id type text using client_id::text;
alter table public.campaigns alter column owner_id type text using owner_id::text;

alter table public.social_insights alter column client_id type text using client_id::text;

alter table public.reports alter column client_id type text using client_id::text;
alter table public.reports alter column generated_by type text using generated_by::text;

alter table public.capacity_logs alter column agent_id type text using agent_id::text;

alter table public.daily_logs alter column user_id type text using user_id::text;
alter table public.daily_logs alter column linked_task_ids type text[] using linked_task_ids::text[];

alter table public.extra_notes alter column user_id type text using user_id::text;

alter table public.performance_reviews alter column user_id type text using user_id::text;
alter table public.performance_reviews alter column reviewed_by type text using reviewed_by::text;

alter table public.meetings alter column client_id type text using client_id::text;
alter table public.meetings alter column am_agent_id type text using am_agent_id::text;

alter table public.kpi_scores alter column user_id type text using user_id::text;
alter table public.kpi_scores alter column reviewed_by type text using reviewed_by::text;

alter table public.client_comparisons alter column client_id type text using client_id::text;

-- ----------------------------------------------------------------------------
-- 5. Re-add foreign key constraints, identical names and directions,
--    now text -> text.
-- ----------------------------------------------------------------------------
alter table public.assignments add constraint assignments_agent_id_fkey foreign key (agent_id) references public.users (id);
alter table public.assignments add constraint assignments_client_id_fkey foreign key (client_id) references public.clients (id);
alter table public.assignments add constraint assignments_team_lead_id_fkey foreign key (team_lead_id) references public.users (id);
alter table public.briefs add constraint briefs_client_id_fkey foreign key (client_id) references public.clients (id);
alter table public.briefs add constraint briefs_submitted_by_fkey foreign key (submitted_by) references public.users (id);
alter table public.campaigns add constraint campaigns_client_id_fkey foreign key (client_id) references public.clients (id);
alter table public.capacity_logs add constraint capacity_logs_agent_id_fkey foreign key (agent_id) references public.users (id);
alter table public.client_comparisons add constraint client_comparisons_client_id_fkey foreign key (client_id) references public.clients (id);
alter table public.clients add constraint clients_am_agent_id_fkey foreign key (am_agent_id) references public.users (id);
alter table public.clients add constraint clients_package_id_fkey foreign key (package_id) references public.packages (id);
alter table public.clients add constraint clients_sales_owner_id_fkey foreign key (sales_owner_id) references public.users (id);
alter table public.daily_logs add constraint daily_logs_user_id_fkey foreign key (user_id) references public.users (id);
alter table public.extra_notes add constraint extra_notes_user_id_fkey foreign key (user_id) references public.users (id);
alter table public.kpi_scores add constraint kpi_scores_reviewed_by_fkey foreign key (reviewed_by) references public.users (id);
alter table public.kpi_scores add constraint kpi_scores_user_id_fkey foreign key (user_id) references public.users (id);
alter table public.meetings add constraint meetings_am_agent_id_fkey foreign key (am_agent_id) references public.users (id);
alter table public.meetings add constraint meetings_client_id_fkey foreign key (client_id) references public.clients (id);
alter table public.performance_reviews add constraint performance_reviews_reviewed_by_fkey foreign key (reviewed_by) references public.users (id);
alter table public.performance_reviews add constraint performance_reviews_user_id_fkey foreign key (user_id) references public.users (id);
alter table public.reports add constraint reports_client_id_fkey foreign key (client_id) references public.clients (id);
alter table public.reports add constraint reports_generated_by_fkey foreign key (generated_by) references public.users (id);
alter table public.social_insights add constraint social_insights_client_id_fkey foreign key (client_id) references public.clients (id);
alter table public.tasks add constraint tasks_assigned_to_fkey foreign key (assigned_to) references public.users (id);
alter table public.tasks add constraint tasks_client_id_fkey foreign key (client_id) references public.clients (id);
alter table public.tasks add constraint tasks_created_by_fkey foreign key (created_by) references public.users (id);
alter table public.users add constraint users_manager_id_fkey foreign key (manager_id) references public.users (id);

commit;
