-- Report Workspace: explicit employee client scopes, final-state immutability, archive/delete
-- separation, and client-portal filtering. Apply after 20261107200000_report_workspace_task_sources.sql.
begin;

do $$
begin
  if to_regprocedure('public.create_report_draft(text,text,text,text,date,date,text,text)') is null
    or to_regclass('public.report_source_items') is null
    or to_regprocedure('public.report_task_work_kind(text)') is null then
    raise exception 'Apply Report Workspace migrations through 20261107200000 first.';
  end if;
end $$;

alter table public.reports add column if not exists employee_scope_mode text;
alter table public.reports add column if not exists employee_scope_client_ids text[];
alter table public.reports add column if not exists creation_key text;
alter table public.reports drop constraint if exists reports_employee_scope_mode_check;
alter table public.reports add constraint reports_employee_scope_mode_check check (
  employee_scope_mode is null or employee_scope_mode in ('all_clients','selected_clients','employee_overall')
);
alter table public.reports drop constraint if exists reports_employee_scope_metadata_check;
alter table public.reports add constraint reports_employee_scope_metadata_check check (
  (employee_scope_mode is null and employee_scope_client_ids is null)
  or (scope_type='employee' and employee_scope_mode='selected_clients' and cardinality(employee_scope_client_ids)>0)
  or (scope_type='employee' and employee_scope_mode in ('all_clients','employee_overall') and employee_scope_client_ids is null)
);
create unique index if not exists reports_creator_creation_key_uidx
  on public.reports(generated_by, creation_key) where creation_key is not null;

create table if not exists public.report_deletion_tombstones (
  id text primary key default ('rdt-' || replace(gen_random_uuid()::text, '-', '')),
  report_id text not null unique,
  report_type text not null,
  scope_type text,
  client_id text,
  subject_user_id text,
  generated_by text not null,
  deleted_by text not null,
  period text not null,
  period_start date,
  period_end_exclusive date,
  deletion_reason text not null check (length(trim(deletion_reason)) > 0),
  current_version_id text,
  content_hash text,
  source_hash text,
  version_count integer not null,
  source_count integer not null,
  suggestion_count integer not null,
  audit_snapshot jsonb not null default '[]'::jsonb,
  deleted_at timestamptz not null default now()
);
alter table public.report_deletion_tombstones enable row level security;
alter table public.report_deletion_tombstones add column if not exists content_hash text;
drop policy if exists report_deletion_tombstones_select_rls on public.report_deletion_tombstones;
create policy report_deletion_tombstones_select_rls on public.report_deletion_tombstones
  for select to authenticated using (public.app_user_role() in ('executive','head_of_technical'));
revoke all on public.report_deletion_tombstones from anon, authenticated;
grant select on public.report_deletion_tombstones to authenticated;

