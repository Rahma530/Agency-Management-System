-- ============================================================================
-- Row Level Security policies for all 16 application tables
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- --------------------------
-- Until now, access control for this app has been enforced entirely in the
-- browser: src/lib/supabase.ts wraps a handful of tables (users, clients,
-- campaigns, tasks) in a client-side Proxy that mimics RLS. That proxy can be
-- bypassed trivially by anyone with DevTools — window.supabase was exposed
-- globally for exactly this kind of testing, and it demonstrated that a
-- signed-in user can call `window.supabase.from('briefs').select('*')`
-- directly and get every row in the table, ignoring the app's UI-level
-- filtering entirely. `briefs` and `assignments` were NEVER wrapped by that
-- proxy at all, so today they are completely unfiltered for any signed-in
-- user. Real security has to live in Postgres, not in the client bundle.
--
-- This migration turns on Postgres RLS for all 16 tables and adds policies
-- that reproduce (and now actually enforce) the access rules already coded
-- in the front end:
--   - users / clients / campaigns / tasks:
--     mirrors isEmployeeAccessibleUnderRLS / isClientAccessibleUnderRLS /
--     isCampaignAccessibleUnderRLS / isTaskAccessibleUnderRLS and the insert/
--     update permission checks in src/lib/supabase.ts, using the CURRENT
--     strict client-assignment logic (no ownership/task fallback for
--     media_buying_agent or am_agent).
--   - briefs / assignments:
--     previously unprotected. Mirrors ServiceBriefsRoutingView.tsx's
--     authorizedClients logic: team leads see every client subscribed to
--     their service; agents see ONLY clients they are formally assigned to
--     via the assignments table (strict exclusivity, no ownership/task
--     fallback); AM roles get the cross-service view used by
--     AMServiceBriefsPanel (team lead = all clients, agent = clients where
--     clients.am_agent_id = them), and that AM view is read-only, matching
--     the "Read-only across all services" banner in that component.
--   - the remaining 10 tables (packages, social_insights, reports,
--     capacity_logs, daily_logs, extra_notes, performance_reviews,
--     meetings, kpi_scores, client_comparisons):
--     no client-side emulation exists for these today, so policies below are
--     inferred from data/roles.ts and from how the analogous tables above
--     are protected. Each policy's comment explains the reasoning.
--
-- SCHEMA ASSUMPTIONS — PLEASE VERIFY BEFORE RUNNING
-- ---------------------------------------------------
-- This app generates its own human-readable primary keys client-side
-- (e.g. "cl-101", "usr-am-lead", "tsk-0001" — see src/data/initialData.ts
-- and the `id: \`cl-${Date.now()...}\`` inserts in src/App.tsx), which only
-- works if every `id` column is TEXT, not uuid. This migration assumes:
--   * every table's `id` primary key is `text`
--   * every foreign-key-shaped column (client_id, user_id, agent_id,
--     am_agent_id, assigned_to, created_by, submitted_by, reviewed_by,
--     generated_by, sales_owner_id, team_lead_id, owner_id, package_id) is
--     also `text`, matching the `id` columns they reference
--   * `public.users.auth_id` is `uuid` and references `auth.users(id)`
--     (Supabase Auth user ids are always uuid; this is how
--     supabase.auth.signInWithPassword sessions map to app users today)
--   * `authenticated`/`anon` already hold the standard Supabase default
--     table-level grants (SELECT/INSERT/UPDATE/DELETE) — this migration
--     only narrows access further via RLS, except for `users` where it
--     explicitly revokes/re-grants column-level UPDATE (see step 1).
-- If your actual schema differs (e.g. real uuid primary keys), adjust the
-- `text` types below (mainly in the helper function signatures) accordingly.
--
-- No DELETE policy is created on any table: the app never issues a DELETE
-- against any of these 16 tables (verified by search), so under RLS with no
-- DELETE policy, deletes are simply denied for `authenticated` — which is
-- the correct, safe default. A service-role key (used by admin backends /
-- ETL, never the browser) bypasses RLS entirely, so administrative deletes
-- remain possible outside the app.
-- ============================================================================

begin;

-- ============================================================================
-- 0. Helper functions
-- ============================================================================
-- These resolve "who is making this request" once per policy check, and
-- encapsulate a couple of access rules that are reused across several tables
-- (organizational employee-visibility, and the client/service assignment
-- check). They are STABLE + SECURITY DEFINER: STABLE lets Postgres cache the
-- result within one statement instead of re-querying `users` per row, and
-- SECURITY DEFINER lets them read `public.users` without recursively
-- triggering that table's own RLS policy (a plain SELECT from inside a
-- policy on `users` would otherwise recurse into the same policy).
-- ============================================================================

