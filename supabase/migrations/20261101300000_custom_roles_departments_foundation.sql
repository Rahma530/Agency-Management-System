-- Foundation for admin-managed custom roles and custom departments. FOUNDATION ONLY: this
-- migration adds new tables, one SECURITY DEFINER function, and seed data (departments/teams/
-- permission catalog). It does NOT touch any existing table, policy, function, or trigger, and no
-- frontend code changes ship alongside it. The 19 built-in UserRole values keep being governed
-- entirely by their existing hardcoded role checks; nothing here changes their behavior.
--
-- Shape mirrors the proven precedent in 20261031900000_task_types.sql: text primary keys (not
-- uuid/enum), CHECK constraints instead of Postgres enum types, is_active soft-delete (no DELETE
-- policy on the "parent" tables below, mirroring statement), and explicit grants on every table —
-- default privileges on new tables were revoked in 20261030300000_revoke_excess_privileges.sql, so
-- nothing here is reachable by `authenticated` without the grants below, independent of RLS.
--
-- Design (see the accompanying design-review conversation):
--   departments / department_member_teams   — replaces the hardcoded OPERATIONAL_TEAMS array and
--                                              its COMBINED_DEPARTMENT_TEAMS pairing (both in
--                                              src/lib/departmentStaffing.ts) with a real table,
--                                              seeded below from that exact source so this
--                                              migration is a pure data move, not a behavior change.
--   permission_catalog                       — the finite, closed set of capabilities a custom
--                                              role/department can ever be granted. Seeded with 5
--                                              grantable keys and 5 explicitly non-grantable ones
--                                              (administrative powers that must never reach a
--                                              custom role — enforced below at the table level via
--                                              a trigger, not only by UI convention).
--   custom_roles                             — one row per admin-created role; its `id` is the
--                                              exact value later stored in users.role. The id CHECK
--                                              below structurally excludes all 19 built-in role
--                                              names, so a custom role can never collide with — or
--                                              be mistaken by any existing hardcoded check for — a
--                                              real built-in role. Since executive/head_of_technical
--                                              can therefore never BE a custom_roles row, no custom
--                                              role can ever inherit or be confused with their
--                                              privileges; that exclusion is structural, not a
--                                              runtime check that could be bypassed.
--   custom_role_modules                      — which AppModuleId values (src/data/roles.ts) a
--                                              custom role's sidebar/router should allow.
--   department_permissions                   — a department's default grantable permissions.
--   custom_role_permissions                  — per-role overrides on top of the department default
--                                              (presence of a row wins over the department default;
--                                              its own `granted` boolean can force-grant or
--                                              force-revoke relative to that default).
--   app_has_permission(key)                  — the one new SECURITY DEFINER function other
--                                              migrations will additively OR into existing RLS
--                                              policies later. It returns false unconditionally for
--                                              any of the 19 built-in roles (so built-in behavior
--                                              stays governed only by existing hardcoded branches,
--                                              never by this system) and false for any catalog key
--                                              marked non-grantable, regardless of what the
--                                              department_permissions/custom_role_permissions tables
--                                              say — a second, independent enforcement of the same
--                                              "never grantable" rule as the trigger below.
--
-- Nothing in this migration grants a custom role write access to anything existing. No existing
-- RLS policy gains an `app_has_permission(...)` branch here — that is deliberately a separate,
-- later migration per object, reviewed individually.
begin;