-- Align server client scope with the frontend role map without turning Reports module access into
-- blanket client access. Custom roles remain limited to explicit assignments.
create or replace function public.report_scope_accessible(p_client_id text,p_agent_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select case
    when public.app_user_role()='ai_engineer' then true
    when p_client_id is not null then (
      public.app_user_role() in ('executive','head_of_technical','am_team_lead')
      or (public.app_user_role()='am_agent' and public.client_am_agent_is_caller(p_client_id))
      or (public.app_user_role()='media_buying_team_lead' and public.client_has_service(p_client_id,'media_buying'))
      or (public.app_user_role()='media_buying_agent' and public.agent_assigned(p_client_id,'media_buying'))
      or (public.app_user_role()='seo_team_lead' and public.client_has_service(p_client_id,'seo'))
      or (public.app_user_role() in ('seo_agent','store_manager','seo_content_agent','seo_backlink_agent') and public.agent_assigned(p_client_id,'seo'))
      or (public.app_user_role()='social_media_team_lead' and public.client_has_service(p_client_id,'social_media'))
      or (public.app_user_role()='social_media_agent' and public.agent_assigned(p_client_id,'social_media'))
      or (exists(
        select 1 from public.custom_roles cr
        join public.custom_role_modules crm on crm.role_id=cr.id and crm.module_id='reports'
        join public.assignments a on a.agent_id=public.app_user_id() and a.client_id=p_client_id
        where cr.id=public.app_user_role() and cr.is_active
      ))
    )
    when p_agent_id is not null then public.direct_report_visible(p_agent_id)
    else false end;
$$;

-- Returns the exact immutable source set that create_report_draft_v2 will store. Authorization is
-- evaluated inside the database; browser client ids are never treated as proof of access.
create or replace function public.report_source_manifest_v2(
  p_scope_type text,
  p_client_id text,
  p_subject_user_id text,
  p_employee_scope_mode text,
  p_employee_client_ids text[],
  p_period_start date,
  p_period_end_exclusive date
) returns jsonb
language plpgsql stable security definer set search_path=public, pg_temp
as $$
declare v_sources jsonb; v_ids text[] := coalesce(p_employee_client_ids,array[]::text[]); v_hash text;
begin
  if exists(select 1 from unnest(coalesce(p_employee_client_ids,array[]::text[])) value where nullif(trim(value),'') is null) then
    raise exception 'Client ids must be non-empty.' using errcode='22023';
  end if;
  select coalesce(array_agg(distinct value order by value),array[]::text[]) into v_ids
  from unnest(coalesce(p_employee_client_ids,array[]::text[])) value
  where nullif(trim(value),'') is not null;
  if not public.report_subject_creatable(p_scope_type,p_client_id,p_subject_user_id) then
    raise exception 'Not authorized to create this report.' using errcode='42501';
  end if;
  if p_period_start is null or p_period_end_exclusive is null or p_period_start >= p_period_end_exclusive
    or p_period_end_exclusive-p_period_start>366 then
    raise exception 'Invalid report period.' using errcode='22007';
  end if;
  if p_scope_type='client' then
    if p_client_id is null or p_employee_scope_mode is not null or cardinality(v_ids)>0 then
      raise exception 'Invalid client report scope.' using errcode='22023';
    end if;
  elsif p_scope_type='employee' then
    if p_subject_user_id is null or p_employee_scope_mode is null or p_employee_scope_mode not in ('all_clients','selected_clients','employee_overall') then
      raise exception 'An explicit employee and client scope are required.' using errcode='22023';
    end if;
    if p_employee_scope_mode='selected_clients' and cardinality(v_ids)=0 then
      raise exception 'Select at least one client.' using errcode='22023';
    end if;
    if p_employee_scope_mode<>'selected_clients' and cardinality(v_ids)>0 then
      raise exception 'Client ids are only valid for Selected Clients.' using errcode='22023';
    end if;
    if exists (select 1 from unnest(v_ids) id where not public.report_scope_accessible(id, null)) then
      raise exception 'A selected client is outside the authorized scope.' using errcode='42501';
    end if;
  else
    raise exception 'Invalid report scope.' using errcode='22023';
  end if;

  with eligible_logs as (
    select d.* from public.daily_logs d
    where d.date>=p_period_start and d.date<p_period_end_exclusive and extract(dow from d.date)<>5
      and ((p_scope_type='client' and d.client_id=p_client_id)
        or (p_scope_type='employee' and d.user_id=p_subject_user_id and (
          (p_employee_scope_mode='employee_overall' and (d.client_id is null or public.report_scope_accessible(d.client_id, null)))
          or (p_employee_scope_mode='all_clients' and d.client_id is not null and public.report_scope_accessible(d.client_id, null))
          or (p_employee_scope_mode='selected_clients' and d.client_id=any(v_ids) and public.report_scope_accessible(d.client_id, null))
        )))
  ), linked as (
    select l.id log_id,l.date evidence_date,x.task_id from eligible_logs l
    cross join lateral unnest(coalesce(l.linked_task_ids,array[]::text[])) x(task_id)
    where p_scope_type='employee'
  ), task_evidence as (
    select task_id,min(evidence_date) source_date,array_agg(distinct log_id order by log_id) log_ids,
      array_agg(distinct evidence_date order by evidence_date) dates from linked group by task_id
  ), items as (
    select 'daily_log'::text source_kind,d.id source_id,d.date source_date,d.user_id,d.client_id,
      jsonb_build_object('date',d.date,'user_id',d.user_id,'client_id',d.client_id,'summary_text',d.summary_text,'linked_task_ids',d.linked_task_ids) snapshot
    from eligible_logs d
    union all
    select 'extra_note',n.id,n.date,n.user_id,null,
      jsonb_build_object('date',n.date,'user_id',n.user_id,'note_text',n.note_text,'category',n.category)
    from public.extra_notes n where p_scope_type='employee' and p_employee_scope_mode='employee_overall'
      and n.user_id=p_subject_user_id and n.date>=p_period_start and n.date<p_period_end_exclusive and extract(dow from n.date)<>5
    union all
    select 'task',t.id,e.source_date,p_subject_user_id,t.client_id,
      jsonb_build_object('title',t.title,'task_type',t.task_type,'task_type_other',t.task_type_other,'team',t.team,
        'status',t.status,'completed_at',t.completed_at,
        'work_kind',public.report_task_work_kind(concat_ws(' ',t.task_type,t.task_type_other,t.team,t.title,t.description)),
        'classification_method','task_content_keywords','evidence_kind','employee_daily_log_link',
        'evidence_daily_log_ids',to_jsonb(e.log_ids),'evidence_dates',to_jsonb(e.dates),
        'completion_in_period',t.status in ('completed','closed') and t.completed_at is not null
          and (t.completed_at at time zone 'UTC')::date>=p_period_start
          and (t.completed_at at time zone 'UTC')::date<p_period_end_exclusive
          and extract(dow from (t.completed_at at time zone 'UTC')::date)<>5) snapshot
    from task_evidence e join public.tasks t on t.id=e.task_id where public.task_visible_v2(t.id) and (
      (p_employee_scope_mode='employee_overall' and (t.client_id is null or public.report_scope_accessible(t.client_id, null)))
      or (p_employee_scope_mode='all_clients' and t.client_id is not null and public.report_scope_accessible(t.client_id, null))
      or (p_employee_scope_mode='selected_clients' and t.client_id=any(v_ids) and public.report_scope_accessible(t.client_id, null))
    )
  )
  select coalesce(jsonb_agg(jsonb_build_object('source_kind',source_kind,'source_id',source_id,'source_date',source_date,
    'user_id',user_id,'client_id',client_id,'snapshot',snapshot) order by source_kind,source_id),'[]'::jsonb),
    md5(coalesce(string_agg(source_kind||':'||source_id||':'||snapshot::text,'|' order by source_kind,source_id),''))
  into v_sources,v_hash from items;
  return jsonb_build_object('source_hash',v_hash,'sources',v_sources,'source_count',jsonb_array_length(v_sources));
end;
$$;

create or replace function public.preview_report_sources_v2(
  p_scope_type text,p_client_id text,p_subject_user_id text,p_employee_scope_mode text,p_employee_client_ids text[],
  p_period_start date,p_period_end_exclusive date
) returns jsonb language sql stable security definer set search_path=public,pg_temp
as $$ select public.report_source_manifest_v2($1,$2,$3,$4,$5,$6,$7) $$;

create or replace function public.create_report_draft_v2(
  p_scope_type text,p_client_id text,p_subject_user_id text,p_responsible_user_id text,
  p_employee_scope_mode text,p_employee_client_ids text[],p_period_start date,p_period_end_exclusive date,
  p_creator_note text,p_content_text text,p_expected_source_hash text,p_creation_key text
) returns public.reports language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_report public.reports%rowtype; v_manifest jsonb; v_hash text; v_version_id text; v_expected_responsible text;
  v_ids text[]; v_existing_content text;
begin
  if exists(select 1 from unnest(coalesce(p_employee_client_ids,array[]::text[])) value where nullif(trim(value),'') is null) then
    raise exception 'Client ids must be non-empty.' using errcode='22023';
  end if;
  select coalesce(array_agg(distinct value order by value),array[]::text[]) into v_ids
  from unnest(coalesce(p_employee_client_ids,array[]::text[])) value where nullif(trim(value),'') is not null;
  if nullif(trim(coalesce(p_creation_key,'')),'') is null or char_length(p_creation_key)>120 then
    raise exception 'A bounded creation key is required.' using errcode='22023';
  end if;
  if not public.report_subject_creatable(p_scope_type,p_client_id,p_subject_user_id) then
    raise exception 'Not authorized to create this report.' using errcode='42501';
  end if;
  if p_scope_type='client' then
    select am_agent_id into v_expected_responsible from public.clients where id=p_client_id;
  else
    v_expected_responsible:=p_subject_user_id;
  end if;
  if p_responsible_user_id is distinct from v_expected_responsible then
    raise exception 'Responsible employee mismatch.' using errcode='23514';
  end if;
  select * into v_report from public.reports where generated_by=public.app_user_id() and creation_key=p_creation_key;
  if found then
    select content_text into v_existing_content from public.report_content_versions where id=v_report.current_version_id;
    if v_report.scope_type is distinct from p_scope_type or v_report.client_id is distinct from p_client_id
      or v_report.subject_user_id is distinct from p_subject_user_id or v_report.employee_scope_mode is distinct from p_employee_scope_mode
      or coalesce(v_report.employee_scope_client_ids,array[]::text[]) is distinct from v_ids
      or v_report.period_start is distinct from p_period_start or v_report.period_end_exclusive is distinct from p_period_end_exclusive
      or v_report.responsible_user_id is distinct from v_expected_responsible
      or v_report.creator_note is distinct from coalesce(p_creator_note,'')
      or v_report.source_hash is distinct from p_expected_source_hash or v_existing_content is distinct from p_content_text then
      raise exception 'Creation key was already used for a different report request.' using errcode='23505';
    end if;
    return v_report;
  end if;
  if nullif(trim(coalesce(p_content_text,'')),'') is null or char_length(p_content_text)>12000
    or char_length(coalesce(p_creator_note,''))>4000 then raise exception 'Invalid report content.' using errcode='22023'; end if;
  v_manifest:=public.report_source_manifest_v2(p_scope_type,p_client_id,p_subject_user_id,p_employee_scope_mode,
    v_ids,p_period_start,p_period_end_exclusive);
  v_hash:=v_manifest->>'source_hash';
  if p_expected_source_hash is distinct from v_hash then
    raise exception 'Report sources changed; rebuild the preview.' using errcode='40001';
  end if;
  insert into public.reports(id,client_id,type,period,generated_by,status,scope_type,subject_user_id,responsible_user_id,
    period_start,period_end_exclusive,creator_note,employee_scope_mode,employee_scope_client_ids,creation_key,source_hash,created_at,updated_at)
  values('rpt-'||replace(gen_random_uuid()::text,'-',''),p_client_id,case when p_scope_type='client' then 'client' else 'internal' end,
    p_period_start::text||'_'||(p_period_end_exclusive-1)::text,public.app_user_id(),'draft',p_scope_type,p_subject_user_id,
    v_expected_responsible,p_period_start,p_period_end_exclusive,coalesce(p_creator_note,''),p_employee_scope_mode,
    case when p_employee_scope_mode='selected_clients' then v_ids else null end,p_creation_key,v_hash,now(),now()) returning * into v_report;
  insert into public.report_source_items(report_id,source_kind,source_id,source_date,user_id,client_id,snapshot)
  select v_report.id,x.source_kind,x.source_id,x.source_date,x.user_id,x.client_id,x.snapshot
  from jsonb_to_recordset(v_manifest->'sources') as x(source_kind text,source_id text,source_date date,user_id text,client_id text,snapshot jsonb);
  v_version_id:='rver-'||replace(gen_random_uuid()::text,'-','');
  insert into public.report_content_versions(id,report_id,version_no,content_text,source_hash,origin,created_by)
    values(v_version_id,v_report.id,1,p_content_text,v_hash,'generated',public.app_user_id());
  update public.reports set current_version_id=v_version_id where id=v_report.id returning * into v_report;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(v_report.id,public.app_user_id(),'created',
    jsonb_build_object('source_count',v_manifest->'source_count','employee_scope_mode',p_employee_scope_mode,
      'employee_scope_client_ids',case when p_employee_scope_mode='selected_clients' then to_jsonb(v_ids) else null end));
  return v_report;
exception when unique_violation then
  select * into v_report from public.reports where generated_by=public.app_user_id() and creation_key=p_creation_key;
  if found then
    select content_text into v_existing_content from public.report_content_versions where id=v_report.current_version_id;
    if v_report.scope_type is distinct from p_scope_type or v_report.client_id is distinct from p_client_id
      or v_report.subject_user_id is distinct from p_subject_user_id or v_report.employee_scope_mode is distinct from p_employee_scope_mode
      or coalesce(v_report.employee_scope_client_ids,array[]::text[]) is distinct from v_ids
      or v_report.period_start is distinct from p_period_start or v_report.period_end_exclusive is distinct from p_period_end_exclusive
      or v_report.responsible_user_id is distinct from v_expected_responsible
      or v_report.creator_note is distinct from coalesce(p_creator_note,'')
      or v_report.source_hash is distinct from p_expected_source_hash or v_existing_content is distinct from p_content_text then
      raise exception 'Creation key was already used for a different report request.' using errcode='23505';
    end if;
    return v_report;
  end if;
  raise;
end;
$$;

-- Backward-compatible entry point for the already-deployed frontend during the staged release.
-- It receives the same server-built manifest and version/audit guarantees, while mapping the old
-- employee meaning explicitly to Employee Overall. New code must use create_report_draft_v2.
create or replace function public.create_report_draft(
  p_scope_type text,p_client_id text,p_subject_user_id text,p_responsible_user_id text,
  p_period_start date,p_period_end_exclusive date,p_creator_note text,p_content_text text
) returns public.reports language plpgsql security definer set search_path=public,pg_temp as $$
declare v_manifest jsonb; v_mode text;
begin
  v_mode:=case when p_scope_type='employee' then 'employee_overall' else null end;
  v_manifest:=public.report_source_manifest_v2(p_scope_type,p_client_id,p_subject_user_id,v_mode,array[]::text[],p_period_start,p_period_end_exclusive);
  return public.create_report_draft_v2(p_scope_type,p_client_id,p_subject_user_id,p_responsible_user_id,v_mode,array[]::text[],
    p_period_start,p_period_end_exclusive,p_creator_note,p_content_text,v_manifest->>'source_hash',
    'legacy-'||md5(concat_ws('|',public.app_user_id(),p_scope_type,p_client_id,p_subject_user_id,p_responsible_user_id,
      p_period_start::text,p_period_end_exclusive::text,p_creator_note,p_content_text)));
end $$;

create or replace function public.save_report_version(p_report_id text,p_content_text text,p_origin text default 'manual')
returns public.report_content_versions language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.reports%rowtype; v_version public.report_content_versions%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  if p_origin not in ('manual','regenerated') or nullif(trim(coalesce(p_content_text,'')),'') is null or char_length(p_content_text)>12000 then raise exception 'Invalid content.' using errcode='22023'; end if;
  select * into v_report from public.reports where id=p_report_id for update;
  if not found or v_report.archived_at is not null or v_report.status='final' then raise exception 'Final or archived reports are immutable.' using errcode='55000'; end if;
  insert into public.report_content_versions(report_id,version_no,content_text,source_hash,origin,created_by)
    values(p_report_id,(select coalesce(max(version_no),0)+1 from public.report_content_versions where report_id=p_report_id),p_content_text,v_report.source_hash,p_origin,public.app_user_id()) returning * into v_version;
  update public.reports set current_version_id=v_version.id,updated_at=now() where id=p_report_id;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'edited',jsonb_build_object('version_id',v_version.id));
  return v_version;
