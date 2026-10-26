-- Enables Supabase Realtime (postgres_changes) on the third and (for now) final batch of
-- tables, finishing the real-time rollout started with 20261216000000_tasks_realtime.sql
-- (Task Board pilot) and continued in 20261217000000_screens_realtime_batch2.sql. This batch
-- covers: task sub-records (task_types, platforms, task_comments, task_attachments,
-- task_assignees, task_platform_links), the Reporting Engine's remaining insight feeds
-- (social_insights, seo_insights, client_comparisons), client-portal/brief support tables
-- (client_portal_users, brief_revisions, brief_field_schemas, brief_attachments,
-- platform_connections, client_lifecycle_periods), and the custom-roles/departments
-- permissions bundle (departments, custom_roles, custom_role_modules,
-- custom_role_permissions, department_permissions, department_member_teams).
--
-- Each app-side subscription (App.tsx's useSupabaseRealtimeSync calls) degrades to its own 9s
-- poll fallback until this is run, so nothing breaks in the meantime — it just isn't instant yet.
begin;

do $migration$
declare
  t text;
begin
  foreach t in array array[
    'task_types',
    'platforms',
    'task_comments',
    'task_attachments',
    'task_assignees',
    'task_platform_links',
    'social_insights',
    'seo_insights',
    'client_comparisons',
    'client_portal_users',
    'brief_revisions',
    'brief_field_schemas',
    'brief_attachments',
    'platform_connections',
    'client_lifecycle_periods',
    'departments',
    'custom_roles',
    'custom_role_modules',
    'custom_role_permissions',
    'department_permissions',
    'department_member_teams'
  ]
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$migration$;

commit;
