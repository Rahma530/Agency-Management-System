-- Adds an optional, admin-editable "Task Type" to tasks, scoped to either a team or a role.
--
-- public.task_types: the reference list of selectable types. Each row is scoped either to a
-- team (scope_type='team', scope_value one of the OPERATIONAL_TEAMS values, e.g. 'SEO') or to a
-- role (scope_type='role', scope_value a UserRole literal, e.g. 'graphic_designer'). is_other rows
-- render as a free-text fallback on the frontend instead of a fixed label. sort_order controls
-- display order within a given scope_type+scope_value group. is_active lets a type be retired
-- without breaking historical tasks that already reference it (no DELETE policy exists below —
-- retiring a type is always a deactivation, never a delete).
--
-- Write access (insert/update) is restricted to executive and head_of_technical, mirroring the
-- role gate already used for other admin-only reference data in this schema (e.g. the
-- leadership-only writes seen in 20261031100000_leadership_assignment_insert_access.sql). Read
-- access is open to every authenticated user, same as brief_field_schemas, since any employee
-- filling out or viewing a task needs to see the current type list.
--
-- Default privileges no longer auto-grant on new tables in this schema (see
-- 20261030300000_revoke_excess_privileges.sql, item 5a) — so unlike older tables in this history,
-- this table needs its privileges granted explicitly rather than relying on any implicit default:
-- select/insert/update to authenticated (RLS still applies on top of this), and all to
-- service_role. No delete grant anywhere, matching the "no DELETE" requirement.
--
-- public.tasks gets two new nullable columns, task_type and task_type_other, so a task can record
-- which task_types.id it was tagged with (or, for an is_other selection, free text instead).
-- These are plain nullable text columns added to an existing table — confirmed above that tasks
-- has no column-level grants at all (only the one table-level `grant select, insert, update on
-- public.tasks to authenticated` from canonical_schema_v4), so there is nothing column-level to
-- extend here, and this migration does not touch tasks' RLS policies in any way.
begin;

-- ----------------------------------------------------------------------------
-- 1. public.task_types
-- ----------------------------------------------------------------------------
create table public.task_types (
  id text primary key,
  scope_type text not null,
  scope_value text not null,
  label text not null,
  is_other boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.task_types add constraint task_types_scope_type_check
  check (scope_type in ('team', 'role'));
alter table public.task_types add constraint task_types_unique_scope_label
  unique (scope_type, scope_value, label);

create index idx_task_types_scope on public.task_types (scope_type, scope_value, sort_order);

alter table public.task_types enable row level security;

create policy "task_types_select_rls" on public.task_types
for select to authenticated
using (true);

create policy "task_types_write_rls" on public.task_types
for insert to authenticated
with check (public.app_user_role() in ('executive', 'head_of_technical'));

create policy "task_types_update_rls" on public.task_types
for update to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical'))
with check (public.app_user_role() in ('executive', 'head_of_technical'));

-- No delete policy: rows are deactivated (is_active = false) rather than removed, so that tasks
-- already referencing a retired type keep a valid reference.

grant select, insert, update on public.task_types to authenticated;
grant all on public.task_types to service_role;

-- ----------------------------------------------------------------------------
-- 2. public.tasks — two new nullable columns, no RLS or grant changes
-- ----------------------------------------------------------------------------
alter table public.tasks add column if not exists task_type text;
alter table public.tasks add column if not exists task_type_other text;

-- ----------------------------------------------------------------------------
-- 3. Seed data (idempotent via the unique(scope_type, scope_value, label) constraint above)
-- ----------------------------------------------------------------------------
insert into public.task_types (id, scope_type, scope_value, label, is_other, sort_order)
values
  ('tt-team-seo-1', 'team', 'SEO', 'رفع صور المنتجات', false, 0),
  ('tt-team-seo-2', 'team', 'SEO', 'ربط المنتجات بالمتجر', false, 1),
  ('tt-team-seo-3', 'team', 'SEO', 'تعديل أسعار المنتجات', false, 2),
  ('tt-team-seo-4', 'team', 'SEO', 'تطبيق العروض و الخصومات', false, 3),
  ('tt-team-seo-5', 'team', 'SEO', 'ربط منصات Social Media', false, 4),
  ('tt-team-seo-other', 'team', 'SEO', 'Other', true, 5),

  ('tt-role-gd-1', 'role', 'graphic_designer', 'Social Media Post', false, 0),
  ('tt-role-gd-2', 'role', 'graphic_designer', 'Social Media Story', false, 1),
  ('tt-role-gd-3', 'role', 'graphic_designer', 'logo', false, 2),
  ('tt-role-gd-4', 'role', 'graphic_designer', 'Identity', false, 3),
  ('tt-role-gd-5', 'role', 'graphic_designer', 'Banners', false, 4),
  ('tt-role-gd-6', 'role', 'graphic_designer', 'صور منتجات المتجر', false, 5),
  ('tt-role-gd-other', 'role', 'graphic_designer', 'Other', true, 6),

  ('tt-role-pa-1', 'role', 'programming_agent', 'تطبيق واجهة المتجر', false, 0),
  ('tt-role-pa-2', 'role', 'programming_agent', 'Coding', false, 1)
on conflict (scope_type, scope_value, label) do nothing;

commit;
