-- ============================================================================
-- CANONICAL SCHEMA v3 — full clean rebuild, superseding
-- 20260919100000_canonical_schema_v2.sql and every incremental migration
-- layered on top of it since:
--   20260925100000_client_phone_number.sql
-- (v2 itself already consolidated everything through
-- 20260924100000_task_drive_link.sql — see v2's own header for that
-- history; not repeated here.)
-- ============================================================================
--
-- WHY THIS FILE EXISTS
-- --------------------
-- The live database is STILL confirmed empty of real employee/client data —
-- no provisioning script run, no real clients added — so this is one more
-- from-scratch rebuild instead of layering a Module 13/14 migration on top
-- of v2. Doing it this way sidesteps the package_id pre-flight check
-- entirely (the thing blocking a plain additive Phase 5 migration): a fresh
-- build just creates `clients` with the correct `services` column directly,
-- no backfill from `package_id`/`packages` needed because there is nothing
-- to backfill. THE "LAST TIME" WARNING FROM v2 STILL APPLIES, MORE THAN
-- EVER: once real employee/client data exists, all future schema changes
-- must be additive migrations only (never DROP TABLE, never a
-- wipe-and-rebuild like this one). Ask again before another one of these.
--
-- SOURCE OF TRUTH
-- ----------------
-- Every column below is cross-checked directly against src/types/database.ts
-- as it exists today. Every id / foreign-key column is `text` (never
-- `uuid`) — the app always supplies its own human-readable string ids and
-- never relies on server-side uuid generation. `users.auth_id` and
-- `client_portal_users.auth_id` are the only exceptions: Supabase Auth's own
-- uuid, referencing auth.users(id). Where current app code conflicted with
-- what a table/policy "should" say, current app code won — see the Module
-- 13/14 section below for the specific calls made.
--
-- WHAT'S NEW IN v3 (Module 13 + Module 14, consolidated from app code +
-- types/database.ts, no migration files ever written for most of this since
-- it was deliberately held pending this rebuild)
-- --------------------------------------------------------------------------
-- 1. clients.status: 5-value lifecycle, replacing the old
--    'lead'|'onboarding'|'active'|'renewal'|'churned'. 'lead' is gone — a
--    ClientRecord is now only ever created at 'onboarding' (that creation
--    IS the Sales -> AM Team Lead handoff). 'churned' is renamed 'closed'.
--    'paused' is new. clients_status_check updated accordingly.
--    churn_reason/churned_at COLUMN NAMES are kept as-is (Module 13 only
--    renamed the status VALUE, not these columns — app code already
--    relies on this).
-- 2. clients.am_agent_assigned_at (new, nullable timestamptz): cleared to
--    null whenever am_agent_id changes, set to now() when assigned —
--    mirrors the viewed_at-clearing convention already used elsewhere in
--    this schema (assignments.viewed_at, tasks.assignee_viewed_at). Drives
--    the period-scoped gained/lost client metrics in MyWorkHub. No RLS
--    change needed: clients has no column-level RLS anywhere in this
--    schema (see v2's header), so the existing broad
--    clients_update_am_assignment_rls grant already covers writes to it.
-- 3. clients.phone_number (new, nullable text, Module 14): plain free-text
--    contact number, no format constraint — client phone numbers span
--    multiple countries/formats, same posture as every other free-text
--    contact field in this schema.
-- 4. Package -> services (Module 13 Phase 5): clients.package_id is
--    REMOVED and clients.services (text[], not null default '{}', same
--    <@ array[...] membership check packages.services used to carry) takes
--    its place as the direct source of which services a client
--    subscribes to. client_has_service(p_client_id, p_service)'s SIGNATURE
--    is unchanged (still referenced by name from ~32 call sites across
--    briefs/brief_revisions/assignments/campaigns/social_insights/
--    analytics_insights/report_scope_accessible policies) but its BODY no
--    longer joins through packages — it reads clients.services directly.
--    This is a pure function-body swap; no RLS policy text changes
--    anywhere in this file.
-- 5. packages TABLE: DROPPED. See "ON DROPPING packages" below — this is
--    the one genuinely judgment-call decision in this file, flagged, not
--    just asserted.
--
-- ON DROPPING packages (answering the question asked, not just deciding it
-- silently)
-- --------------------------------------------------------------------------
-- Nothing in the RLS/function layer needs packages once #4 above lands —
-- client_has_service was the only function that ever touched it, and its
-- body no longer does. A live migration path would have kept the table
-- ("kept for rollback safety on existing package_id references" was v2's
-- own words) because real rows might still point at it. That constraint is
-- gone here: confirmed no real data exists, so there is nothing to roll
-- back to. Recommendation: DROP IT, which this file does.
-- BUT — and this is the part to flag loudly rather than bury — the
-- FRONTEND has not been rewired yet. As of this file, ~20 call sites
-- across 12 components still read `client.package_id` and/or look up
-- `packages.find(...)`, and src/components/clientPortal/ClientPortalView.tsx
-- specifically runs a LIVE `supabase.from('packages').select(...)` query,
-- not just a stale client-side lookup. Once this schema lands, that one
-- will hard-error (relation does not exist) for every client-portal page
-- load, not just silently show stale data. This file completes Phase 5's
-- DATABASE side only. See the chat response accompanying this file for the
-- full file list — that frontend rewrite is still a separate, not-yet-done
-- piece of work.
--
-- EVERYTHING BELOW THIS POINT THAT ISN'T CALLED OUT ABOVE IS UNCHANGED FROM
-- v2 — see v2's own header for the full history of every RLS/function
-- decision carried forward (task_visible's 3-arg signature,
-- direct_report_visible's narrowed HR-data visibility, briefs_write_rls's
-- widened am_team_lead/am_agent authoring, the client_comparisons/reports
-- 8-role dispatch, users.auth_id nullability, etc.). Section numbers below
-- intentionally skip "1.2 packages" and "4.2 packages" (removed) rather
-- than renumbering every subsequent section — pure cosmetics, not worth
-- the transcription risk in a file this size for a from-scratch review.
-- ============================================================================

begin;

-- ============================================================================
-- 0. DROP — the entire schema this file owns. All confirmed empty; cascade
--    is safe. Storage policies are dropped by name (they don't cascade from
--    a public-schema table drop). Functions are dropped by every historical
--    signature so this file is re-runnable against a partially-migrated DB
--    too, not just an empty one. packages is intentionally NOT recreated
--    after being dropped here — see header.
-- ============================================================================
drop policy if exists "task_attachments_objects_select_rls" on storage.objects;
drop policy if exists "task_attachments_objects_insert_rls" on storage.objects;
drop policy if exists "task_attachments_objects_delete_rls" on storage.objects;
drop policy if exists "meeting_recordings_objects_select_rls" on storage.objects;
drop policy if exists "meeting_recordings_objects_insert_rls" on storage.objects;
drop policy if exists "client_contracts_objects_select_rls" on storage.objects;
drop policy if exists "client_contracts_objects_insert_rls" on storage.objects;
drop policy if exists "client_contracts_objects_delete_rls" on storage.objects;

drop table if exists
  public.kpi_scores,
  public.client_comparisons,
  public.reports,
  public.meetings,
  public.performance_reviews,
  public.extra_notes,
  public.daily_logs,
  public.capacity_logs,
  public.platform_connections,
  public.analytics_insights,
  public.social_insights,
  public.campaigns,
  public.client_contracts,
  public.task_attachments,
  public.task_comments,
  public.tasks,
  public.assignments,
  public.brief_revisions,
  public.briefs,
  public.client_portal_users,
  public.clients,
  public.packages,
  public.users
cascade;

drop function if exists public.app_user_id() cascade;
drop function if exists public.app_user_role() cascade;
drop function if exists public.app_user_team() cascade;
drop function if exists public.employee_visible(text, text) cascade;
drop function if exists public.employee_visible_by_id(text) cascade;
drop function if exists public.client_has_service(text, text) cascade;
drop function if exists public.agent_assigned(text, text) cascade;
drop function if exists public.agent_assigned_any_service(text) cascade;
drop function if exists public.client_am_agent_is_caller(text) cascade;
drop function if exists public.task_visible(text) cascade;
drop function if exists public.task_visible(text, text) cascade;
drop function if exists public.task_visible(text, text, text) cascade;
drop function if exists public.enforce_nesting_depth() cascade;
drop function if exists public.direct_report_visible(text) cascade;
drop function if exists public.report_scope_accessible(text, text) cascade;
drop function if exists public.comparison_scope_accessible(text) cascade;
drop function if exists public.portal_client_id() cascade;
drop function if exists public.portal_am_agent_name() cascade;

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1.1 users
-- ----------------------------------------------------------------------------
create table public.users (
  id text primary key,
  name text not null,
  email text,
  password text,
  role text not null,
  team text,
  manager_id text references public.users (id),
  capacity_limit integer,
  -- Nullable — null marks a "pending" employee created via the Add Employee
  -- admin flow, before scripts/provisionAuthUsers.ts links a real Supabase
  -- Auth account out-of-band with the service-role key.
  auth_id uuid unique references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.users add constraint users_role_check check (
  role in (
    'executive', 'head_of_technical', 'sales',
    'am_team_lead', 'am_agent',
    'media_buying_team_lead', 'media_buying_agent',
    'seo_team_lead', 'seo_agent', 'programming_agent',
    'social_media_team_lead', 'social_media_agent',
    'graphic_designer', 'video_editor', 'ai_engineer'
  )
);

-- A real email-uniqueness guarantee, needed once employees can be created
-- from the browser (CSV bulk upload especially) rather than only via a
-- hand-curated seed list.
alter table public.users add constraint users_email_unique unique (email);

create index idx_users_auth_id on public.users (auth_id);

-- ----------------------------------------------------------------------------
-- 1.2 packages — REMOVED in v3. See header, "ON DROPPING packages".
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 1.3 clients
-- ----------------------------------------------------------------------------
create table public.clients (
  id text primary key,
  name text not null,
  industry text,
  -- Module 14: plain free-text contact number, no format enforcement.
  phone_number text,
  -- Module 13 Phase 5: replaces package_id -> packages.services indirection.
  -- Never empty in practice, but no non-empty constraint — a brand-new
  -- client mid-registration may transiently have none selected yet (see
  -- types/database.ts's own comment on ClientRecord.services).
  services text[] not null default '{}',
  status text not null,
  sales_owner_id text references public.users (id),
  am_agent_id text references public.users (id),
  am_team_lead_id text references public.users (id),
  contract_value numeric,
  start_date date,
  renewal_date date,
  am_team_lead_viewed_at timestamptz,
  -- Module 13: column NAMES kept as-is even though the status VALUE they're
  -- tied to renamed 'churned' -> 'closed' — only UI-facing labels changed.
  churn_reason text,
  churned_at timestamptz,
  portal_slug text,
  -- Module 12 Phase 7: AM Team Lead payment tracking, distinct from
  -- contract_value (Sales's monthly retainer figure, set once at
  -- registration and never edited after). Manually editable, never
  -- auto-computed.
  due_value numeric,
  remaining_value numeric,
  contract_duration_months integer,
  -- Module 13 Phase 4: cleared to null whenever am_agent_id changes, set to
  -- now() when assigned. Drives the period-scoped gained/lost client
  -- metrics in MyWorkHub; not a general "assigned since" display field.
  am_agent_assigned_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.clients add constraint clients_status_check
  check (status in ('onboarding', 'active', 'paused', 'renewal', 'closed'));
alter table public.clients add constraint clients_services_check
  check (services <@ array['seo', 'social_media', 'media_buying', 'creative']);

create index idx_clients_sales_owner_id on public.clients (sales_owner_id);
create index idx_clients_am_agent_id on public.clients (am_agent_id);
create unique index idx_clients_portal_slug on public.clients (portal_slug) where portal_slug is not null;

-- ----------------------------------------------------------------------------
-- 1.4 client_portal_users
-- ----------------------------------------------------------------------------
create table public.client_portal_users (
  id text primary key,
  client_id text not null references public.clients (id),
  auth_id uuid unique references auth.users (id),
  email text not null,
  created_at timestamptz not null default now()
);

create index idx_client_portal_users_client_id on public.client_portal_users (client_id);
create unique index idx_client_portal_users_email on public.client_portal_users (lower(email));

-- ----------------------------------------------------------------------------
-- 1.5 briefs
-- ----------------------------------------------------------------------------
create table public.briefs (
  id text primary key,
  client_id text not null references public.clients (id),
  service_type text not null,
  fields jsonb not null default '{}'::jsonb,
  submitted_by text not null references public.users (id),
  version integer not null,
  team_lead_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

alter table public.briefs add constraint briefs_service_type_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'creative'));

create index idx_briefs_client_service on public.briefs (client_id, service_type);

-- ----------------------------------------------------------------------------
-- 1.6 brief_revisions
-- ----------------------------------------------------------------------------
create table public.brief_revisions (
  id text primary key,
  brief_id text not null references public.briefs (id),
  client_id text not null,
  service_type text not null,
  version integer not null,
  fields jsonb not null default '{}'::jsonb,
  edited_by text not null references public.users (id),
  edited_at timestamptz not null default now()
);

create index idx_brief_revisions_brief_id on public.brief_revisions (brief_id);
create index idx_brief_revisions_client_service on public.brief_revisions (client_id, service_type);

-- ----------------------------------------------------------------------------
-- 1.7 assignments
-- ----------------------------------------------------------------------------
create table public.assignments (
  id text primary key,
  client_id text not null references public.clients (id),
  service_type text not null,
  team_lead_id text not null references public.users (id),
  agent_id text not null references public.users (id),
  assigned_at timestamptz not null default now(),
  reason_notes text,
  -- "New assignment" notification badge, cleared to null whenever agent_id
  -- changes, set when the assigned agent opens the client. Never gates
  -- access — mirrors clients.am_team_lead_viewed_at.
  viewed_at timestamptz
);

alter table public.assignments add constraint assignments_service_type_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'creative'));

create index idx_assignments_client_service_agent on public.assignments (client_id, service_type, agent_id);

-- ----------------------------------------------------------------------------
-- 1.8 tasks
-- ----------------------------------------------------------------------------
create table public.tasks (
  id text primary key,
  client_id text not null references public.clients (id),
  title text not null,
  description text not null,
  assigned_to text references public.users (id),
  created_by text not null references public.users (id),
  team text,
  status text not null,
  due_date date not null,
  priority text not null,
  estimated_hours numeric,
  actual_hours numeric,
  created_at timestamptz not null default now(),
  parent_task_id text references public.tasks (id),
  completed_at timestamptz,
  -- Same notification-badge concept as assignments.viewed_at, for
  -- programming_agent (which has no assignments row — task-based only).
  -- Generic column, cleared whenever assigned_to changes, set when the
  -- assignee opens the client the task belongs to.
  assignee_viewed_at timestamptz,
  -- Manually-pasted Drive URL. No real Drive API integration — same
  -- scaffolding-only posture as every other Module 6 integration point.
  -- Generic, not creative-team-scoped at the DB level.
  drive_link text
);

alter table public.tasks add constraint tasks_status_check
  check (status in ('todo', 'in_progress', 'in_review', 'completed', 'blocked'));
alter table public.tasks add constraint tasks_priority_check
  check (priority in ('low', 'medium', 'high', 'urgent'));

create index idx_tasks_assigned_to on public.tasks (assigned_to);
create index idx_tasks_parent_task_id on public.tasks (parent_task_id);

-- ----------------------------------------------------------------------------
-- 1.9 task_comments
-- ----------------------------------------------------------------------------
create table public.task_comments (
  id text primary key,
  task_id text not null references public.tasks (id),
  parent_comment_id text references public.task_comments (id),
  author_id text not null references public.users (id),
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create index idx_task_comments_task_id on public.task_comments (task_id);
create index idx_task_comments_parent_comment_id on public.task_comments (parent_comment_id);

-- ----------------------------------------------------------------------------
-- 1.10 task_attachments
-- ----------------------------------------------------------------------------
create table public.task_attachments (
  id text primary key,
  task_id text not null references public.tasks (id),
  storage_path text not null,
  filename text not null,
  file_size bigint not null,
  mime_type text not null,
  uploaded_by text not null references public.users (id),
  uploaded_at timestamptz not null default now()
);

create index idx_task_attachments_task_id on public.task_attachments (task_id);

-- ----------------------------------------------------------------------------
-- 1.11 client_contracts
-- ----------------------------------------------------------------------------
-- Sales's signed-contract upload — same metadata-row + private-Storage-
-- bucket shape as task_attachments/meeting recordings, one level up
-- (client instead of task).
create table public.client_contracts (
  id text primary key,
  client_id text not null references public.clients (id),
  storage_path text not null,
  filename text not null,
  file_size bigint not null,
  mime_type text not null,
  uploaded_by text not null references public.users (id),
  uploaded_at timestamptz not null default now()
);

create index idx_client_contracts_client_id on public.client_contracts (client_id);

-- ----------------------------------------------------------------------------
-- 1.12 campaigns
-- ----------------------------------------------------------------------------
create table public.campaigns (
  id text primary key,
  client_id text not null references public.clients (id),
  name text,
  platform text not null, -- no check constraint — TS type ends in `| string`, an intentional escape hatch
  objective text,
  status text,
  campaign_id_external text,
  spend numeric not null default 0,
  budget numeric,
  start_date date,
  end_date date,
  owner_id text references public.users (id),
  team text,
  results jsonb not null default '{}'::jsonb,
  date date not null,
  created_at timestamptz not null default now()
);

alter table public.campaigns add constraint campaigns_status_check
  check (status is null or status in ('draft', 'active', 'paused', 'completed', 'archived'));

create index idx_campaigns_client_id on public.campaigns (client_id);

-- ----------------------------------------------------------------------------
-- 1.13 social_insights
-- ----------------------------------------------------------------------------
create table public.social_insights (
  id text primary key,
  client_id text not null references public.clients (id),
  platform text not null, -- no check constraint — TS type ends in `| string`, an intentional escape hatch
  metrics jsonb not null default '{}'::jsonb,
  date date not null
);

create index idx_social_insights_client_id on public.social_insights (client_id);

-- ----------------------------------------------------------------------------
-- 1.14 analytics_insights
-- ----------------------------------------------------------------------------
create table public.analytics_insights (
  id text primary key,
  client_id text not null references public.clients (id),
  platform text not null, -- no check constraint — TS type ends in `| string`, an intentional escape hatch
  metrics jsonb not null default '{}'::jsonb,
  date date not null
);

create index idx_analytics_insights_client_id on public.analytics_insights (client_id);

-- ----------------------------------------------------------------------------
-- 1.15 platform_connections
-- ----------------------------------------------------------------------------
create table public.platform_connections (
  id text primary key,
  client_id text not null references public.clients (id),
  platform_category text not null,
  platform_name text not null,
  status text not null default 'not_connected',
  connected_by text references public.users (id),
  connected_at timestamptz,
  last_synced_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, platform_name)
);

alter table public.platform_connections add constraint platform_connections_category_check
  check (platform_category in ('media_buying', 'analytics', 'social_media'));
alter table public.platform_connections add constraint platform_connections_status_check
  check (status in ('not_connected', 'pending', 'connected'));

create index idx_platform_connections_client_id on public.platform_connections (client_id);

-- ----------------------------------------------------------------------------
-- 1.16 client_comparisons
-- ----------------------------------------------------------------------------
create table public.client_comparisons (
  id text primary key,
  client_id text references public.clients (id),
  agent_id text references public.users (id),
  covered_client_ids text[],
  row_kind text not null default 'comparison',
  period_current text not null,
  period_previous text,
  metrics_current jsonb not null default '{}'::jsonb,
  metrics_previous jsonb not null default '{}'::jsonb,
  delta jsonb not null default '{}'::jsonb,
  ai_recommendations_text text,
  created_at timestamptz not null default now()
);

alter table public.client_comparisons add constraint client_comparisons_scope_check
  check (
    (client_id is not null and agent_id is null)
    or (client_id is null and agent_id is not null)
  );
alter table public.client_comparisons add constraint client_comparisons_row_kind_check
  check (row_kind in ('comparison', 'period_summary'));

create index idx_client_comparisons_client_id on public.client_comparisons (client_id);
create index idx_client_comparisons_agent_id on public.client_comparisons (agent_id);

create unique index client_comparisons_client_period_unique
  on public.client_comparisons (client_id, period_current, period_previous);
create unique index client_comparisons_agent_period_unique
  on public.client_comparisons (agent_id, period_current, period_previous)
  where agent_id is not null;
create unique index client_comparisons_client_period_summary_unique
  on public.client_comparisons (client_id, period_current)
  where row_kind = 'period_summary';
create unique index client_comparisons_agent_period_summary_unique
  on public.client_comparisons (agent_id, period_current)
  where row_kind = 'period_summary';

-- ----------------------------------------------------------------------------
-- 1.17 reports
-- ----------------------------------------------------------------------------
create table public.reports (
  id text primary key,
  client_id text references public.clients (id),
  type text not null,
  period text not null,
  generated_by text not null references public.users (id),
  file_url text,
  comparison_id text references public.client_comparisons (id),
  status text not null default 'final',
  approved_by text references public.users (id),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.reports add constraint reports_type_check check (type in ('internal', 'client'));
alter table public.reports add constraint reports_status_check check (status in ('draft', 'final'));

create index idx_reports_client_id on public.reports (client_id);
create index idx_reports_comparison_id on public.reports (comparison_id);

-- ----------------------------------------------------------------------------
-- 1.18 capacity_logs
-- ----------------------------------------------------------------------------
create table public.capacity_logs (
  id text primary key,
  agent_id text not null references public.users (id),
  date date not null,
  active_clients_count integer not null default 0
);

create index idx_capacity_logs_agent_id on public.capacity_logs (agent_id);

-- ----------------------------------------------------------------------------
-- 1.19 daily_logs
-- ----------------------------------------------------------------------------
create table public.daily_logs (
  id text primary key,
  user_id text not null references public.users (id),
  date date not null,
  summary_text text not null,
  linked_task_ids text[],
  -- Which client this entry's work relates to, if any. Single nullable id,
  -- matching every other work-artifact table in this schema. Filter/
  -- aggregation only: does NOT widen daily_logs_select_rls (still
  -- direct_report_visible(user_id) below) — the Team Activity tab surfaces
  -- task status only, never raw log text.
  client_id text references public.clients (id),
  created_at timestamptz not null default now()
);

create index idx_daily_logs_user_id on public.daily_logs (user_id);
create index idx_daily_logs_client_id on public.daily_logs (client_id);

-- ----------------------------------------------------------------------------
-- 1.20 extra_notes
-- ----------------------------------------------------------------------------
create table public.extra_notes (
  id text primary key,
  user_id text not null references public.users (id),
  date date not null,
  note_text text not null,
  category text,
  created_at timestamptz not null default now()
);

create index idx_extra_notes_user_id on public.extra_notes (user_id);

-- ----------------------------------------------------------------------------
-- 1.21 performance_reviews
-- ----------------------------------------------------------------------------
create table public.performance_reviews (
  id text primary key,
  user_id text not null references public.users (id),
  period text not null,
  efficiency_score numeric not null,
  strengths text,
  improvement_areas text,
  growth_recommendation text,
  reviewed_by text not null references public.users (id),
  created_at timestamptz not null default now()
);

create index idx_performance_reviews_user_id on public.performance_reviews (user_id);
create index idx_performance_reviews_reviewed_by on public.performance_reviews (reviewed_by);

-- ----------------------------------------------------------------------------
-- 1.22 meetings
-- ----------------------------------------------------------------------------
create table public.meetings (
  id text primary key,
  client_id text not null references public.clients (id),
  am_agent_id text not null references public.users (id),
  meeting_date date not null,
  recording_url text,
  transcript_text text,
  ai_summary_text text,
  action_items jsonb,
  created_at timestamptz not null default now()
);

create index idx_meetings_am_agent_id on public.meetings (am_agent_id);

-- ----------------------------------------------------------------------------
-- 1.23 kpi_scores
-- ----------------------------------------------------------------------------
create table public.kpi_scores (
  id text primary key,
  user_id text not null references public.users (id),
  period text not null,
  metrics jsonb not null default '{}'::jsonb,
  overall_score numeric not null,
  suggested_status text, -- no check constraint — TS type ends in `| string`, an intentional escape hatch
  reviewed_by text references public.users (id),
  created_at timestamptz not null default now(),
  constraint kpi_scores_user_period_unique unique (user_id, period)
);

create index idx_kpi_scores_user_id on public.kpi_scores (user_id);
create index idx_kpi_scores_reviewed_by on public.kpi_scores (reviewed_by);

-- ============================================================================
-- 2. HELPER FUNCTIONS — final versions only
-- ============================================================================

create or replace function public.app_user_id()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from public.users where auth_id = auth.uid();
$$;

create or replace function public.app_user_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from public.users where auth_id = auth.uid();
$$;

create or replace function public.app_user_team()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select team from public.users where auth_id = auth.uid();
$$;

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
    or (public.app_user_role() = 'seo_team_lead' and target_role in ('seo_team_lead', 'seo_agent', 'programming_agent'))
    or (public.app_user_role() = 'social_media_team_lead' and target_role in ('social_media_team_lead', 'social_media_agent'))
    or (public.app_user_role() = 'am_agent' and target_role in ('am_agent', 'am_team_lead'))
    or (public.app_user_role() = 'media_buying_agent' and target_role in ('media_buying_agent', 'media_buying_team_lead'))
    or (public.app_user_role() = 'seo_agent' and target_role in ('seo_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'programming_agent' and target_role in ('programming_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'social_media_agent' and target_role in ('social_media_agent', 'social_media_team_lead'))
    or (public.app_user_role() = 'sales' and target_role = 'sales');
$$;

create or replace function public.employee_visible_by_id(target_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.employee_visible(u.id, u.role) from public.users u where u.id = target_id;
$$;

-- Module 13 Phase 5: SIGNATURE unchanged (still called by name from ~32
-- RLS policies elsewhere in this file) but the BODY no longer joins
-- through packages — reads clients.services directly.
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
    where c.id = p_client_id
      and p_service = any(c.services)
  );
$$;

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

-- Final (3-arg) version. p_parent_task_id lets a subtask inherit
-- visibility from its parent (bounded by the 3-level nesting cap enforced
-- by enforce_nesting_depth() below). p_client_id adds a narrow am_agent
-- branch: visibility into every department's tasks for a client they're
-- the assigned am_agent for, via the same client_am_agent_is_caller()
-- helper reports/comparisons/campaigns already use. Both trailing params
-- default to null so 1- and 2-arg call sites (task_comments/
-- task_attachments RLS, storage policies) keep compiling unchanged.
create or replace function public.task_visible(
  p_assigned_to text,
  p_parent_task_id text default null,
  p_client_id text default null
)
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
      or (
        public.app_user_role() in ('graphic_designer', 'video_editor')
        and p_assigned_to = public.app_user_id()
      )
      or (
        public.app_user_role() not in ('graphic_designer', 'video_editor')
        and (
          p_assigned_to = public.app_user_id()
          or exists (
            select 1 from public.users u
            where u.id = p_assigned_to and u.team = public.app_user_team()
          )
        )
      )
      or (
        public.app_user_role() = 'am_agent'
        and p_client_id is not null
        and public.client_am_agent_is_caller(p_client_id)
      )
      or (
        p_parent_task_id is not null
        and exists (
          select 1 from public.tasks pt
          where pt.id = p_parent_task_id
            and public.task_visible(pt.assigned_to, pt.parent_task_id, pt.client_id)
        )
      )
    );
$$;

create or replace function public.enforce_nesting_depth()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  parent_col text := TG_ARGV[0];
  depth int := 1;
  current_parent text;
  hops int := 0;
begin
  execute format('select ($1).%I', parent_col) using NEW into current_parent;

  while current_parent is not null loop
    depth := depth + 1;
    hops := hops + 1;
    if hops > 10 then
      raise exception 'Nesting chain too long or cyclic in %', TG_TABLE_NAME;
    end if;

    execute format('select %I from %I.%I where id = $1', parent_col, TG_TABLE_SCHEMA, TG_TABLE_NAME)
      using current_parent into current_parent;
  end loop;

  if depth > 3 then
    raise exception 'Nesting may only go 3 levels deep in %', TG_TABLE_NAME;
  end if;

  return NEW;
end;
$$;

-- Deliberately no same-role peer branch and no agent-sees-their-lead
-- reciprocal branch, unlike employee_visible(): personal/HR-sensitive
-- tables only.
create or replace function public.direct_report_visible(target_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
    or exists (
      select 1 from public.users u
      where u.id = target_id
        and (
          (public.app_user_role() = 'am_team_lead' and u.role = 'am_agent')
          or (public.app_user_role() = 'media_buying_team_lead' and u.role = 'media_buying_agent')
          or (public.app_user_role() = 'seo_team_lead' and u.role in ('seo_agent', 'programming_agent'))
          or (public.app_user_role() = 'social_media_team_lead' and u.role = 'social_media_agent')
        )
    );
$$;

create or replace function public.report_scope_accessible(p_client_id text, p_agent_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    case
      when p_client_id is not null then (
        public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
        or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(p_client_id))
        or (public.app_user_role() = 'media_buying_team_lead' and public.client_has_service(p_client_id, 'media_buying'))
        or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(p_client_id, 'media_buying'))
        or (public.app_user_role() = 'seo_team_lead' and public.client_has_service(p_client_id, 'seo'))
        or (public.app_user_role() = 'seo_agent' and public.agent_assigned(p_client_id, 'seo'))
        or (public.app_user_role() = 'social_media_team_lead' and public.client_has_service(p_client_id, 'social_media'))
        or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(p_client_id, 'social_media'))
      )
      when p_agent_id is not null then public.direct_report_visible(p_agent_id)
      else false
    end;
$$;

create or replace function public.comparison_scope_accessible(p_comparison_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.report_scope_accessible(cc.client_id, cc.agent_id)
  from public.client_comparisons cc
  where cc.id = p_comparison_id;
$$;

create or replace function public.portal_client_id()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select client_id from public.client_portal_users where auth_id = auth.uid();
$$;

create or replace function public.portal_am_agent_name()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.name
  from public.clients c
  join public.users u on u.id = c.am_agent_id
  where c.id = public.portal_client_id();
$$;

-- ============================================================================
-- 3. TRIGGERS
-- ============================================================================
create trigger tasks_enforce_nesting_depth
before insert or update of parent_task_id on public.tasks
for each row
execute function public.enforce_nesting_depth('parent_task_id');

create trigger task_comments_enforce_nesting_depth
before insert or update of parent_comment_id on public.task_comments
for each row
execute function public.enforce_nesting_depth('parent_comment_id');

-- ============================================================================
-- 4. ROW LEVEL SECURITY + POLICIES + GRANTS — final versions only
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 4.1 users
-- ----------------------------------------------------------------------------
alter table public.users enable row level security;

create policy "users_select_rls" on public.users
for select to authenticated
using (public.employee_visible(id, role));

create policy "users_update_capacity_rls" on public.users
for update to authenticated
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

-- A narrow INSERT path for the "Add Employee" admin screen, scoped to
-- executive/head_of_technical only (adding headcount is a leadership
-- action, not a team-lead one — narrower than users_update_capacity_rls's
-- role set on purpose). `auth_id is null` is load-bearing: it makes it
-- structurally impossible for a browser session to insert a row claiming
-- any auth_id, real or fabricated — only the service-role provisioning
-- script (which bypasses RLS) ever sets one.
create policy "users_insert_admin_rls" on public.users
for insert to authenticated
with check (
  public.app_user_role() in ('executive', 'head_of_technical')
  and auth_id is null
);

grant select on public.users to authenticated;
grant update (capacity_limit) on public.users to authenticated;
grant insert on public.users to authenticated;

-- ----------------------------------------------------------------------------
-- 4.2 packages — REMOVED in v3. See header, "ON DROPPING packages".
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 4.3 clients
-- ----------------------------------------------------------------------------
alter table public.clients enable row level security;

create policy "clients_select_rls" on public.clients
for select to authenticated
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

create policy "clients_select_portal_rls" on public.clients
for select to authenticated
using (id = public.portal_client_id());

create policy "clients_insert_sales_rls" on public.clients
for insert to authenticated
with check (
  public.app_user_role() = 'sales'
  and sales_owner_id = public.app_user_id()
);

create policy "clients_update_am_assignment_rls" on public.clients
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'sales' and sales_owner_id = public.app_user_id())
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'sales' and sales_owner_id = public.app_user_id())
);

