-- Production-safe, read-only verification. Returns one row; every boolean must be true.
select
  to_regprocedure('public.archive_report_v2(text,text,boolean,text)') is not null as rpc_exists,
  has_function_privilege('authenticated', 'public.archive_report_v2(text,text,boolean,text)', 'EXECUTE') as authenticated_can_execute,
  not has_function_privilege('anon', 'public.archive_report_v2(text,text,boolean,text)', 'EXECUTE') as anon_cannot_execute,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'reports'
      and column_name = 'archive_reason' and is_nullable = 'YES'
  ) as archive_reason_is_nullable,
  position('report_row_editable' in pg_get_functiondef('public.archive_report_v2(text,text,boolean,text)'::regprocedure)) > 0 as authorization_preserved,
  position('for update' in lower(pg_get_functiondef('public.archive_report_v2(text,text,boolean,text)'::regprocedure))) > 0 as row_lock_preserved,
  position('current_version_id is distinct from p_expected_version_id' in pg_get_functiondef('public.archive_report_v2(text,text,boolean,text)'::regprocedure)) > 0 as concurrency_preserved,
  position('Archive reason is required' in pg_get_functiondef('public.archive_report_v2(text,text,boolean,text)'::regprocedure)) = 0 as empty_reason_is_supported;
