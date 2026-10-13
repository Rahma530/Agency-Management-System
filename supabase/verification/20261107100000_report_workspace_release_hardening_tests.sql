-- Run manually after both report-workspace migrations in a disposable/non-production session.
-- The final exception rolls back the report created by this verification.
do $$
declare
  v_exec_id text; v_exec_auth uuid;
  v_subject_id text;
  v_no_reports_id text; v_no_reports_auth uuid;
  v_client_id text; v_client_responsible text;
  v_report public.reports%rowtype;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  select id,auth_id into v_exec_id,v_exec_auth from public.users
    where role='executive' and auth_id is not null and deactivated_at is null limit 1;
  select id into v_subject_id from public.users
    where auth_id is not null and deactivated_at is null
      and role in ('am_agent','media_buying_agent','seo_agent','store_manager','seo_content_agent','seo_backlink_agent','social_media_agent')
    limit 1;
  select id,auth_id into v_no_reports_id,v_no_reports_auth from public.users
    where auth_id is not null and deactivated_at is null
      and role in ('sales','programming_agent','graphic_designer','video_editor','marketing_manager') limit 1;
  select id,am_agent_id into v_client_id,v_client_responsible from public.clients limit 1;
  if v_exec_id is null or v_subject_id is null or v_no_reports_id is null or v_client_id is null then
    raise exception 'TEST_SETUP_FAILED: executive, subject, no-Reports employee, and client are required.';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims',json_build_object('sub',v_no_reports_auth::text)::text,true);
  if public.report_module_accessible() then raise exception 'TEST_FAILED: no-Reports role passed the module gate.'; end if;
  if public.report_subject_creatable('employee',null,v_no_reports_id) then
    raise exception 'TEST_FAILED: no-Reports role can create a self report.';
  end if;

  perform set_config('request.jwt.claims',json_build_object('sub',v_exec_auth::text)::text,true);
  if not public.report_module_accessible() then raise exception 'TEST_FAILED: executive failed the module gate.'; end if;
  if public.report_subject_creatable('employee',null,v_exec_id) then
    raise exception 'TEST_FAILED: executive was accepted as an employee-report subject.';
  end if;
  begin
    perform public.create_report_draft('client',v_client_id,null,v_exec_id,'2026-10-10','2026-10-17','','Client report 10');
    raise exception 'TEST_FAILED: mismatched responsible employee was accepted.';
  exception when check_violation then null;
  end;

  select * into v_report from public.create_report_draft(
    'employee',null,v_subject_id,v_subject_id,'2026-10-10','2026-10-17','','Verified report 10'
  );
  begin
    perform public.create_report_ai_suggestion(v_report.id,v_report.current_version_id,v_report.source_hash,'Fabricated 999');
    raise exception 'TEST_FAILED: unsupported AI number was accepted.';
  exception when invalid_parameter_value then null;
  end;
  if has_table_privilege('authenticated','public.reports','UPDATE') then
    raise exception 'TEST_FAILED: authenticated still has direct UPDATE on reports.';
  end if;
  if to_regprocedure('public.update_legacy_report_draft(text,text,text,text,text)') is null then
    raise exception 'TEST_FAILED: validated legacy update RPC is missing.';
  end if;

  reset role;
  raise exception 'TEST_OK_ROLLED_BACK: module gate, responsible identity, numeric grounding, and RPC-only updates passed.';
end $$;