grant select, insert, update on public.clients to authenticated;

-- ----------------------------------------------------------------------------
-- 4.4 client_portal_users
-- ----------------------------------------------------------------------------
alter table public.client_portal_users enable row level security;

create policy "client_portal_users_select_self_rls" on public.client_portal_users
for select to authenticated
using (auth_id = auth.uid());

create policy "client_portal_users_select_staff_rls" on public.client_portal_users
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

create policy "client_portal_users_insert_staff_rls" on public.client_portal_users
for insert to authenticated
with check (
  auth_id is null
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  )
);

create policy "client_portal_users_claim_rls" on public.client_portal_users
for update to authenticated
using (auth_id is null and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
with check (auth_id = auth.uid() and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

grant select, insert, update on public.client_portal_users to authenticated;

-- ----------------------------------------------------------------------------
-- 4.5 briefs
-- ----------------------------------------------------------------------------
alter table public.briefs enable row level security;

create policy "briefs_select_rls" on public.briefs
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

create policy "briefs_select_portal_rls" on public.briefs
for select to authenticated
using (client_id = public.portal_client_id());

create policy "briefs_write_rls" on public.briefs
for insert to authenticated
with check (
  submitted_by = public.app_user_id()
  and (
    (public.app_user_role() = 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
    or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

create policy "briefs_update_rls" on public.briefs
for update to authenticated
using (
  (public.app_user_role() = 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
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

create policy "briefs_mark_viewed_rls" on public.briefs
for update to authenticated
using (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
)
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
);

grant select, insert, update on public.briefs to authenticated;

-- ----------------------------------------------------------------------------
-- 4.6 brief_revisions
-- ----------------------------------------------------------------------------
alter table public.brief_revisions enable row level security;

create policy "brief_revisions_select_rls" on public.brief_revisions
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and edited_by = public.app_user_id())
);

create policy "brief_revisions_insert_rls" on public.brief_revisions
for insert to authenticated
with check (
  edited_by = public.app_user_id()
  and (
    (public.app_user_role() = 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
    or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

grant select, insert on public.brief_revisions to authenticated;

-- ----------------------------------------------------------------------------
-- 4.7 assignments
-- ----------------------------------------------------------------------------
alter table public.assignments enable row level security;

create policy "assignments_select_rls" on public.assignments
for select to authenticated
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

create policy "assignments_insert_rls" on public.assignments
for insert to authenticated
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
);

-- The assigned agent (not just their team lead) can update their own row,
-- so they can write viewed_at themselves. The app layer only ever sends
-- { viewed_at } from that path — no column-level RLS anywhere in this
-- schema, matching how every other "mark as viewed" write works (e.g.
-- clients.am_team_lead_viewed_at rides the broad
-- clients_update_am_assignment_rls policy the same way).
create policy "assignments_update_rls" on public.assignments
for update to authenticated
using (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
)
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
);

grant select, insert, update on public.assignments to authenticated;

-- ----------------------------------------------------------------------------
-- 4.8 tasks
-- ----------------------------------------------------------------------------
alter table public.tasks enable row level security;

create policy "tasks_select_rls" on public.tasks
for select to authenticated
using (public.task_visible(assigned_to, parent_task_id, client_id));

create policy "tasks_insert_rls" on public.tasks
for insert to authenticated
with check (
  public.app_user_role() <> 'sales'
  and created_by = public.app_user_id()
  and (
    parent_task_id is null
    or exists (
      select 1 from public.tasks pt
      where pt.id = parent_task_id
        and public.task_visible(pt.assigned_to, pt.parent_task_id, pt.client_id)
    )
  )
);

create policy "tasks_update_rls" on public.tasks
for update to authenticated
using (public.task_visible(assigned_to, parent_task_id, client_id))
with check (public.task_visible(assigned_to, parent_task_id, client_id));

grant select, insert, update on public.tasks to authenticated;

-- ----------------------------------------------------------------------------
-- 4.9 task_comments
-- ----------------------------------------------------------------------------
alter table public.task_comments enable row level security;

create policy "task_comments_select_rls" on public.task_comments
for select to authenticated
using (
  exists (
    select 1 from public.tasks t
    where t.id = task_comments.task_id
      and public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
  )
);

create policy "task_comments_insert_rls" on public.task_comments
for insert to authenticated
with check (
  author_id = public.app_user_id()
  and exists (
    select 1 from public.tasks t
    where t.id = task_id
      and public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
  )
);

create policy "task_comments_update_rls" on public.task_comments
for update to authenticated
using (author_id = public.app_user_id())
with check (author_id = public.app_user_id());

grant select, insert, update on public.task_comments to authenticated;

-- ----------------------------------------------------------------------------
-- 4.10 task_attachments
-- ----------------------------------------------------------------------------
alter table public.task_attachments enable row level security;

create policy "task_attachments_select_rls" on public.task_attachments
for select to authenticated
using (
  exists (
    select 1 from public.tasks t
    where t.id = task_attachments.task_id
      and public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
  )
);

create policy "task_attachments_insert_rls" on public.task_attachments
for insert to authenticated
with check (
  uploaded_by = public.app_user_id()
  and exists (
    select 1 from public.tasks t
    where t.id = task_id
      and public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
  )
);

create policy "task_attachments_delete_rls" on public.task_attachments
for delete to authenticated
using (uploaded_by = public.app_user_id());

grant select, insert, delete on public.task_attachments to authenticated;

-- ----------------------------------------------------------------------------
-- 4.11 client_contracts
-- ----------------------------------------------------------------------------
-- Visibility mirrors clients.contract_value exactly (canSeeContractValue in
-- lib/permissions.ts): executive/head_of_technical/am_team_lead/am_agent
-- see every contract; Sales only their own clients'. Upload is narrower —
-- only the client's own sales_owner_id, since Sales is who signs clients.
alter table public.client_contracts enable row level security;

create policy "client_contracts_select_rls" on public.client_contracts
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (
    public.app_user_role() = 'sales'
    and exists (
      select 1 from public.clients c
      where c.id = client_contracts.client_id and c.sales_owner_id = public.app_user_id()
    )
  )
);

create policy "client_contracts_insert_rls" on public.client_contracts
for insert to authenticated
with check (
  uploaded_by = public.app_user_id()
  and public.app_user_role() = 'sales'
  and exists (
    select 1 from public.clients c
    where c.id = client_id and c.sales_owner_id = public.app_user_id()
  )
);

create policy "client_contracts_delete_rls" on public.client_contracts
for delete to authenticated
using (uploaded_by = public.app_user_id());

grant select, insert, delete on public.client_contracts to authenticated;

-- ----------------------------------------------------------------------------
-- 4.12 campaigns
-- ----------------------------------------------------------------------------
alter table public.campaigns enable row level security;

create policy "campaigns_select_rls" on public.campaigns
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
);

create policy "campaigns_insert_rls" on public.campaigns
for insert to authenticated
with check (
  public.app_user_role() in ('media_buying_team_lead', 'media_buying_agent')
);

create policy "campaigns_update_rls" on public.campaigns
for update to authenticated
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

grant select, insert, update on public.campaigns to authenticated;

-- ----------------------------------------------------------------------------
-- 4.13 social_insights
-- ----------------------------------------------------------------------------
alter table public.social_insights enable row level security;

create policy "social_insights_select_rls" on public.social_insights
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'social_media_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(client_id, 'social_media'))
);

grant select on public.social_insights to authenticated;

-- ----------------------------------------------------------------------------
-- 4.14 analytics_insights
-- ----------------------------------------------------------------------------
alter table public.analytics_insights enable row level security;

create policy "analytics_insights_select_rls" on public.analytics_insights
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'seo_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_agent' and public.agent_assigned(client_id, 'seo'))
);