end $$;

create or replace function public.save_report_version_v2(p_report_id text,p_content_text text,p_origin text,p_expected_version_id text)
returns public.report_content_versions language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.reports%rowtype; v_version public.report_content_versions%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  if p_origin not in ('manual','regenerated') or nullif(trim(coalesce(p_content_text,'')),'') is null or char_length(p_content_text)>12000 then raise exception 'Invalid content.' using errcode='22023'; end if;
  select * into v_report from public.reports where id=p_report_id for update;
  if not found or v_report.archived_at is not null or v_report.status='final' then raise exception 'Final or archived reports are immutable.' using errcode='55000'; end if;
  if p_expected_version_id is null or v_report.current_version_id is distinct from p_expected_version_id then raise exception 'Report changed; refresh before saving.' using errcode='40001'; end if;
  insert into public.report_content_versions(report_id,version_no,content_text,source_hash,origin,created_by)
    values(p_report_id,(select coalesce(max(version_no),0)+1 from public.report_content_versions where report_id=p_report_id),p_content_text,v_report.source_hash,p_origin,public.app_user_id()) returning * into v_version;
  update public.reports set current_version_id=v_version.id,updated_at=now() where id=p_report_id;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'edited',jsonb_build_object('version_id',v_version.id,'expected_version_id',p_expected_version_id));
  return v_version;
