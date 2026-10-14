-- Production-safe, read-only final verification. Run after migration 074; this file performs no writes.
do $$
declare v_portal_qual text; v_definition text; v_signature text;
begin
  if to_regprocedure('public.preview_report_sources_v2(text,text,text,text,text[],date,date)') is null
    or to_regprocedure('public.create_report_draft_v2(text,text,text,text,text,text[],date,date,text,text,text,text)') is null
    or to_regprocedure('public.save_report_version_v2(text,text,text,text)') is null
    or to_regprocedure('public.archive_report_v2(text,text,boolean,text)') is null
    or to_regprocedure('public.approve_report_v2(text,text)') is null
    or to_regprocedure('public.delete_report_permanently(text,timestamptz,text)') is null then
    raise exception 'Report Workspace lifecycle RPC signatures are missing.';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='reports' and column_name='employee_scope_mode')
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='reports' and column_name='employee_scope_client_ids')
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='reports' and column_name='creation_key')
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='report_deletion_tombstones' and column_name='content_hash') then
    raise exception 'Report scope/idempotency or tombstone metadata is incomplete.';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.report_deletion_tombstones'::regclass) then raise exception 'Deletion tombstone RLS is disabled.'; end if;
  if exists (
    select 1
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('report_source_manifest_v2','preview_report_sources_v2','create_report_draft_v2',
        'save_report_version_v2','archive_report_v2','approve_report_v2','delete_report_permanently')
      and (not p.prosecdef or not coalesce(p.proconfig,array[]::text[]) @> array['search_path=public, pg_temp'])
  ) then raise exception 'A lifecycle RPC is not SECURITY DEFINER with a fixed search_path.'; end if;
  select qual into v_portal_qual from pg_policies where schemaname='public' and tablename='reports' and policyname='reports_select_portal_rls';
  if v_portal_qual is null or v_portal_qual not ilike '%portal_client_id%' or v_portal_qual not ilike '%status%final%'
    or v_portal_qual not ilike '%archived_at%IS NULL%' or v_portal_qual not ilike '%type%client%' then
    raise exception 'Client portal report policy is not client-bound, final-and-active only.';
  end if;
  if exists (
    select 1
    from unnest(array['anon','authenticated']) as r(role_name)
    cross join unnest(array['reports','report_content_versions','report_source_items','report_ai_suggestions',
      'report_audit_events','report_deletion_tombstones']) as t(table_name)
    where has_table_privilege(role_name,'public.'||table_name,'INSERT')
      or has_table_privilege(role_name,'public.'||table_name,'UPDATE')
      or has_table_privilege(role_name,'public.'||table_name,'DELETE')
      or has_any_column_privilege(role_name,'public.'||table_name,'INSERT')
      or has_any_column_privilege(role_name,'public.'||table_name,'UPDATE')
  ) then raise exception 'A browser role still has an effective direct report-table write privilege.'; end if;
  foreach v_signature in array array[
    'public.preview_report_sources_v2(text,text,text,text,text[],date,date)',
    'public.create_report_draft_v2(text,text,text,text,text,text[],date,date,text,text,text,text)',
    'public.save_report_version_v2(text,text,text,text)',
    'public.archive_report_v2(text,text,boolean,text)',
    'public.approve_report_v2(text,text)',
    'public.delete_report_permanently(text,timestamptz,text)',
    'public.create_report_draft(text,text,text,text,date,date,text,text)',
    'public.save_report_version(text,text,text)',
    'public.archive_report(text,text,boolean)',
    'public.approve_report(text)',
    'public.create_report_ai_suggestion(text,text,text,text)',
    'public.apply_report_ai_suggestion(text)',
    'public.update_legacy_report_draft(text,text,text,text,text)'
  ] loop
    if has_function_privilege('anon',v_signature,'EXECUTE')
      or not has_function_privilege('authenticated',v_signature,'EXECUTE') then
      raise exception 'RPC grant is unsafe or incomplete: %',v_signature;
    end if;
  end loop;
  if has_function_privilege('anon','public.report_source_manifest_v2(text,text,text,text,text[],date,date)','EXECUTE')
    or has_function_privilege('authenticated','public.report_source_manifest_v2(text,text,text,text,text[],date,date)','EXECUTE') then
    raise exception 'Internal source-manifest helper is directly executable by a browser role.';
  end if;
  select pg_get_functiondef('public.report_scope_accessible(text,text)'::regprocedure) into v_definition;
  if v_definition not ilike '%custom_role_modules%' or v_definition not ilike '%module_id%reports%'
    or v_definition not ilike '%join public.assignments%agent_id%app_user_id()%client_id%p_client_id%' then
    raise exception 'Custom-role report access is not limited to explicit Reports permission and client assignment.';
  end if;
  select pg_get_functiondef('public.report_subject_creatable(text,text,text)'::regprocedure) into v_definition;
  if v_definition not ilike '%report_module_accessible%' or v_definition not ilike '%v_role = ''ai_engineer''%return false%'
    or v_definition not ilike '%report_role_is_subject%' then
    raise exception 'Report subject authorization or AI Engineer scope is not hardened.';
  end if;
  select pg_get_functiondef('public.create_report_draft_v2(text,text,text,text,text,text[],date,date,text,text,text,text)'::regprocedure) into v_definition;
  if v_definition not ilike '%report_subject_creatable%' or v_definition not ilike '%report_source_manifest_v2%'
    or v_definition not ilike '%expected_source_hash%' or v_definition not ilike '%creation_key%'
    or v_definition not ilike '%responsible employee mismatch%' then
    raise exception 'Draft creation authorization, source hash, responsibility, or idempotency guards are missing.';
  end if;
  select pg_get_functiondef('public.create_report_draft(text,text,text,text,date,date,text,text)'::regprocedure) into v_definition;
  if v_definition not ilike '%create_report_draft_v2%' or v_definition not ilike '%employee_overall%'
    or v_definition not ilike '%legacy-%md5%concat_ws%' then raise exception 'Legacy draft creation is not hardened or idempotent.'; end if;
  select pg_get_functiondef('public.save_report_version_v2(text,text,text,text)'::regprocedure) into v_definition;
  if v_definition not ilike '%status=''final''%' or v_definition not ilike '%for update%' or v_definition not ilike '%expected_version_id%' then
    raise exception 'Version-save final/locking/concurrency guards are missing.';
  end if;
  select pg_get_functiondef('public.archive_report_v2(text,text,boolean,text)'::regprocedure) into v_definition;
  if v_definition not ilike '%for update%' or v_definition not ilike '%expected_version_id%'
    or v_definition not ilike '%archive reason is required%' then raise exception 'Archive/restore locking, concurrency, or reason guard is missing.'; end if;
  select pg_get_functiondef('public.approve_report_v2(text,text)'::regprocedure) into v_definition;
  if v_definition not ilike '%for update%' or v_definition not ilike '%expected_version_id%'
    or v_definition not ilike '%current_version_id is null%' then raise exception 'Approval locking, concurrency, or version guard is missing.'; end if;
  select pg_get_functiondef('public.create_report_ai_suggestion(text,text,text,text)'::regprocedure) into v_definition;
  if v_definition not ilike '%for update%' or v_definition not ilike '%status=''final''%'
    or v_definition not ilike '%source_hash is distinct from%' then raise exception 'AI suggestion final-state or grounding guard is missing.'; end if;
  select pg_get_functiondef('public.apply_report_ai_suggestion(text)'::regprocedure) into v_definition;
  if v_definition not ilike '%for update%' or v_definition not ilike '%status=''final''%'
    or v_definition not ilike '%suggestion is stale%' then raise exception 'AI apply final-state or stale-version guard is missing.'; end if;
  select pg_get_functiondef('public.update_legacy_report_draft(text,text,text,text,text)'::regprocedure) into v_definition;
  if v_definition not ilike '%for update%' or v_definition not ilike '%status=''final''%'
    or v_definition not ilike '%comparison_scope_accessible%' then raise exception 'Legacy update locking, final-state, or scope guard is missing.'; end if;
  select pg_get_functiondef('public.delete_report_permanently(text,timestamptz,text)'::regprocedure) into v_definition;
  if v_definition not ilike '%head_of_technical%' or v_definition not ilike '%archived_at is null%' or v_definition not ilike '%for update%'
    or v_definition not ilike '%content_hash%' or v_definition not ilike '%audit_snapshot%' then
    raise exception 'Permanent-delete authorization, state, locking, or tombstone evidence is incomplete.';
  end if;
  raise notice 'TEST_OK_READ_ONLY: signatures, metadata, RLS, grants, legacy routing, final guards, locking, portal policy, and tombstone evidence passed.';
end $$;