grant select on public.analytics_insights to authenticated;

-- ----------------------------------------------------------------------------
-- 4.15 platform_connections
-- ----------------------------------------------------------------------------
alter table public.platform_connections enable row level security;

create policy "platform_connections_select_rls" on public.platform_connections
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

create policy "platform_connections_insert_rls" on public.platform_connections
for insert to authenticated
with check (
  (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  )
  and (connected_by is null or connected_by = public.app_user_id())
);

create policy "platform_connections_update_rls" on public.platform_connections
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
)
with check (
  (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  )
  and (connected_by is null or connected_by = public.app_user_id())
);

grant select, insert, update on public.platform_connections to authenticated;

-- ----------------------------------------------------------------------------
-- 4.16 client_comparisons
-- ----------------------------------------------------------------------------
alter table public.client_comparisons enable row level security;

create policy "client_comparisons_select_rls" on public.client_comparisons
for select to authenticated
using (public.report_scope_accessible(client_id, agent_id));

create policy "client_comparisons_select_portal_rls" on public.client_comparisons
for select to authenticated
using (client_id = public.portal_client_id());

create policy "client_comparisons_insert_rls" on public.client_comparisons
for insert to authenticated
with check (public.report_scope_accessible(client_id, agent_id));

create policy "client_comparisons_update_rls" on public.client_comparisons
for update to authenticated
using (public.report_scope_accessible(client_id, agent_id))
with check (public.report_scope_accessible(client_id, agent_id));

