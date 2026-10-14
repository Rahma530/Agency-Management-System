-- DISPOSABLE/TEST DATABASE ONLY. The final TEST_OK_ROLLED_BACK exception rolls back every write
-- made by this single DO statement. Never run this behavior test in Production.
do $$
declare
  v_exec_id text; v_exec_auth uuid; v_subject_id text; v_subject_auth uuid;
  v_client_a text; v_client_b text; v_suffix text:=substr(replace(gen_random_uuid()::text,'-',''),1,10);
  v_log_a text; v_log_b text; v_task_other text; v_manifest jsonb;
  v_report public.reports%rowtype; v_same public.reports%rowtype; v_version public.report_content_versions%rowtype;
  v_tomb public.report_deletion_tombstones%rowtype; v_count integer;
begin
  reset role; perform set_config('request.jwt.claims','',true);
  select id,auth_id into v_exec_id,v_exec_auth from public.users where role='executive' and auth_id is not null and deactivated_at is null limit 1;
  select id,auth_id into v_subject_id,v_subject_auth from public.users where role='am_agent' and auth_id is not null and deactivated_at is null limit 1;
  select id into v_client_a from public.clients order by id limit 1;
  select id into v_client_b from public.clients where id<>v_client_a order by id limit 1;
  if v_exec_id is null or v_subject_id is null or v_client_a is null or v_client_b is null then raise exception 'TEST_SETUP_FAILED: executive, AM agent, and two clients are required.'; end if;
  v_log_a:='verify-rws-a-'||v_suffix; v_log_b:='verify-rws-b-'||v_suffix; v_task_other:='verify-rws-task-'||v_suffix;
  insert into public.tasks(id,client_id,title,description,assigned_to,created_by,team,status,due_date,priority)
    values(v_task_other,v_client_b,'Other-client linked task','Must not cross selected-client scope',v_subject_id,v_exec_id,'Account Management','in_progress','2026-10-15','medium');
  insert into public.daily_logs(id,user_id,date,summary_text,client_id,linked_task_ids) values
    (v_log_a,v_subject_id,'2026-10-12','Selected client evidence 12',v_client_a,array[v_task_other]),
    (v_log_b,v_subject_id,'2026-10-13','Other client evidence 13',v_client_b,array[]::text[]);
  insert into public.extra_notes(id,user_id,date,note_text,category) values('verify-rws-note-'||v_suffix,v_subject_id,'2026-10-14','Overall-only employee note','verification');
  set local role authenticated;
  perform set_config('request.jwt.claims',json_build_object('sub',v_exec_auth::text)::text,true);
  v_manifest:=public.preview_report_sources_v2('employee',null,v_subject_id,'selected_clients',array[v_client_a],'2026-10-10','2026-10-17');
  if (v_manifest->>'source_count')::integer<>1 then raise exception 'TEST_FAILED: selected-client manifest leaked another source.'; end if;
  if exists(select 1 from jsonb_array_elements(v_manifest->'sources') s where s->>'source_id' in (v_log_b,v_task_other)) then raise exception 'TEST_FAILED: cross-client log/task leaked.'; end if;
  begin
    perform public.create_report_draft_v2('employee',null,v_subject_id,v_subject_id,'selected_clients',array[v_client_a],
      '2026-10-10','2026-10-17','','Initial 12','stale-hash','verify-key-'||v_suffix);
    raise exception 'TEST_FAILED: stale preview hash was accepted.';
  exception when serialization_failure then null; end;
  select * into v_report from public.create_report_draft_v2('employee',null,v_subject_id,v_subject_id,'selected_clients',array[v_client_a],
    '2026-10-10','2026-10-17','','Initial 12',v_manifest->>'source_hash','verify-key-'||v_suffix);
  select * into v_same from public.create_report_draft_v2('employee',null,v_subject_id,v_subject_id,'selected_clients',array[v_client_a],
    '2026-10-10','2026-10-17','','Initial 12',v_manifest->>'source_hash','verify-key-'||v_suffix);
  if v_same.id<>v_report.id then raise exception 'TEST_FAILED: idempotent retry duplicated a report.'; end if;
  begin perform public.save_report_version_v2(v_report.id,'Wrong expected version','manual','missing-version'); raise exception 'TEST_FAILED: stale save was accepted.';
  exception when serialization_failure then null; end;
  select * into v_version from public.save_report_version_v2(v_report.id,'Saved version 12','manual',v_report.current_version_id);
  begin perform public.approve_report_v2(v_report.id,'missing-version'); raise exception 'TEST_FAILED: stale approval was accepted.';
  exception when serialization_failure then null; end;
  select * into v_report from public.approve_report_v2(v_report.id,v_version.id);
  begin perform public.save_report_version_v2(v_report.id,'Final mutation','manual',v_report.current_version_id); raise exception 'TEST_FAILED: final report was editable.';
  exception when object_not_in_prerequisite_state then null; end;
  begin perform public.create_report_ai_suggestion(v_report.id,v_report.current_version_id,v_report.source_hash,'Final rewrite 12'); raise exception 'TEST_FAILED: final report accepted AI rewrite.';
  exception when object_not_in_prerequisite_state then null; end;
  begin perform public.archive_report_v2(v_report.id,'',false,v_report.current_version_id); raise exception 'TEST_FAILED: empty archive reason was accepted.';
  exception when invalid_parameter_value then null; end;
  select * into v_report from public.archive_report_v2(v_report.id,'verification archive',false,v_report.current_version_id);
  select count(*) into v_count from public.report_content_versions where report_id=v_report.id;
  if v_count<>2 then raise exception 'TEST_FAILED: archive did not preserve versions.'; end if;
  perform set_config('request.jwt.claims',json_build_object('sub',v_subject_auth::text)::text,true);
  begin perform public.delete_report_permanently(v_report.id,v_report.updated_at,'unauthorized delete'); raise exception 'TEST_FAILED: ordinary agent deleted a report.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',json_build_object('sub',v_exec_auth::text)::text,true);
  begin perform public.delete_report_permanently(v_report.id,v_report.updated_at-interval '1 second','stale delete'); raise exception 'TEST_FAILED: stale delete was accepted.';
  exception when serialization_failure then null; end;
  select * into v_tomb from public.delete_report_permanently(v_report.id,v_report.updated_at,'verified permanent delete');
  if v_tomb.content_hash is null or v_tomb.source_hash is null or v_tomb.version_count<>2 or v_tomb.source_count<>1
    or jsonb_array_length(v_tomb.audit_snapshot)<3 then raise exception 'TEST_FAILED: deletion tombstone evidence is incomplete.'; end if;
  if exists(select 1 from public.reports where id=v_report.id) or exists(select 1 from public.report_content_versions where report_id=v_report.id)
    or exists(select 1 from public.report_source_items where report_id=v_report.id) then raise exception 'TEST_FAILED: permanent deletion left report-owned rows.'; end if;
  reset role;
  raise exception 'TEST_OK_ROLLED_BACK: scope isolation, stale-preview rejection, idempotency, concurrency, final immutability, archive preservation, delete authorization, atomic cleanup, and tombstone evidence passed.';
end $$;
