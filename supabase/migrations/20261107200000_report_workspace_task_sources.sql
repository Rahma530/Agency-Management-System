-- Add evidence-backed Task Board sources to employee reports without widening report or task
-- visibility. Apply after 20261107100000_report_workspace_release_hardening.sql.
begin;

do $$
begin
  if to_regprocedure('public.report_module_accessible()') is null
    or to_regprocedure('public.report_numeric_tokens(text)') is null
    or to_regprocedure('public.update_legacy_report_draft(text,text,text,text,text)') is null then
    raise exception 'Apply 20261107100000_report_workspace_release_hardening.sql before this migration.';
  end if;
  if to_regprocedure('public.task_visible_v2(text)') is null
    or to_regclass('public.task_assignees') is null then
    raise exception 'Task visibility and task-assignee migrations are required before this migration.';
  end if;
end $$;

alter table public.report_source_items
  drop constraint if exists report_source_items_source_kind_check;
alter table public.report_source_items
  add constraint report_source_items_source_kind_check
  check (source_kind in ('daily_log', 'extra_note', 'task'));

-- A report subject does not need access to the Reports module. Creative employees are legitimate
-- subjects for an already-authorized viewer, while their own module access remains unchanged.
create or replace function public.report_role_is_subject(p_role text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_role in (
    'am_agent', 'media_buying_agent', 'seo_agent', 'store_manager',
    'seo_content_agent', 'seo_backlink_agent', 'social_media_agent',
    'graphic_designer', 'video_editor'
  ) or exists (
    select 1
    from public.custom_roles cr
    join public.departments d on d.id = cr.department_id
    where cr.id = p_role and cr.is_active and d.is_active and d.is_shared_resource
  ) or exists (
    select 1
    from public.custom_roles cr
    join public.custom_role_modules crm on crm.role_id = cr.id
    where cr.id = p_role and cr.is_active and crm.module_id = 'reports'
  );
$$;

revoke all on function public.report_role_is_subject(text) from public;

create or replace function public.report_task_work_kind(p_text text) returns text
language sql immutable set search_path = public, pg_temp
as $$
  with signals as (
    select
      coalesce(p_text, '') ~* '(video|videos|reel|reels|motion|animation|montage|editing|فيديو|فيديوهات|ريل|ريلز|موشن|مونتاج|تحريك)' as is_video,
      coalesce(p_text, '') ~* '(design|designs|graphic|graphics|banner|poster|carousel|visual|thumbnail|creative|تصميم|تصميمات|جرافيك|بنر|بوستر|كاروسيل|غلاف|كرياتيف)' as is_design
  )
  select case
    when is_video and is_design then 'mixed'
    when is_video then 'video'
    when is_design then 'design'
    else 'unclassified'
  end
  from signals;
$$;

revoke all on function public.report_task_work_kind(text) from public;

create or replace function public.create_report_draft(
  p_scope_type text,
  p_client_id text,
  p_subject_user_id text,
  p_responsible_user_id text,
  p_period_start date,
  p_period_end_exclusive date,
  p_creator_note text,
  p_content_text text
) returns public.reports
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_report public.reports%rowtype;
  v_version_id text;
  v_hash text;
  v_expected_responsible text;
begin
  if not public.report_subject_creatable(p_scope_type, p_client_id, p_subject_user_id) then
    raise exception 'Not authorized to create this report.' using errcode = '42501';
  end if;
  if p_period_start is null or p_period_end_exclusive is null or p_period_start >= p_period_end_exclusive then
    raise exception 'Invalid report period.' using errcode = '22007';
  end if;
  if nullif(trim(coalesce(p_content_text, '')), '') is null or char_length(p_content_text) > 12000
    or char_length(coalesce(p_creator_note, '')) > 4000 then
    raise exception 'Report content or creator note is invalid.' using errcode = '22023';
  end if;

  if p_scope_type = 'client' then
    select am_agent_id into v_expected_responsible from public.clients where id = p_client_id;
  else
    v_expected_responsible := p_subject_user_id;
  end if;
  if p_responsible_user_id is distinct from v_expected_responsible then
    raise exception 'Responsible employee does not match the report subject.' using errcode = '23514';
  end if;

  insert into public.reports (
    id, client_id, type, period, generated_by, status, scope_type, subject_user_id,
    responsible_user_id, period_start, period_end_exclusive, creator_note, created_at, updated_at
  ) values (
    'rpt-' || replace(gen_random_uuid()::text, '-', ''), p_client_id,
    case when p_scope_type = 'client' then 'client' else 'internal' end,
    p_period_start::text || '_' || (p_period_end_exclusive - 1)::text,
    public.app_user_id(), 'draft', p_scope_type, p_subject_user_id, v_expected_responsible,
    p_period_start, p_period_end_exclusive, coalesce(p_creator_note, ''), now(), now()
  ) returning * into v_report;

  if p_scope_type = 'client' then
    -- Client reports remain daily-log-only and are scoped by the selected client id.
    insert into public.report_source_items (report_id, source_kind, source_id, source_date, user_id, client_id, snapshot)
    select v_report.id, 'daily_log', d.id, d.date, d.user_id, d.client_id,
      jsonb_build_object('date', d.date, 'user_id', d.user_id, 'client_id', d.client_id, 'summary_text', d.summary_text, 'linked_task_ids', d.linked_task_ids)
    from public.daily_logs d
    where d.client_id = p_client_id and d.date >= p_period_start and d.date < p_period_end_exclusive
      and extract(dow from d.date) <> 5;
  else
    insert into public.report_source_items (report_id, source_kind, source_id, source_date, user_id, client_id, snapshot)
    select v_report.id, 'daily_log', d.id, d.date, d.user_id, d.client_id,
      jsonb_build_object('date', d.date, 'user_id', d.user_id, 'client_id', d.client_id, 'summary_text', d.summary_text, 'linked_task_ids', d.linked_task_ids)
    from public.daily_logs d
    where d.user_id = p_subject_user_id and d.date >= p_period_start and d.date < p_period_end_exclusive
      and extract(dow from d.date) <> 5;

    insert into public.report_source_items (report_id, source_kind, source_id, source_date, user_id, client_id, snapshot)
    select v_report.id, 'extra_note', n.id, n.date, n.user_id, null,
      jsonb_build_object('date', n.date, 'user_id', n.user_id, 'note_text', n.note_text, 'category', n.category)
    from public.extra_notes n
    where n.user_id = p_subject_user_id and n.date >= p_period_start and n.date < p_period_end_exclusive
      and extract(dow from n.date) <> 5;

    -- The employee's own linked daily log is the evidence of work. Current assignment and task
    -- lifecycle fields are recorded for context only and never qualify a task by themselves.
    with linked_evidence as (
      select distinct d.id as log_id, d.date as evidence_date, linked.task_id
      from public.daily_logs d
      cross join lateral unnest(coalesce(d.linked_task_ids, array[]::text[])) as linked(task_id)
      where d.user_id = p_subject_user_id
        and d.date >= p_period_start and d.date < p_period_end_exclusive
        and extract(dow from d.date) <> 5
    ), task_evidence as (
      select
        e.task_id,
        min(e.evidence_date) as first_evidence_date,
        array_agg(distinct e.log_id order by e.log_id) as evidence_daily_log_ids,
        array_agg(distinct e.evidence_date order by e.evidence_date) as evidence_dates
      from linked_evidence e
      group by e.task_id
    )
    insert into public.report_source_items (report_id, source_kind, source_id, source_date, user_id, client_id, snapshot)
    select
      v_report.id,
      'task',
      t.id,
      e.first_evidence_date,
      p_subject_user_id,
      t.client_id,
      jsonb_build_object(
        'title', t.title,
        'task_type', t.task_type,
        'task_type_other', t.task_type_other,
        'team', t.team,
        'status', t.status,
        'completed_at', t.completed_at,
        'work_kind', public.report_task_work_kind(concat_ws(' ', t.task_type, t.task_type_other, t.team, t.title, t.description)),
        'classification_method', 'task_content_keywords',
        'classification_fields', jsonb_build_array('task_type', 'task_type_other', 'team', 'title', 'description'),
        'evidence_kind', 'employee_daily_log_link',
        'evidence_daily_log_ids', to_jsonb(e.evidence_daily_log_ids),
        'evidence_dates', to_jsonb(e.evidence_dates),
        'subject_is_current_assignee', case
          when exists (select 1 from public.task_assignees any_assignee where any_assignee.task_id = t.id)
            then exists (select 1 from public.task_assignees own_assignee where own_assignee.task_id = t.id and own_assignee.user_id = p_subject_user_id)
          else t.assigned_to = p_subject_user_id
        end,
        'completion_in_period', t.status in ('completed', 'closed')
          and t.completed_at is not null
          and (t.completed_at at time zone 'UTC')::date >= p_period_start
          and (t.completed_at at time zone 'UTC')::date < p_period_end_exclusive
          and extract(dow from (t.completed_at at time zone 'UTC')::date) <> 5
      )
    from task_evidence e
    join public.tasks t on t.id = e.task_id
    where public.task_visible_v2(t.id);
  end if;

  select md5(coalesce(string_agg(source_kind || ':' || source_id || ':' || snapshot::text, '|' order by source_kind, source_id), ''))
    into v_hash from public.report_source_items where report_id = v_report.id;
  v_version_id := 'rver-' || replace(gen_random_uuid()::text, '-', '');
  insert into public.report_content_versions (id, report_id, version_no, content_text, source_hash, origin, created_by)
    values (v_version_id, v_report.id, 1, p_content_text, v_hash, 'generated', public.app_user_id());
  update public.reports set current_version_id = v_version_id, source_hash = v_hash where id = v_report.id returning * into v_report;
  insert into public.report_audit_events (report_id, actor_id, action, metadata)
    values (v_report.id, public.app_user_id(), 'created', jsonb_build_object('source_count', (select count(*) from public.report_source_items where report_id = v_report.id)));
  return v_report;
end;
$$;

create or replace function public.create_report_ai_suggestion(p_report_id text,p_base_version_id text,p_source_hash text,p_suggested_text text)
returns public.report_ai_suggestions language plpgsql security definer set search_path=public, pg_temp
as $$
declare
  v_report public.reports%rowtype;
  v_base public.report_content_versions%rowtype;
  v_suggestion public.report_ai_suggestions%rowtype;
  v_allowed_text text;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized to request AI for this report.' using errcode='42501'; end if;
  if nullif(trim(coalesce(p_suggested_text, '')), '') is null or char_length(p_suggested_text) > 12000 then
    raise exception 'AI suggestion is invalid.' using errcode='22023';
  end if;
  select * into v_report from public.reports where id=p_report_id and archived_at is null;
  if not found or v_report.current_version_id<>p_base_version_id or v_report.source_hash<>p_source_hash then
    raise exception 'Report changed before the AI suggestion was saved.' using errcode='40001';
  end if;
  select * into v_base from public.report_content_versions where id=p_base_version_id and report_id=p_report_id;
  if not found then raise exception 'Base report version is unavailable.' using errcode='40001'; end if;
  select concat_ws(E'\n', v_base.content_text, v_report.creator_note,
    string_agg(
      source_date::text || ' ' || case
        when source_kind = 'task' then concat_ws(' ',
          snapshot->>'title', snapshot->>'task_type', snapshot->>'task_type_other',
          snapshot->>'team', snapshot->>'status', snapshot->>'work_kind', snapshot->>'evidence_dates')
        else coalesce(snapshot->>'summary_text', snapshot->>'note_text', '')
      end,
      E'\n' order by source_date, source_kind, source_id
    ))
    into v_allowed_text from public.report_source_items where report_id=p_report_id;
  if exists (
    select token from unnest(public.report_numeric_tokens(p_suggested_text)) token
    except
    select token from unnest(public.report_numeric_tokens(v_allowed_text)) token
  ) then
    raise exception 'AI suggestion contains an unsupported number.' using errcode='22023';
  end if;
  insert into public.report_ai_suggestions(report_id,base_version_id,source_hash,suggested_text,requested_by)
    values(p_report_id,p_base_version_id,p_source_hash,p_suggested_text,public.app_user_id()) returning * into v_suggestion;
  insert into public.report_audit_events(report_id,actor_id,action,metadata)
    values(p_report_id,public.app_user_id(),'ai_requested',jsonb_build_object('suggestion_id',v_suggestion.id));
  return v_suggestion;
end;
$$;

revoke all on function public.create_report_draft(text,text,text,text,date,date,text,text) from public;
revoke all on function public.create_report_ai_suggestion(text,text,text,text) from public;
grant execute on function public.create_report_draft(text,text,text,text,date,date,text,text) to authenticated;
grant execute on function public.create_report_ai_suggestion(text,text,text,text) to authenticated;

commit;