grant select, insert, update on public.client_comparisons to authenticated;

-- ----------------------------------------------------------------------------
-- 4.17 reports
-- ----------------------------------------------------------------------------
alter table public.reports enable row level security;

create policy "reports_select_rls" on public.reports
for select to authenticated
using (
  generated_by = public.app_user_id()
  or (comparison_id is not null and public.comparison_scope_accessible(comparison_id))
);

create policy "reports_select_portal_rls" on public.reports
for select to authenticated
using (client_id = public.portal_client_id() and type = 'client');

create policy "reports_insert_rls" on public.reports
for insert to authenticated
with check (
  generated_by = public.app_user_id()
  and type in ('internal', 'client')
  and comparison_id is not null
  and public.comparison_scope_accessible(comparison_id)
);

create policy "reports_update_rls" on public.reports
for update to authenticated
using (
  comparison_id is not null and public.comparison_scope_accessible(comparison_id)
)
with check (
  comparison_id is not null and public.comparison_scope_accessible(comparison_id)
  and (approved_by is null or approved_by = public.app_user_id())
);

grant select, insert, update on public.reports to authenticated;

-- ----------------------------------------------------------------------------
-- 4.18 capacity_logs
-- ----------------------------------------------------------------------------
alter table public.capacity_logs enable row level security;