end $$;

create or replace function public.archive_report(p_report_id text,p_reason text,p_restore boolean default false)
returns public.reports language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.reports%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  select * into v_report from public.reports where id=p_report_id for update;
  if not found then raise exception 'Report missing.'; end if;
  if p_restore then
    if v_report.archived_at is null then raise exception 'Report is not archived.' using errcode='55000'; end if;
    update public.reports set archived_at=null,archived_by=null,archive_reason=null,updated_at=now() where id=p_report_id returning * into v_report;
    insert into public.report_audit_events(report_id,actor_id,action) values(p_report_id,public.app_user_id(),'restored');
  else
    if v_report.archived_at is not null then raise exception 'Report is already archived.' using errcode='55000'; end if;
    if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Archive reason is required.' using errcode='22023'; end if;
    update public.reports set archived_at=now(),archived_by=public.app_user_id(),archive_reason=trim(p_reason),updated_at=now() where id=p_report_id returning * into v_report;
    insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'archived',jsonb_build_object('reason',trim(p_reason)));
  end if; return v_report;
end $$;

create or replace function public.archive_report_v2(p_report_id text,p_reason text,p_restore boolean,p_expected_version_id text)
returns public.reports language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.reports%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  select * into v_report from public.reports where id=p_report_id for update;
  if not found then raise exception 'Report missing.'; end if;
  if p_expected_version_id is null or v_report.current_version_id is distinct from p_expected_version_id then raise exception 'Report changed; refresh before changing archive state.' using errcode='40001'; end if;
  if p_restore then
    if v_report.archived_at is null then raise exception 'Report is not archived.' using errcode='55000'; end if;
    update public.reports set archived_at=null,archived_by=null,archive_reason=null,updated_at=now() where id=p_report_id returning * into v_report;
    insert into public.report_audit_events(report_id,actor_id,action) values(p_report_id,public.app_user_id(),'restored');
  else
    if v_report.archived_at is not null then raise exception 'Report is already archived.' using errcode='55000'; end if;
    if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Archive reason is required.' using errcode='22023'; end if;
    update public.reports set archived_at=now(),archived_by=public.app_user_id(),archive_reason=trim(p_reason),updated_at=now() where id=p_report_id returning * into v_report;
    insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'archived',jsonb_build_object('reason',trim(p_reason),'expected_version_id',p_expected_version_id));
  end if; return v_report;