-- The calling employee's own app-level id (public.users.id), resolved from
-- their Supabase Auth session. Null for anon / unrecognized sessions, which
-- safely makes every `= public.app_user_id()` comparison below false.
create or replace function public.app_user_id()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from public.users where auth_id = auth.uid();
$$;

-- The calling employee's role (public.users.role).
create or replace function public.app_user_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from public.users where auth_id = auth.uid();
$$;

-- The calling employee's team (public.users.team), used only by the
-- "same team as the assignee" fallback in the tasks policy below.
create or replace function public.app_user_team()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select team from public.users where auth_id = auth.uid();
$$;

-- Mirrors isEmployeeAccessibleUnderRLS() in src/lib/supabase.ts exactly:
--   1. Executives & Head of Technical: see everyone.
--   2. Everyone can always see their own record.
--   3. Graphic Designers & Video Editors are shared resources, visible to
--      every role EXCEPT Sales.
--   4. Team leads see their own team's leads + agents (role-based, not the
--      `team` column).
--   5. Agents see their own role's peers + their own team lead.
--   6. Sales is strictly isolated to other Sales employees.
--   7. Anything else (e.g. a viewer role this function doesn't recognize,
--      such as ai_engineer) sees only itself + the shared creative roles
--      via rule 3 — matching the TS function's final `return false`.
create or replace function public.employee_visible(target_id text, target_role text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
    or (target_role in ('graphic_designer', 'video_editor') and public.app_user_role() <> 'sales')
    or (public.app_user_role() = 'am_team_lead' and target_role in ('am_team_lead', 'am_agent'))
    or (public.app_user_role() = 'media_buying_team_lead' and target_role in ('media_buying_team_lead', 'media_buying_agent'))
    or (public.app_user_role() = 'seo_team_lead' and target_role in ('seo_team_lead', 'seo_agent'))
    or (public.app_user_role() = 'social_media_team_lead' and target_role in ('social_media_team_lead', 'social_media_agent'))
    or (public.app_user_role() = 'am_agent' and target_role in ('am_agent', 'am_team_lead'))
    or (public.app_user_role() = 'media_buying_agent' and target_role in ('media_buying_agent', 'media_buying_team_lead'))
    or (public.app_user_role() = 'seo_agent' and target_role in ('seo_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'social_media_agent' and target_role in ('social_media_agent', 'social_media_team_lead'))
    or (public.app_user_role() = 'sales' and target_role = 'sales');
$$;

-- Convenience wrapper around employee_visible() for tables that only store
-- a target user's id (capacity_logs.agent_id, daily_logs.user_id, etc.) and
-- not their role — looks the role up from `users` first.
create or replace function public.employee_visible_by_id(target_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.employee_visible(u.id, u.role) from public.users u where u.id = target_id;
$$;

-- True if the client's package includes the given service. Mirrors the
-- `hasService` check in ServiceBriefsRoutingView.tsx's authorizedClients
-- filter.
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
    join public.packages pkg on pkg.id = c.package_id
    where c.id = p_client_id
      and p_service = any(pkg.services)
  );
$$;

-- True if the caller has a formal assignments-table row for this client and
-- service. Mirrors the strict "assignment, not ownership/task" checks added
-- to isClientAccessibleUnderRLS / isCampaignAccessibleUnderRLS for
-- media_buying_agent, and reused here for seo_agent / social_media_agent.
create or replace function public.agent_assigned(p_client_id text, p_service text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.assignments a
    where a.client_id = p_client_id
      and a.service_type = p_service
      and a.agent_id = public.app_user_id()
  );
$$;

-- True if the caller has ANY assignments-table row for this client, in any
-- service. Deliberately looser than agent_assigned() above: used only for
-- brief READ visibility, where being formally assigned to a client for one
-- service is meant to unlock every service's brief for that same client
-- (see the briefs_select_rls policy). It must NOT be used for anything
-- that grants write access or client/campaign visibility — those stay
-- scoped to the specific service via agent_assigned().
create or replace function public.agent_assigned_any_service(p_client_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.assignments a
    where a.client_id = p_client_id
      and a.agent_id = public.app_user_id()
  );
$$;

-- True if the caller is the Account Manager on record for this client
-- (clients.am_agent_id). Mirrors the am_agent branch of
-- isClientAccessibleUnderRLS / isCampaignAccessibleUnderRLS, and the
-- AMServiceBriefsPanel agent filter (clients.filter(c => c.am_agent_id ===
-- currentUser.id)).
create or replace function public.client_am_agent_is_caller(p_client_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.am_agent_id = public.app_user_id()
  );
$$;

-- Mirrors isTaskAccessibleUnderRLS() in src/lib/supabase.ts exactly: Sales
-- has no access at all; Executive/Head of Technical and any *_team_lead
-- role see everything; otherwise the caller must be the assignee, or share
-- a `team` with the assignee.
create or replace function public.task_visible(p_assigned_to text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.app_user_role() <> 'sales'
    and (
      public.app_user_role() in (
        'executive', 'head_of_technical',
        'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
      )
      or p_assigned_to = public.app_user_id()
      or exists (
        select 1 from public.users u
        where u.id = p_assigned_to and u.team = public.app_user_team()
      )
    );
$$;

-- ============================================================================
-- 1. users
-- ============================================================================
alter table public.users enable row level security;

create policy "users_select_rls" on public.users
for select
to authenticated
using (public.employee_visible(id, role));

-- The only write the app ever makes to `users` is CapacityManagement.tsx
-- updating capacity_limit for an employee, gated to the same roles that
-- have canManageCapacity: true in data/roles.ts, and only for employees the
-- caller could already see (their own team, or everyone for exec/HoT).
create policy "users_update_capacity_rls" on public.users
for update
to authenticated
using (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
  and public.employee_visible(id, role)
)
with check (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
  and public.employee_visible(id, role)
);

-- RLS is row-level only — without this, the policy above would technically
-- let a capacity manager UPDATE any column on a visible employee's row
-- (role, email, manager_id, ...), not just capacity_limit. Column-level
-- grants are what actually narrow the UPDATE to the one field the UI edits.
revoke update on public.users from authenticated;
grant update (capacity_limit) on public.users to authenticated;

-- ============================================================================
-- 2. packages
-- ============================================================================
-- Service package definitions (name + which services it bundles). Not
-- client-specific and not sensitive — every module that shows a client's
-- subscribed services (ClientDashboard, ServiceBriefsRoutingView,
-- CampaignManagementModule, ...) needs to read this for any employee
-- regardless of role, so it's readable by any authenticated employee.
-- The app never writes to this table (it's reference data), so no
-- insert/update/delete policy is created — only a service-role key can
-- manage it.
alter table public.packages enable row level security;

create policy "packages_select_all_employees" on public.packages
for select
to authenticated
using (public.app_user_role() is not null);

-- ============================================================================
-- 3. clients
-- ============================================================================
alter table public.clients enable row level security;

-- Mirrors isClientAccessibleUnderRLS() in src/lib/supabase.ts exactly,
-- including its final fallback (any role not explicitly handled — i.e.
-- graphic_designer, video_editor, ai_engineer — can only see a client
-- through a task assigned to them for that client).
create policy "clients_select_rls" on public.clients
for select
to authenticated
using (
  case public.app_user_role()
    when 'sales' then sales_owner_id = public.app_user_id()
    when 'executive' then true
    when 'head_of_technical' then true
    when 'am_team_lead' then true
    when 'am_agent' then am_agent_id = public.app_user_id()
    when 'media_buying_team_lead' then true
    when 'media_buying_agent' then public.agent_assigned(id, 'media_buying')
    when 'seo_team_lead' then true
    when 'social_media_team_lead' then true
    when 'seo_agent' then (
      public.agent_assigned(id, 'seo')
      or exists (select 1 from public.tasks t where t.client_id = clients.id and t.assigned_to = public.app_user_id())
    )
    when 'social_media_agent' then (
      public.agent_assigned(id, 'social_media')
      or exists (select 1 from public.tasks t where t.client_id = clients.id and t.assigned_to = public.app_user_id())
    )
    else exists (select 1 from public.tasks t where t.client_id = clients.id and t.assigned_to = public.app_user_id())
  end
);

-- Client registration (handleRegisterClient in App.tsx) is Sales-only,
-- matching canRegisterClients: true, and always self-attributed.
create policy "clients_insert_sales_rls" on public.clients
for insert
to authenticated
with check (
  public.app_user_role() = 'sales'
  and sales_owner_id = public.app_user_id()
);

-- The only client update the app performs is handleAssignAMAgent setting
-- am_agent_id, gated to canAssignAM: true roles in data/roles.ts
-- (executive, head_of_technical, am_team_lead, and sales for their own
-- submitted clients).
create policy "clients_update_am_assignment_rls" on public.clients
for update
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'sales' and sales_owner_id = public.app_user_id())
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'sales' and sales_owner_id = public.app_user_id())
);

-- ============================================================================
-- 4. briefs  —  URGENT: previously had ZERO protection (unwrapped by the
--    client-side proxy, so every signed-in user could read every brief for
--    every client via a plain `.from('briefs').select('*')`).
-- ============================================================================
alter table public.briefs enable row level security;

-- Mirrors ServiceBriefsRoutingView.tsx's authorizedClients logic:
--   - AM Team Lead: every brief, any service (cross-service overview).
--   - AM Agent: every brief for clients where they are the AM
--     (clients.am_agent_id = them), any service — read-only (AM never
--     submits/edits a brief, only the owning service team does).
--   - Service Team Lead (SEO / Media Buying / Social Media): briefs for
--     their own service, for any client whose package includes it. Unlike
--     agents below, leads are NOT broadened to cross-service — a lead only
--     ever sees their own department's brief, for every client in it.
--   - Service Agent: once formally assigned to a client for ANY service
--     (an assignments row with agent_id = them, service_type doesn't have
--     to match the brief's), they can read that client's briefs for EVERY
--     service — SEO + Social Media + Media Buying — not just their own.
--     They still see zero briefs for a client they have no assignment for
--     at all, even if that client happens to use their department's
--     service (strict exclusivity is unchanged; only the service_type
--     match within an assigned client was too narrow). Note this is READ
--     visibility only — the write policy below still requires the
--     assignment's service_type to match the brief being submitted, since
--     an agent shouldn't be authoring a brief outside their own expertise.
--   - Executive / Head of Technical: full visibility. This isn't reachable
--     through the current UI (neither role has "service_briefs" in
--     allowedModules), but every other RLS function in this codebase grants
--     these two roles universal read access, so the same principle is
--     extended here for consistency and future reporting use — it doesn't
--     expose anything they can't already see via clients/campaigns.
--   - Graphic Designer / Video Editor: no team lead role exists for the
--     'creative' service_type in the current app, so as the narrowest
--     reasonable read, they can see a 'creative' brief only if they
--     personally submitted it.
create policy "briefs_select_rls" on public.briefs
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

-- Only the owning service team (lead or agent) may submit/update a brief for
-- their service — the same set of (role, client) pairs as the SELECT policy
-- above, minus the AM roles, since the AM panel is explicitly read-only
-- ("Read-only across all services — assignment stays with each service team
-- lead"). submitted_by must always be the caller.
create policy "briefs_write_rls" on public.briefs
for insert
to authenticated
with check (
  submitted_by = public.app_user_id()
  and (
    (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
    or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

create policy "briefs_update_rls" on public.briefs
for update
to authenticated
using (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
)
with check (
  submitted_by = public.app_user_id()
);

-- ============================================================================
-- 5. assignments  —  URGENT: same previously-unprotected gap as briefs.
-- ============================================================================
alter table public.assignments enable row level security;

-- Same authorizedClients-derived visibility as briefs, applied directly to
-- the assignment row instead of a joined client: team leads see every
-- assignment in their own service; agents see only their own assignment
-- row; AM roles see assignments (any service) for clients under their
-- management, since ClientDashboard's Briefs tab surfaces "who's assigned"
-- across all services for the AM's clients.
create policy "assignments_select_rls" on public.assignments
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and agent_id = public.app_user_id())
);

-- Only a service's own team lead may create or reassign that service's
-- assignments (handleAssignServiceAgent in App.tsx is only reachable from
-- ServiceBriefsRoutingView's team-lead-only assignment UI).
create policy "assignments_insert_rls" on public.assignments
for insert
to authenticated
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
);

create policy "assignments_update_rls" on public.assignments
for update
to authenticated
using (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
)
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
);

-- ============================================================================
-- 6. tasks
-- ============================================================================
alter table public.tasks enable row level security;

create policy "tasks_select_rls" on public.tasks
for select
to authenticated
using (public.task_visible(assigned_to));

-- Task creation (handleCreateTask) is available from the shared task board
-- to any non-Sales role (Sales has no "tasks" module at all), always
-- attributed to the caller as created_by.
create policy "tasks_insert_rls" on public.tasks
for insert
to authenticated
with check (
  public.app_user_role() <> 'sales'
  and created_by = public.app_user_id()
);

-- The shared task board (CrossTeamTaskBoard.tsx) lets anyone who can see a
-- task move/edit it — status changes and field edits aren't gated behind a
-- separate ownership check client-side, only visibility is. This mirrors
-- that: the same rule as SELECT.
create policy "tasks_update_rls" on public.tasks
for update
to authenticated
using (public.task_visible(assigned_to))
with check (public.task_visible(assigned_to));

-- ============================================================================
-- 7. campaigns
-- ============================================================================
alter table public.campaigns enable row level security;

-- Mirrors isCampaignAccessibleUnderRLS() exactly: Sales has zero access;
-- Executive/Head of Technical/AM Team Lead/Media Buying Team Lead see
-- everything; AM Agent and Media Buying Agent are scoped strictly to their
-- assigned clients (no ownership/creator fallback); every other role has no
-- access at all.
create policy "campaigns_select_rls" on public.campaigns
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
);

-- Mirrors canCreateCampaign in data/roles.ts: only Media Buying Team Lead
-- and Media Buying Agent may create campaigns (AM Agent can edit but not
-- create — canCreateCampaign: false for am_agent, an explicit product
-- decision made earlier in this project).
create policy "campaigns_insert_rls" on public.campaigns
for insert
to authenticated
with check (
  public.app_user_role() in ('media_buying_team_lead', 'media_buying_agent')
);

-- Mirrors the canEdit permission check in the campaigns table's update
-- handler in src/lib/supabase.ts exactly: Media Buying Team Lead can edit
-- any campaign; Media Buying Agent and AM Agent are scoped to their
-- assigned clients; Executive/Head of Technical/AM Team Lead are view-only
-- (they can SELECT above but never UPDATE).
create policy "campaigns_update_rls" on public.campaigns
for update
to authenticated
using (
  public.app_user_role() = 'media_buying_team_lead'
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
)
with check (
  public.app_user_role() = 'media_buying_team_lead'
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

-- ============================================================================
-- 8. social_insights  (inferred — no client-side emulation existed)
-- ============================================================================
-- Per-client, per-platform social metrics. Client-specific and only
-- relevant to the roles that work with a client's social channels or the
-- overall client relationship, following the same client-visibility shape
-- used for campaigns/briefs. The app never writes to this table (presumably
-- populated by a platform-metrics integration using the service role).
alter table public.social_insights enable row level security;

create policy "social_insights_select_rls" on public.social_insights
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'social_media_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(client_id, 'social_media'))
);

-- ============================================================================
-- 9. reports  (inferred)
-- ============================================================================
-- Internal/client-facing generated reports for a client. Treated as an
-- Account Management / executive artifact (like client_comparisons below)
-- rather than a per-service-team one, plus visible to whoever generated it
-- regardless of role — you can always see a report you produced yourself.
alter table public.reports enable row level security;

create policy "reports_select_rls" on public.reports
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or generated_by = public.app_user_id()
);

-- ============================================================================
-- 10. capacity_logs  (inferred)
-- ============================================================================
-- Daily active-clients snapshots per agent, shown in CapacityManagement.tsx
-- to exactly the same audience that can see the underlying employee: reuses
-- employee_visible() against the logged agent, restricted further so only
-- canManageCapacity: true roles can log a reading (matching
-- CapacityManagement.tsx's log-capacity form, which any team lead can use
-- to log a reading for one of their own visible agents).
alter table public.capacity_logs enable row level security;

create policy "capacity_logs_select_rls" on public.capacity_logs
for select
to authenticated
using (public.employee_visible_by_id(agent_id));

create policy "capacity_logs_insert_rls" on public.capacity_logs
for insert
to authenticated
with check (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
  and public.employee_visible_by_id(agent_id)
);

-- ============================================================================
-- 11. daily_logs  (inferred)
-- ============================================================================
-- Personal daily activity summaries (DailyOperationsModule.tsx). Same
-- audience as the employee who wrote them: themselves, their own team lead,
-- and Executive/Head of Technical — reuses employee_visible_by_id(). Always
-- authored as yourself.
alter table public.daily_logs enable row level security;

create policy "daily_logs_select_rls" on public.daily_logs
for select
to authenticated
using (public.employee_visible_by_id(user_id));

create policy "daily_logs_insert_self_rls" on public.daily_logs
for insert
to authenticated
with check (user_id = public.app_user_id());

-- ============================================================================
-- 12. extra_notes  (inferred)
-- ============================================================================
-- Same shape as daily_logs: personal notes, same visibility, self-authored.
alter table public.extra_notes enable row level security;

create policy "extra_notes_select_rls" on public.extra_notes
for select
to authenticated
using (public.employee_visible_by_id(user_id));

create policy "extra_notes_insert_self_rls" on public.extra_notes
for insert
to authenticated
with check (user_id = public.app_user_id());

-- ============================================================================
-- 13. performance_reviews  (inferred)
-- ============================================================================
-- HR-sensitive: deliberately narrower than employee_visible() (which would
-- let e.g. an am_team_lead see every am_agent's review regardless of who
-- wrote it). Visible only to the reviewee, whoever wrote the review, and
-- Executive/Head of Technical. The app never writes to this table today
-- (no review-authoring UI exists yet), so no insert/update policy is
-- created — add one scoped to `reviewed_by = public.app_user_id()` if that
-- UI is built later.
alter table public.performance_reviews enable row level security;

create policy "performance_reviews_select_rls" on public.performance_reviews
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  or user_id = public.app_user_id()
  or reviewed_by = public.app_user_id()
);

-- ============================================================================
-- 14. meetings  (inferred)
-- ============================================================================
-- AM-client meeting recordings/transcripts, keyed directly by am_agent_id
-- (no join needed). Same shape as the am_agent branch of client access:
-- Executive/Head of Technical/AM Team Lead see everything, an AM Agent sees
-- only their own meetings. No other department has a reason to read AM
-- meeting transcripts.
alter table public.meetings enable row level security;

create policy "meetings_select_rls" on public.meetings
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or am_agent_id = public.app_user_id()
);

