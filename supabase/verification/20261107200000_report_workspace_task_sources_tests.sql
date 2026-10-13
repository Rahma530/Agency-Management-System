-- Run after all three Report Workspace migrations in a disposable/non-production database.
-- The final exception intentionally rolls back every fabricated row in this DO statement.
do $$
declare
  v_exec_id text; v_exec_auth uuid;
  v_creative_id text;
  v_other_id text;
  v_lead_id text; v_lead_auth uuid;
  v_client_id text; v_client_responsible text;
  v_shared_department_id text;
  v_custom_role_id text := 'verify_creative_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  v_report public.reports%rowtype;
  v_client_report public.reports%rowtype;
  v_count integer;
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  select id,auth_id into v_exec_id,v_exec_auth from public.users
    where role='executive' and auth_id is not null and deactivated_at is null limit 1;
  select id into v_creative_id from public.users
    where role in ('graphic_designer','video_editor') and auth_id is not null and deactivated_at is null limit 1;
  select id into v_other_id from public.users
    where id is distinct from v_creative_id and auth_id is not null and deactivated_at is null limit 1;
  select id,auth_id into v_lead_id,v_lead_auth from public.users
    where role='am_team_lead' and auth_id is not null and deactivated_at is null limit 1;
  select id,am_agent_id into v_client_id,v_client_responsible from public.clients limit 1;
  select id into v_shared_department_id from public.departments
    where is_active and is_shared_resource order by sort_order,id limit 1;
  if v_exec_id is null or v_creative_id is null or v_other_id is null or v_lead_id is null
    or v_client_id is null or v_shared_department_id is null then
    raise exception 'TEST_SETUP_FAILED: executive, Creative employee, AM lead, another employee, client, and shared department are required.';
  end if;

  insert into public.custom_roles(id,english_title,portal_title_en,portal_slug,department_id,default_module,is_active)
  values(v_custom_role_id,'Verification Creative','Verification Creative',v_custom_role_id,v_shared_department_id,'my_work',true);
  if not public.report_role_is_subject(v_custom_role_id) then
    raise exception 'TEST_FAILED: shared-resource custom role is not a report subject.';
  end if;
  if public.report_role_has_module(v_custom_role_id) then
    raise exception 'TEST_FAILED: subject eligibility incorrectly granted Reports module access.';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.report_source_items'::regclass) then
    raise exception 'TEST_FAILED: report_source_items RLS is disabled.';
  end if;
  if has_any_column_privilege('authenticated','public.report_source_items','INSERT')
    or has_any_column_privilege('authenticated','public.report_source_items','UPDATE') then
    raise exception 'TEST_FAILED: authenticated received direct report-source write access.';
  end if;

  insert into public.tasks(id,client_id,title,description,assigned_to,created_by,team,status,due_date,priority,completed_at,task_type_other)
  values
    ('verify-rws-design',v_client_id,'Homepage banner design','Graphic design delivery',v_creative_id,v_exec_id,'Creative & Design','completed','2026-10-17','medium','2026-10-14T10:00:00Z','Graphic design'),
    ('verify-rws-video',v_client_id,'Product reel','Video montage',v_other_id,v_exec_id,'Video Production','in_progress','2026-10-17','medium',null,'Video editing'),
    ('verify-rws-assigned-only',v_client_id,'Assigned poster','Graphic design',v_creative_id,v_exec_id,'Creative & Design','completed','2026-10-17','medium','2026-10-14T11:00:00Z','Graphic design'),
    ('verify-rws-other-user',v_client_id,'Other employee poster','Graphic design',v_other_id,v_exec_id,'Creative & Design','completed','2026-10-17','medium','2026-10-14T12:00:00Z','Graphic design'),
    ('verify-rws-friday',v_client_id,'Friday reel','Video editing',v_creative_id,v_exec_id,'Video Production','completed','2026-10-17','medium','2026-10-16T12:00:00Z','Video editing');

  insert into public.daily_logs(id,user_id,date,summary_text,client_id,linked_task_ids)
  values
    ('verify-rws-log-design',v_creative_id,'2026-10-10','Worked on the homepage banner',v_client_id,array['verify-rws-design']),
    ('verify-rws-log-video',v_creative_id,'2026-10-12','Worked on the product reel',v_client_id,array['verify-rws-video']),
    ('verify-rws-log-friday',v_creative_id,'2026-10-16','Friday work must be excluded',v_client_id,array['verify-rws-friday']),
    ('verify-rws-log-other',v_other_id,'2026-10-12','Other employee work',v_client_id,array['verify-rws-other-user']);
  insert into public.extra_notes(id,user_id,date,note_text,category)
  values('verify-rws-note',v_creative_id,'2026-10-12','Employee-only context','verification');

  set local role authenticated;
  perform set_config('request.jwt.claims',json_build_object('sub',v_lead_auth::text)::text,true);
  if public.report_subject_creatable('employee',null,v_creative_id) then
    raise exception 'TEST_FAILED: AM Team Lead scope was widened to Creative.';
  end if;

  perform set_config('request.jwt.claims',json_build_object('sub',v_exec_auth::text)::text,true);
  if not public.report_subject_creatable('employee',null,v_creative_id) then
    raise exception 'TEST_FAILED: Executive cannot create a Creative employee report.';
  end if;
  select * into v_report from public.create_report_draft(
    'employee',null,v_creative_id,v_creative_id,'2026-10-10','2026-10-17','','Verified Creative report'
  );

  select count(*) into v_count from public.report_source_items
    where report_id=v_report.id and source_kind='daily_log';
  if v_count<>2 then raise exception 'TEST_FAILED: expected 2 eligible Creative daily logs, got %.',v_count; end if;
  select count(*) into v_count from public.report_source_items
    where report_id=v_report.id and source_kind='extra_note';
  if v_count<>1 then raise exception 'TEST_FAILED: expected 1 employee note, got %.',v_count; end if;
  select count(*) into v_count from public.report_source_items
    where report_id=v_report.id and source_kind='task';
  if v_count<>2 then raise exception 'TEST_FAILED: expected 2 evidenced tasks, got %.',v_count; end if;
  if exists (
    select 1 from public.report_source_items
    where report_id=v_report.id and source_id in ('verify-rws-assigned-only','verify-rws-other-user','verify-rws-friday')
  ) then
    raise exception 'TEST_FAILED: assigned-only, other-user, or Friday task leaked into the report.';
  end if;
  if not exists (
    select 1 from public.report_source_items
    where report_id=v_report.id and source_id='verify-rws-design'
      and snapshot->>'work_kind'='design' and (snapshot->>'completion_in_period')::boolean
  ) then
    raise exception 'TEST_FAILED: design task classification/completion evidence is wrong.';
  end if;
  if not exists (
    select 1 from public.report_source_items
    where report_id=v_report.id and source_id='verify-rws-video'
      and snapshot->>'work_kind'='video'
      and not (snapshot->>'subject_is_current_assignee')::boolean
      and not (snapshot->>'completion_in_period')::boolean
  ) then
    raise exception 'TEST_FAILED: linked video work or its non-assignment context is missing.';
  end if;

  select * into v_client_report from public.create_report_draft(
    'client',v_client_id,null,v_client_responsible,'2026-10-10','2026-10-17','','Verified client report'
  );
  if exists (
    select 1 from public.report_source_items
    where report_id=v_client_report.id and source_kind in ('task','extra_note')
  ) then
    raise exception 'TEST_FAILED: client report included Task Board or extra-note sources.';
  end if;

  reset role;
  raise exception 'TEST_OK_ROLLED_BACK: Creative subjects, linked-task evidence, source separation, Friday exclusion, Custom Roles, and scope isolation passed.';
end $$;