end $$;

create or replace function public.approve_report(p_report_id text) returns public.reports
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.reports%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  select * into v_report from public.reports where id=p_report_id for update;
  if not found or v_report.archived_at is not null or v_report.status='final' or v_report.current_version_id is null then
    raise exception 'Report cannot be approved in its current state.' using errcode='55000'; end if;
  update public.reports set status='final',approved_by=public.app_user_id(),approved_at=now(),updated_at=now() where id=p_report_id returning * into v_report;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'approved',jsonb_build_object('version_id',v_report.current_version_id));
  return v_report;
end $$;

create or replace function public.approve_report_v2(p_report_id text,p_expected_version_id text) returns public.reports
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.reports%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  select * into v_report from public.reports where id=p_report_id for update;
  if not found or v_report.archived_at is not null or v_report.status='final' or v_report.current_version_id is null then raise exception 'Report cannot be approved in its current state.' using errcode='55000'; end if;
  if p_expected_version_id is null or v_report.current_version_id is distinct from p_expected_version_id then raise exception 'Report changed; refresh before approval.' using errcode='40001'; end if;
  update public.reports set status='final',approved_by=public.app_user_id(),approved_at=now(),updated_at=now() where id=p_report_id returning * into v_report;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'approved',jsonb_build_object('version_id',v_report.current_version_id));
  return v_report;
