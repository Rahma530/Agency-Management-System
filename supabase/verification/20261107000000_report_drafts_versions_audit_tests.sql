-- Run manually after 20261107000000_report_drafts_versions_audit.sql in a non-production
-- verification session. The final exception rolls back every fabricated row.
do $$
declare
  v_exec_id text; v_exec_auth uuid;
  v_ai_id text; v_ai_auth uuid;
  v_agent_id text; v_agent_auth uuid;
  v_other_id text;
  v_client_id text;
  v_report public.reports%rowtype;
  v_version public.report_content_versions%rowtype;
  v_suggestion public.report_ai_suggestions%rowtype;
  v_count integer;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  select id,auth_id into v_exec_id,v_exec_auth from public.users where role='executive' and auth_id is not null and deactivated_at is null limit 1;
  select id,auth_id into v_ai_id,v_ai_auth from public.users where role='ai_engineer' and auth_id is not null and deactivated_at is null limit 1;
  select id,auth_id into v_agent_id,v_agent_auth from public.users where role='am_agent' and auth_id is not null and deactivated_at is null limit 1;
  select id into v_other_id from public.users where id<>v_agent_id and auth_id is not null and deactivated_at is null and role not like '%team_lead' limit 1;
  select id into v_client_id from public.clients limit 1;
  if v_exec_id is null or v_ai_id is null or v_agent_id is null or v_other_id is null or v_client_id is null then
    raise exception 'TEST_SETUP_FAILED: executive, ai_engineer, am_agent, another active employee, and client are required.';
  end if;

  insert into public.daily_logs(id,user_id,date,summary_text,client_id) values
    ('verify-report-sat',v_agent_id,'2026-10-10','Saturday verified work',v_client_id),
    ('verify-report-fri',v_agent_id,'2026-10-16','Friday must be excluded',v_client_id);
  insert into public.extra_notes(id,user_id,date,note_text,category) values
    ('verify-report-note',v_agent_id,'2026-10-12','Employee-only context','verification');

  set local role authenticated;
  perform set_config('request.jwt.claims',json_build_object('sub',v_agent_auth::text)::text,true);
  if not public.report_subject_creatable('employee',null,v_agent_id) then raise exception 'TEST_FAILED: self employee report denied.'; end if;
  if public.report_subject_creatable('employee',null,v_other_id) then raise exception 'TEST_FAILED: ordinary agent can create another employee report.'; end if;
  select * into v_report from public.create_report_draft('employee',null,v_agent_id,v_agent_id,'2026-10-10','2026-10-17','Original note','Initial text 10');
  select count(*) into v_count from public.report_source_items where report_id=v_report.id;
  if v_count<>2 then raise exception 'TEST_FAILED: expected Saturday daily log plus employee note only, got %.',v_count; end if;

  select * into v_version from public.save_report_version(v_report.id,'Manual version 10','manual');
  if v_version.version_no<>2 then raise exception 'TEST_FAILED: manual version number is %.',v_version.version_no; end if;
  select * into v_suggestion from public.create_report_ai_suggestion(v_report.id,v_version.id,v_report.source_hash,'Suggested 10');
  perform public.save_report_version(v_report.id,'Newer manual version 10','manual');
  begin
    perform public.apply_report_ai_suggestion(v_suggestion.id);
    raise exception 'TEST_FAILED: stale AI suggestion was applied.';
  exception when serialization_failure then null;
  end;
  select * into v_report from public.archive_report(v_report.id,'verification',false);
  if v_report.archived_at is null then raise exception 'TEST_FAILED: report was not archived.'; end if;
  select count(*) into v_count from public.report_content_versions where report_id=v_report.id;
  if v_count<3 then raise exception 'TEST_FAILED: archive lost version history.'; end if;

  perform set_config('request.jwt.claims',json_build_object('sub',v_ai_auth::text)::text,true);
  if public.report_subject_creatable('employee',null,v_other_id) then raise exception 'TEST_FAILED: AI engineer received create-on-behalf access.'; end if;
  perform set_config('request.jwt.claims',json_build_object('sub',v_exec_auth::text)::text,true);
  if not public.report_subject_creatable('employee',null,v_other_id) then raise exception 'TEST_FAILED: executive create-on-behalf access denied.'; end if;

  reset role;
  raise exception 'TEST_OK_ROLLED_BACK: report scope, Friday exclusion, versioning, stale AI rejection, archive preservation, and AI Engineer restriction passed.';
end $$;
