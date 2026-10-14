-- Production-safe, read-only preflight. Run before migration 073 and require every prerequisite
-- column below to be true. lifecycle_already_applied may be either false (normal) or true (stop
-- and investigate rather than re-running blindly).
select
  to_regclass('public.reports') is not null as reports_exists,
  to_regclass('public.report_content_versions') is not null as versions_exists,
  to_regclass('public.report_source_items') is not null as sources_exists,
  to_regclass('public.report_ai_suggestions') is not null as suggestions_exists,
  to_regclass('public.report_audit_events') is not null as audit_exists,
  to_regprocedure('public.create_report_draft(text,text,text,text,date,date,text,text)') is not null as base_create_rpc_exists,
  to_regprocedure('public.update_legacy_report_draft(text,text,text,text,text)') is not null as release_hardening_exists,
  to_regprocedure('public.report_task_work_kind(text)') is not null as task_source_hardening_exists,
  to_regprocedure('public.task_visible_v2(text)') is not null as task_visibility_exists,
  to_regclass('public.task_assignees') is not null as task_assignees_exists,
  (select relrowsecurity from pg_class where oid='public.reports'::regclass) as reports_rls_enabled,
  (select relrowsecurity from pg_class where oid='public.report_source_items'::regclass) as sources_rls_enabled,
  to_regprocedure('public.create_report_draft_v2(text,text,text,text,text,text[],date,date,text,text,text,text)') is not null as lifecycle_already_applied,
  not exists (
    select 1
    from unnest(array['anon','authenticated']) as r(role_name)
    cross join unnest(array['reports','report_content_versions','report_source_items','report_ai_suggestions',
      'report_audit_events']) as t(table_name)
    where has_table_privilege(role_name,'public.'||table_name,'INSERT')
      or has_table_privilege(role_name,'public.'||table_name,'UPDATE')
      or has_table_privilege(role_name,'public.'||table_name,'DELETE')
      or has_any_column_privilege(role_name,'public.'||table_name,'INSERT')
      or has_any_column_privilege(role_name,'public.'||table_name,'UPDATE')
  ) as direct_write_lockdown_already_applied;

select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as signature,
  p.prosecdef as security_definer,
  p.proconfig as function_config
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (
  'create_report_draft','save_report_version','archive_report','approve_report',
  'create_report_ai_suggestion','apply_report_ai_suggestion','update_legacy_report_draft',
  'report_scope_accessible','report_subject_creatable','report_task_work_kind','task_visible_v2',
  'preview_report_sources_v2','create_report_draft_v2','save_report_version_v2',
  'archive_report_v2','approve_report_v2','delete_report_permanently'
)
order by p.proname,signature;

select policyname,cmd,roles,qual,with_check from pg_policies
where schemaname='public' and tablename in ('reports','report_content_versions','report_source_items','report_ai_suggestions','report_audit_events','report_deletion_tombstones')
order by tablename,policyname;

select grantee,privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name='reports' and grantee in ('anon','authenticated')
order by grantee,privilege_type;