create policy "capacity_logs_select_rls" on public.capacity_logs
for select to authenticated
using (public.employee_visible_by_id(agent_id));

create policy "capacity_logs_insert_rls" on public.capacity_logs
for insert to authenticated
with check (
  public.app_user_role() in (
    'executive', 'head_of_technical',
    'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
  )
  and public.employee_visible_by_id(agent_id)
);

grant select, insert on public.capacity_logs to authenticated;

-- ----------------------------------------------------------------------------
-- 4.19 daily_logs
-- ----------------------------------------------------------------------------
alter table public.daily_logs enable row level security;

-- Deliberately UNCHANGED by the client_id column (filter/aggregation
-- only, see 1.19 above).
create policy "daily_logs_select_rls" on public.daily_logs
for select to authenticated
using (public.direct_report_visible(user_id));

create policy "daily_logs_insert_self_rls" on public.daily_logs
for insert to authenticated
with check (user_id = public.app_user_id());

grant select, insert on public.daily_logs to authenticated;

-- ----------------------------------------------------------------------------
-- 4.20 extra_notes
-- ----------------------------------------------------------------------------
alter table public.extra_notes enable row level security;

create policy "extra_notes_select_rls" on public.extra_notes
for select to authenticated
using (public.direct_report_visible(user_id));