-- ----------------------------------------------------------------------------
-- 1. departments
-- ----------------------------------------------------------------------------
create table if not exists public.departments (
  id text primary key,
  label text not null unique,
  is_shared_resource boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.departments enable row level security;

drop policy if exists "departments_select_rls" on public.departments;
create policy "departments_select_rls" on public.departments
for select to authenticated
using (true);

drop policy if exists "departments_insert_rls" on public.departments;
create policy "departments_insert_rls" on public.departments
for insert to authenticated
with check (public.app_user_role() in ('executive', 'head_of_technical'));

drop policy if exists "departments_update_rls" on public.departments;
create policy "departments_update_rls" on public.departments
for update to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical'))
with check (public.app_user_role() in ('executive', 'head_of_technical'));

-- No delete policy/grant: retiring a department sets is_active = false instead, so any
-- custom role or data still referencing it keeps a valid reference.

grant select, insert, update on public.departments to authenticated;
grant all on public.departments to service_role;

-- ----------------------------------------------------------------------------
-- 2. department_member_teams — which users.team values belong to a department (replaces
--    departmentStaffing.ts's COMBINED_DEPARTMENT_TEAMS; for every department except the shared
--    Creative & Design / Video Production pairing, this is just department_id's own single team).
-- ----------------------------------------------------------------------------
create table if not exists public.department_member_teams (
  department_id text not null references public.departments (id),
  team_value text not null,
  primary key (department_id, team_value)
);

alter table public.department_member_teams enable row level security;

drop policy if exists "department_member_teams_select_rls" on public.department_member_teams;
create policy "department_member_teams_select_rls" on public.department_member_teams
for select to authenticated
using (true);

drop policy if exists "department_member_teams_write_rls" on public.department_member_teams;
create policy "department_member_teams_write_rls" on public.department_member_teams
for all to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical'))
with check (public.app_user_role() in ('executive', 'head_of_technical'));

grant select, insert, update, delete on public.department_member_teams to authenticated;
grant all on public.department_member_teams to service_role;

-- ----------------------------------------------------------------------------
-- 3. permission_catalog — the finite, closed set of capabilities. Read-only to `authenticated`:
--    no insert/update/delete policy or grant exists below, so this table can only ever be changed
--    by a migration (service_role), never from the admin UI. grantable = false rows are
--    administrative powers that must never be grantable to a custom role or department — enforced
--    both here (nothing can ever put such a key into department_permissions/custom_role_permissions
--    without tripping the trigger in section 6/7) and again inside app_has_permission() itself.
-- ----------------------------------------------------------------------------
create table if not exists public.permission_catalog (
  key text primary key,
  label text not null,
  grantable boolean not null default true
);

alter table public.permission_catalog enable row level security;

drop policy if exists "permission_catalog_select_rls" on public.permission_catalog;
create policy "permission_catalog_select_rls" on public.permission_catalog
for select to authenticated
using (true);

grant select on public.permission_catalog to authenticated;
grant all on public.permission_catalog to service_role;

-- ----------------------------------------------------------------------------
-- 4. custom_roles — id is the literal value later stored in users.role. The CHECK below is the
--    structural guarantee that a custom role can never be, or collide with, one of the 19
--    built-in roles.
-- ----------------------------------------------------------------------------
create table if not exists public.custom_roles (
  id text primary key,
  english_title text not null,
  arabic_title text,
  portal_title_en text not null,
  portal_slug text not null unique,
  team text,
  department_id text references public.departments (id),
  badge_bg text,
  badge_text text,
  default_module text not null default 'my_work',
  is_active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  constraint custom_roles_id_shape_check check (id ~ '^[a-z][a-z0-9_]{2,40}$'),
  constraint custom_roles_id_not_built_in_check check (
    id not in (
      'executive', 'head_of_technical', 'sales', 'am_team_lead', 'am_agent',
      'media_buying_team_lead', 'media_buying_agent', 'seo_team_lead', 'seo_agent',
      'store_manager', 'seo_content_agent', 'seo_backlink_agent', 'programming_agent',
      'social_media_team_lead', 'social_media_agent', 'graphic_designer', 'video_editor',
      'ai_engineer', 'marketing_manager'
    )
  ),
  constraint custom_roles_default_module_check check (
    default_module in (
      'onboarding', 'service_briefs', 'capacity', 'tasks', 'daily_operations',
      'campaigns', 'reports', 'dashboard', 'my_work', 'employees', 'brief_templates'
    )
  )
);

alter table public.custom_roles enable row level security;

drop policy if exists "custom_roles_select_rls" on public.custom_roles;
create policy "custom_roles_select_rls" on public.custom_roles
for select to authenticated
using (true);

drop policy if exists "custom_roles_insert_rls" on public.custom_roles;
create policy "custom_roles_insert_rls" on public.custom_roles
for insert to authenticated
with check (public.app_user_role() in ('executive', 'head_of_technical'));

drop policy if exists "custom_roles_update_rls" on public.custom_roles;
create policy "custom_roles_update_rls" on public.custom_roles
for update to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical'))
with check (public.app_user_role() in ('executive', 'head_of_technical'));

-- No delete policy/grant: retiring a custom role sets is_active = false instead.

grant select, insert, update on public.custom_roles to authenticated;
grant all on public.custom_roles to service_role;

-- ----------------------------------------------------------------------------
-- 5. custom_role_modules — which AppModuleId values (src/data/roles.ts) a custom role may route
--    to/see in the sidebar, mirroring RoleMetadata.allowedModules for a built-in role.
-- ----------------------------------------------------------------------------
create table if not exists public.custom_role_modules (
  role_id text not null references public.custom_roles (id),
  module_id text not null check (
    module_id in (
      'onboarding', 'service_briefs', 'capacity', 'tasks', 'daily_operations',
      'campaigns', 'reports', 'dashboard', 'my_work', 'employees', 'brief_templates'
    )
  ),
  primary key (role_id, module_id)
);

alter table public.custom_role_modules enable row level security;

drop policy if exists "custom_role_modules_select_rls" on public.custom_role_modules;
create policy "custom_role_modules_select_rls" on public.custom_role_modules
for select to authenticated
using (true);

drop policy if exists "custom_role_modules_write_rls" on public.custom_role_modules;
create policy "custom_role_modules_write_rls" on public.custom_role_modules
for all to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical'))
with check (public.app_user_role() in ('executive', 'head_of_technical'));

grant select, insert, update, delete on public.custom_role_modules to authenticated;
grant all on public.custom_role_modules to service_role;

-- ----------------------------------------------------------------------------
-- 6. department_permissions — a department's default grantable permissions. Presence of a row
--    means that permission is granted by default to every custom role in that department, unless
--    overridden per-role in custom_role_permissions below.
-- ----------------------------------------------------------------------------
create table if not exists public.department_permissions (
  department_id text not null references public.departments (id),
  permission_key text not null references public.permission_catalog (key),
  primary key (department_id, permission_key)
);

alter table public.department_permissions enable row level security;

drop policy if exists "department_permissions_select_rls" on public.department_permissions;
create policy "department_permissions_select_rls" on public.department_permissions
for select to authenticated
using (true);

drop policy if exists "department_permissions_write_rls" on public.department_permissions;
create policy "department_permissions_write_rls" on public.department_permissions
for all to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical'))
with check (public.app_user_role() in ('executive', 'head_of_technical'));

grant select, insert, update, delete on public.department_permissions to authenticated;
grant all on public.department_permissions to service_role;

-- ----------------------------------------------------------------------------
-- 7. custom_role_permissions — per-role override on top of the department default. `granted`
--    lets a row either force-grant (true) a permission the department default doesn't include, or
--    force-revoke (false) one it does.
-- ----------------------------------------------------------------------------
create table if not exists public.custom_role_permissions (
  role_id text not null references public.custom_roles (id),
  permission_key text not null references public.permission_catalog (key),
  granted boolean not null,
  primary key (role_id, permission_key)
);

alter table public.custom_role_permissions enable row level security;

drop policy if exists "custom_role_permissions_select_rls" on public.custom_role_permissions;
create policy "custom_role_permissions_select_rls" on public.custom_role_permissions
for select to authenticated
using (true);

drop policy if exists "custom_role_permissions_write_rls" on public.custom_role_permissions;
create policy "custom_role_permissions_write_rls" on public.custom_role_permissions
for all to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical'))
with check (public.app_user_role() in ('executive', 'head_of_technical'));

grant select, insert, update, delete on public.custom_role_permissions to authenticated;
grant all on public.custom_role_permissions to service_role;

-- ----------------------------------------------------------------------------
-- 8. Guard trigger: reject any department_permissions/custom_role_permissions row whose
--    permission_key is marked non-grantable in the catalog — enforced at the table level so this
--    holds regardless of what the admin UI does or doesn't disable, not merely a UI convention.
-- ----------------------------------------------------------------------------
create or replace function public.reject_non_grantable_permission()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_grantable boolean;
begin
  select grantable into v_grantable from public.permission_catalog where key = new.permission_key;
  if v_grantable is distinct from true then
    raise exception 'Permission "%" is not grantable to a custom role or department.', new.permission_key;
  end if;
  return new;
end;
$$;

revoke execute on function public.reject_non_grantable_permission() from public;

drop trigger if exists department_permissions_grantable_guard on public.department_permissions;
create trigger department_permissions_grantable_guard
before insert or update on public.department_permissions
for each row
execute function public.reject_non_grantable_permission();

drop trigger if exists custom_role_permissions_grantable_guard on public.custom_role_permissions;
create trigger custom_role_permissions_grantable_guard
before insert or update on public.custom_role_permissions
for each row
execute function public.reject_non_grantable_permission();

-- ----------------------------------------------------------------------------
-- 9. app_has_permission(key) — the one new capability-check function. Not yet wired into any
--    existing RLS policy (that is a separate, later migration per policy, reviewed individually).
--    Returns false unconditionally for all 19 built-in roles, and false for any non-grantable key,
--    regardless of what the permission tables contain — a second, independent enforcement of the
--    "never grantable" rule, on top of the trigger in section 8.
-- ----------------------------------------------------------------------------
create or replace function public.app_has_permission(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when public.app_user_role() in (
      'executive', 'head_of_technical', 'sales', 'am_team_lead', 'am_agent',
      'media_buying_team_lead', 'media_buying_agent', 'seo_team_lead', 'seo_agent',
      'store_manager', 'seo_content_agent', 'seo_backlink_agent', 'programming_agent',
      'social_media_team_lead', 'social_media_agent', 'graphic_designer', 'video_editor',
      'ai_engineer', 'marketing_manager'
    ) then false
    when not exists (
      select 1 from public.permission_catalog pc where pc.key = p_key and pc.grantable
    ) then false
    when not exists (
      select 1 from public.custom_roles cr
      where cr.id = public.app_user_role() and cr.is_active
    ) then false
    else coalesce(
      (
        select crp.granted
        from public.custom_role_permissions crp
        where crp.role_id = public.app_user_role() and crp.permission_key = p_key
      ),
      exists (
        select 1
        from public.custom_roles cr
        join public.department_permissions dp on dp.department_id = cr.department_id
        where cr.id = public.app_user_role() and dp.permission_key = p_key
      )
    )
  end;
$$;

revoke all on function public.app_has_permission(text) from public, anon;
grant execute on function public.app_has_permission(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 10. Seed data — a pure data move from src/lib/departmentStaffing.ts's OPERATIONAL_TEAMS array
--     and COMBINED_DEPARTMENT_TEAMS pairing, not a behavior change. Idempotent via ON CONFLICT.
--     Executive/Technical/Sales/Marketing (the 4 non-operational team values used as default
--     `team` values on roles.ts's executive/head_of_technical/sales/marketing_manager entries) are
--     deliberately NOT seeded as departments here, matching OPERATIONAL_TEAMS's own documented
--     exclusion of them as "not staffing-picker targets" — left for a product decision, not
--     assumed by this migration.
--
--     No custom role and no department_permissions rows are seeded — both are empty until an
--     Executive/Head of Technical creates one via the (not-yet-built) admin UI.
-- ----------------------------------------------------------------------------
insert into public.departments (id, label, is_shared_resource) values
  ('seo', 'Search Engine Optimization (SEO)', false),
  ('social_media', 'Social Media', false),
  ('media_buying', 'Media Buying', false),
  ('creative_design', 'Creative & Design', true),
  ('programming', 'Programming', false),
  ('account_management', 'Account Management (AM)', false),
  ('ai_engineering', 'AI Engineering', false)
on conflict (id) do nothing;

insert into public.department_member_teams (department_id, team_value) values
  ('seo', 'SEO'),
  ('social_media', 'Social Media'),
  ('media_buying', 'Media Buying'),
  ('creative_design', 'Creative & Design'),
  ('creative_design', 'Video Production'),
  ('programming', 'Programming'),
  ('account_management', 'Account Management'),
  ('ai_engineering', 'AI Engineering')
on conflict (department_id, team_value) do nothing;

insert into public.permission_catalog (key, label, grantable) values
  ('employees.view_department_peers', 'View employees in my own department', true),
  ('tasks.view_cross_team', 'View tasks across every team', true),
  ('daily_logs.view_department', 'View daily logs for my department', true),
  ('extra_notes.view_department', 'View extra notes for my department', true),
  ('kpi_scores.view_department', 'View KPI scores for my department', true),
  ('users.manage', 'Manage (edit/deactivate) other employees', false),
  ('users.create', 'Add new employees', false),
  ('users.manage_role_team_department', 'Change another user''s role, team, or manager', false),
  ('admin.impersonation', 'Impersonate or test-login as another employee', false),
  ('admin.roles_departments', 'Open the Roles & Departments admin screen', false)
on conflict (key) do nothing;

commit;