end $$;

-- Existing numeric grounding remains in the prior migration; these wrappers add the final-state guard.
create or replace function public.create_report_ai_suggestion(p_report_id text,p_base_version_id text,p_source_hash text,p_suggested_text text)
returns public.report_ai_suggestions language plpgsql security definer set search_path=public,pg_temp as $$
declare v_r public.reports%rowtype; v_b public.report_content_versions%rowtype; v_s public.report_ai_suggestions%rowtype; v_allowed text;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  if nullif(trim(coalesce(p_suggested_text,'')),'') is null or char_length(p_suggested_text)>12000 then raise exception 'Invalid suggestion.' using errcode='22023'; end if;
  select * into v_r from public.reports where id=p_report_id for update;
  if not found or v_r.archived_at is not null or v_r.status='final' then raise exception 'Final or archived reports are immutable.' using errcode='55000'; end if;
  if v_r.current_version_id is distinct from p_base_version_id or v_r.source_hash is distinct from p_source_hash then raise exception 'Report changed.' using errcode='40001'; end if;
  select * into v_b from public.report_content_versions where id=p_base_version_id and report_id=p_report_id;
  if not found then raise exception 'Base version unavailable.' using errcode='40001'; end if;
  select concat_ws(E'\n',v_b.content_text,v_r.creator_note,string_agg(source_date::text||' '||case when source_kind='task'
    then concat_ws(' ',snapshot->>'title',snapshot->>'task_type',snapshot->>'task_type_other',snapshot->>'team',snapshot->>'status',snapshot->>'work_kind',snapshot->>'evidence_dates')
    else coalesce(snapshot->>'summary_text',snapshot->>'note_text','') end,E'\n' order by source_date,source_kind,source_id))
    into v_allowed from public.report_source_items where report_id=p_report_id;
  if exists(select token from unnest(public.report_numeric_tokens(p_suggested_text)) token except select token from unnest(public.report_numeric_tokens(v_allowed)) token)
    then raise exception 'AI suggestion contains an unsupported number.' using errcode='22023'; end if;
  insert into public.report_ai_suggestions(report_id,base_version_id,source_hash,suggested_text,requested_by)
    values(p_report_id,p_base_version_id,p_source_hash,p_suggested_text,public.app_user_id()) returning * into v_s;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'ai_requested',jsonb_build_object('suggestion_id',v_s.id));
  return v_s;