create policy "extra_notes_insert_self_rls" on public.extra_notes
for insert to authenticated
with check (user_id = public.app_user_id());

grant select, insert on public.extra_notes to authenticated;

-- ----------------------------------------------------------------------------
-- 4.21 performance_reviews
-- ----------------------------------------------------------------------------
alter table public.performance_reviews enable row level security;

-- No insert/update policy: no authoring UI exists yet in the app.
create policy "performance_reviews_select_rls" on public.performance_reviews
for select to authenticated
using (
  public.direct_report_visible(user_id)
  or reviewed_by = public.app_user_id()
);

grant select on public.performance_reviews to authenticated;

-- ----------------------------------------------------------------------------
-- 4.22 meetings
-- ----------------------------------------------------------------------------
alter table public.meetings enable row level security;

create policy "meetings_select_rls" on public.meetings
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or am_agent_id = public.app_user_id()
);

create policy "meetings_insert_rls" on public.meetings
for insert to authenticated
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id() and public.client_am_agent_is_caller(client_id))
);

create policy "meetings_update_rls" on public.meetings
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id())
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id())
);

grant select, insert, update on public.meetings to authenticated;

-- ----------------------------------------------------------------------------
-- 4.23 kpi_scores
-- ----------------------------------------------------------------------------
alter table public.kpi_scores enable row level security;

