-- Rollback for 20261218000000_screens_realtime_batch3.sql — removes this batch's tables from
-- the supabase_realtime publication. Each matching App.tsx subscription falls back to its 9s
-- poll automatically; nothing else needs to change.
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
    if exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end
$migration$;

commit;