end $$;

create or replace function public.apply_report_ai_suggestion(p_suggestion_id text)
returns public.report_content_versions language plpgsql security definer set search_path=public,pg_temp as $$
declare v_s public.report_ai_suggestions%rowtype; v_r public.reports%rowtype; v_v public.report_content_versions%rowtype;
begin
  select * into v_s from public.report_ai_suggestions where id=p_suggestion_id and status='pending' for update;
  if not found or not public.report_row_editable(v_s.report_id) then raise exception 'Suggestion unavailable.' using errcode='42501'; end if;
  select * into v_r from public.reports where id=v_s.report_id for update;
  if v_r.archived_at is not null or v_r.status='final' then raise exception 'Final or archived reports are immutable.' using errcode='55000'; end if;
  if v_r.current_version_id is distinct from v_s.base_version_id or v_r.source_hash is distinct from v_s.source_hash then raise exception 'Suggestion is stale.' using errcode='40001'; end if;
  insert into public.report_content_versions(report_id,version_no,content_text,source_hash,origin,created_by)
    values(v_r.id,(select coalesce(max(version_no),0)+1 from public.report_content_versions where report_id=v_r.id),v_s.suggested_text,v_r.source_hash,'ai_applied',public.app_user_id()) returning * into v_v;
  update public.reports set current_version_id=v_v.id,updated_at=now() where id=v_r.id;
  update public.report_ai_suggestions set status='applied',applied_at=now(),applied_by=public.app_user_id() where id=p_suggestion_id;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(v_r.id,public.app_user_id(),'ai_applied',jsonb_build_object('suggestion_id',p_suggestion_id,'version_id',v_v.id));
  return v_v;
end $$;

create or replace function public.update_legacy_report_draft(p_report_id text,p_comparison_id text,p_period text,p_client_id text,p_type text)
returns public.reports language plpgsql security definer set search_path=public,pg_temp as $$
declare v_r public.reports%rowtype; v_c public.client_comparisons%rowtype;
begin
  select * into v_r from public.reports where id=p_report_id and scope_type is null for update;
  if not found or v_r.archived_at is not null or v_r.status='final' or not public.report_row_editable(p_report_id) then
    raise exception 'Legacy report is unavailable or immutable.' using errcode='42501'; end if;
  select * into v_c from public.client_comparisons where id=p_comparison_id;
  if not found or not public.comparison_scope_accessible(p_comparison_id) or v_c.client_id is null
    or v_c.client_id is distinct from p_client_id or p_type<>'client' or v_c.period_current is distinct from p_period then
    raise exception 'Invalid legacy report scope.' using errcode='42501'; end if;
  update public.reports set client_id=v_c.client_id,type='client',period=v_c.period_current,comparison_id=p_comparison_id,updated_at=now()
    where id=p_report_id returning * into v_r;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'edited',jsonb_build_object('legacy_metadata_update',true));
  return v_r;