create policy "kpi_scores_select_rls" on public.kpi_scores
for select to authenticated
using (
  public.direct_report_visible(user_id)
  or reviewed_by = public.app_user_id()
);

create policy "kpi_scores_insert_rls" on public.kpi_scores
for insert to authenticated
with check (
  reviewed_by = public.app_user_id()
  and public.direct_report_visible(user_id)
);

create policy "kpi_scores_update_rls" on public.kpi_scores
for update to authenticated
using (
  reviewed_by = public.app_user_id()
  and public.direct_report_visible(user_id)
)
with check (
  reviewed_by = public.app_user_id()
  and public.direct_report_visible(user_id)
);

grant select, insert, update on public.kpi_scores to authenticated;

-- ============================================================================
-- 5. STORAGE BUCKETS
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'task-attachments',
  'task-attachments',
  false,
  52428800,
  array[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/csv', 'text/plain',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "task_attachments_objects_select_rls" on storage.objects
for select to authenticated
using (
  bucket_id = 'task-attachments'
  and exists (
    select 1 from public.tasks t
    where t.id = (storage.foldername(name))[1]
      and public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
  )
);

create policy "task_attachments_objects_insert_rls" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'task-attachments'
  and exists (
    select 1 from public.tasks t
    where t.id = (storage.foldername(name))[1]
      and public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
  )
);