-- ============================================================================
-- 15. kpi_scores  (inferred)
-- ============================================================================
-- Same HR-sensitivity reasoning as performance_reviews: self, the reviewer,
-- or Executive/Head of Technical only.
alter table public.kpi_scores enable row level security;

create policy "kpi_scores_select_rls" on public.kpi_scores
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  or user_id = public.app_user_id()
  or reviewed_by = public.app_user_id()
);

-- ============================================================================
-- 16. client_comparisons  (inferred)
-- ============================================================================
-- Period-over-period client performance deltas with AI recommendations —
-- treated as an Account Management / executive strategic artifact, same
-- shape as `reports`.
alter table public.client_comparisons enable row level security;

create policy "client_comparisons_select_rls" on public.client_comparisons
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

-- ============================================================================
-- Recommended indexes
-- ============================================================================
-- Every policy above joins or filters on these columns on every query that
-- touches the table, since they're evaluated per row. Add if not already
-- present — safe to run even if some already exist.
-- ============================================================================
create index if not exists idx_clients_sales_owner_id on public.clients (sales_owner_id);
create index if not exists idx_clients_am_agent_id on public.clients (am_agent_id);
create index if not exists idx_clients_package_id on public.clients (package_id);
create index if not exists idx_briefs_client_service on public.briefs (client_id, service_type);
create index if not exists idx_assignments_client_service_agent on public.assignments (client_id, service_type, agent_id);
create index if not exists idx_tasks_assigned_to on public.tasks (assigned_to);
create index if not exists idx_campaigns_client_id on public.campaigns (client_id);
create index if not exists idx_social_insights_client_id on public.social_insights (client_id);
create index if not exists idx_reports_client_id on public.reports (client_id);
create index if not exists idx_capacity_logs_agent_id on public.capacity_logs (agent_id);
create index if not exists idx_daily_logs_user_id on public.daily_logs (user_id);
create index if not exists idx_extra_notes_user_id on public.extra_notes (user_id);
create index if not exists idx_performance_reviews_user_id on public.performance_reviews (user_id);
create index if not exists idx_performance_reviews_reviewed_by on public.performance_reviews (reviewed_by);
create index if not exists idx_meetings_am_agent_id on public.meetings (am_agent_id);
create index if not exists idx_kpi_scores_user_id on public.kpi_scores (user_id);
create index if not exists idx_kpi_scores_reviewed_by on public.kpi_scores (reviewed_by);
create index if not exists idx_client_comparisons_client_id on public.client_comparisons (client_id);
create index if not exists idx_users_auth_id on public.users (auth_id);

commit;