end $$;

create or replace function public.delete_report_permanently(p_report_id text,p_expected_updated_at timestamptz,p_reason text)
returns public.report_deletion_tombstones language plpgsql security definer set search_path=public,pg_temp as $$
declare v_r public.reports%rowtype; v_t public.report_deletion_tombstones%rowtype;
begin
  if public.app_user_role() not in ('executive','head_of_technical') then raise exception 'Permanent deletion is restricted.' using errcode='42501'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Deletion reason is required.' using errcode='22023'; end if;
  select * into v_r from public.reports where id=p_report_id for update;
  if not found then raise exception 'Report missing.'; end if;
  if v_r.archived_at is null then raise exception 'Archive the report before permanent deletion.' using errcode='55000'; end if;
  if p_expected_updated_at is null or v_r.updated_at is distinct from p_expected_updated_at then raise exception 'Report changed; refresh before deleting.' using errcode='40001'; end if;
  insert into public.report_deletion_tombstones(report_id,report_type,scope_type,client_id,subject_user_id,generated_by,deleted_by,
    period,period_start,period_end_exclusive,deletion_reason,current_version_id,content_hash,source_hash,version_count,source_count,suggestion_count,audit_snapshot)
  select v_r.id,v_r.type,v_r.scope_type,v_r.client_id,v_r.subject_user_id,v_r.generated_by,public.app_user_id(),v_r.period,
    v_r.period_start,v_r.period_end_exclusive,trim(p_reason),v_r.current_version_id,
    (select md5(v.content_text) from public.report_content_versions v where v.id=v_r.current_version_id),v_r.source_hash,
    (select count(*) from public.report_content_versions where report_id=v_r.id),
    (select count(*) from public.report_source_items where report_id=v_r.id),
    (select count(*) from public.report_ai_suggestions where report_id=v_r.id),
    coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at,a.id) from public.report_audit_events a where a.report_id=v_r.id),'[]'::jsonb)
  returning * into v_t;
  update public.reports set current_version_id=null where id=v_r.id;
  delete from public.report_ai_suggestions where report_id=v_r.id;
  delete from public.report_content_versions where report_id=v_r.id;
  delete from public.report_source_items where report_id=v_r.id;
  delete from public.report_audit_events where report_id=v_r.id;
  delete from public.reports where id=v_r.id;
  return v_t;
end $$;

-- Portal users may see only their own finalized, active client reports.
drop policy if exists reports_select_portal_rls on public.reports;
create policy reports_select_portal_rls on public.reports for select to authenticated using (
  public.app_user_role()='client' and client_id=public.portal_client_id()
  and type='client' and status='final' and archived_at is null
);

revoke all on function public.report_source_manifest_v2(text,text,text,text,text[],date,date) from public;
revoke all on function public.preview_report_sources_v2(text,text,text,text,text[],date,date) from public;
revoke all on function public.create_report_draft_v2(text,text,text,text,text,text[],date,date,text,text,text,text) from public;
revoke all on function public.delete_report_permanently(text,timestamptz,text) from public;
revoke all on function public.save_report_version_v2(text,text,text,text) from public;
revoke all on function public.archive_report_v2(text,text,boolean,text) from public;
revoke all on function public.approve_report_v2(text,text) from public;
grant execute on function public.preview_report_sources_v2(text,text,text,text,text[],date,date) to authenticated;
grant execute on function public.create_report_draft_v2(text,text,text,text,text,text[],date,date,text,text,text,text) to authenticated;
grant execute on function public.delete_report_permanently(text,timestamptz,text) to authenticated;
grant execute on function public.save_report_version_v2(text,text,text,text) to authenticated;
grant execute on function public.archive_report_v2(text,text,boolean,text) to authenticated;
grant execute on function public.approve_report_v2(text,text) to authenticated;
commit;