create policy "task_attachments_objects_delete_rls" on storage.objects
for delete to authenticated
using (
  bucket_id = 'task-attachments'
  and exists (
    select 1 from public.task_attachments a
    where a.storage_path = storage.objects.name
      and a.uploaded_by = public.app_user_id()
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'meeting-recordings',
  'meeting-recordings',
  false,
  209715200,
  array[
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/x-m4a'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "meeting_recordings_objects_select_rls" on storage.objects
for select to authenticated
using (
  bucket_id = 'meeting-recordings'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
  )
);

create policy "meeting_recordings_objects_insert_rls" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'meeting-recordings'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
  )
);

-- Private bucket, folder-per-client (first path segment is client_id, same
-- convention as meeting-recordings above).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-contracts',
  'client-contracts',
  false,
  20971520,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg', 'image/png', 'image/webp'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "client_contracts_objects_select_rls" on storage.objects
for select to authenticated
using (
  bucket_id = 'client-contracts'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
    or exists (
      select 1 from public.clients c
      where c.id = (storage.foldername(name))[1] and c.sales_owner_id = public.app_user_id()
    )
  )
);

create policy "client_contracts_objects_insert_rls" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'client-contracts'
  and exists (
    select 1 from public.clients c
    where c.id = (storage.foldername(name))[1] and c.sales_owner_id = public.app_user_id()
  )
);

create policy "client_contracts_objects_delete_rls" on storage.objects
for delete to authenticated
using (
  bucket_id = 'client-contracts'
  and exists (
    select 1 from public.client_contracts cc
    where cc.storage_path = storage.objects.name
      and cc.uploaded_by = public.app_user_id()
  )
);

commit;
