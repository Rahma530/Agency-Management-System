-- Per-service report filtering for CLIENT-scope reports (Reports module).
--
-- Requested behavior (confirmed with the product owner):
--   - A regular service agent pulling a client report today gets ALL of that client's work
--     across every service, even though the agent only did one service's work. They should only
--     ever see their own service's work: 'seo_agent'/'store_manager'/'seo_content_agent'/
--     'seo_backlink_agent' -> 'seo' only; 'media_buying_agent' -> 'media_buying' only;
--     'social_media_agent' -> 'social_media' only. This is enforced server-side and is NOT
--     something the frontend can opt out of.
--   - 'am_agent', the three department team leads ('seo_team_lead', 'media_buying_team_lead',
--     'social_media_team_lead'), 'am_team_lead', 'executive' and 'head_of_technical' instead get a
--     CHOICE: pull one specific service's work, or "All services" (today's existing behavior,
--     still the default). Team leads get the full choice rather than being locked to their own
--     department, per explicit product direction ("ب" — same options as AM).
--   - Any other role that reaches client-scope report access (a creative/tech role such as
--     graphic_designer/video_editor, or a custom role granted the reports module via an
--     assignment) has no reliable per-work-log service classification
--     (workLogServiceClassification.ts's own documented limitation), so it is locked to its own
--     work-log entries only ('own_entries') rather than either the whole client's work or a
--     guessed service bucket.
--
-- Apply after 20261124000000_ai_engineer_deprivilege.sql.
begin;

do $$
begin
  if to_regprocedure('public.report_source_manifest_v2(text,text,text,text,text[],date,date)') is null then
    raise exception 'Apply Report Workspace migrations through 20261124000000 first.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. reports.client_service_filter — persists which filter a CLIENT-scope draft was built with,
--    so reopening it / matching it against the current UI selection stays consistent with
--    employee_scope_mode's existing pattern. Null means "All services" (today's default
--    behavior, unchanged for every report created before this column existed).
-- ----------------------------------------------------------------------------
alter table public.reports add column if not exists client_service_filter text;
alter table public.reports drop constraint if exists reports_client_service_filter_check;
alter table public.reports add constraint reports_client_service_filter_check check (
  client_service_filter is null
  or (scope_type = 'client' and client_service_filter in
    ('seo','media_buying','social_media','interface','creation','own_entries'))
);

-- ----------------------------------------------------------------------------
-- 2. daily_log_author_service(p_user_id) — server-side mirror of
--    workLogServiceClassification.ts's ROLE_TO_SERVICE map. Deliberately kept identical to that
--    frontend mapping (same documented limitation: graphic_designer/video_editor/branding have no
--    reliable mapping and fall through to null here too).
-- ----------------------------------------------------------------------------
create or replace function public.daily_log_author_service(p_user_id text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select case (select u.role from public.users u where u.id = p_user_id)
    when 'seo_team_lead' then 'seo'
    when 'seo_agent' then 'seo'
    when 'store_manager' then 'seo'
    when 'seo_content_agent' then 'seo'
    when 'seo_backlink_agent' then 'seo'
    when 'media_buying_team_lead' then 'media_buying'
    when 'media_buying_agent' then 'media_buying'
    when 'social_media_team_lead' then 'social_media'
    when 'social_media_agent' then 'social_media'
    when 'ui_ux_designer' then 'interface'
    when 'programming_agent' then 'creation'
    else null
  end;
$$;

-- ----------------------------------------------------------------------------
-- 3. report_caller_client_service_lock() — resolves, for the CALLING user, whether their
--    client-scope report access is: free choice (null — "Choice" roles), forced to one specific
--    service regardless of what the client requests ('seo'/'media_buying'/'social_media' —
--    "Locked" agent roles), or forced down to only their own daily_log entries, with no service
--    bucket at all ('own_entries' — anything else that reaches client-scope access: creative/tech
--    roles and custom roles).
-- ----------------------------------------------------------------------------
create or replace function public.report_caller_client_service_lock()
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when public.app_user_role() in (
      'executive','head_of_technical','am_team_lead','am_agent',
      'seo_team_lead','media_buying_team_lead','social_media_team_lead'
    ) then null::text
    when public.app_user_role() in ('seo_agent','store_manager','seo_content_agent','seo_backlink_agent') then 'seo'
    when public.app_user_role() = 'media_buying_agent' then 'media_buying'
    when public.app_user_role() = 'social_media_agent' then 'social_media'
    else 'own_entries'
  end;
$$;

-- ----------------------------------------------------------------------------
-- 4. report_source_manifest_v2 — add p_service_filter, defaulted to null so every existing caller
--    (create_report_draft, the App.tsx comparison-filing flow, any not-yet-updated frontend code)
--    keeps today's "all services" behavior unchanged until it's explicitly updated to pass a
--    filter. Only meaningful for p_scope_type='client'; employee-scope manifests are untouched.
--    The caller's OWN lock always wins over whatever filter is requested — a Locked agent cannot
--    broaden their own access by passing a different p_service_filter value.
-- ----------------------------------------------------------------------------
create or replace function public.report_source_manifest_v2(
  p_scope_type text,
  p_client_id text,
  p_subject_user_id text,
  p_employee_scope_mode text,
  p_employee_client_ids text[],
  p_period_start date,
  p_period_end_exclusive date,
  p_service_filter text default null
) returns jsonb
language plpgsql stable security definer set search_path=public, pg_temp
as $$
declare v_sources jsonb; v_ids text[] := coalesce(p_employee_client_ids,array[]::text[]); v_hash text;
  v_lock text; v_effective_filter text;
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

  if p_service_filter is not null and p_service_filter not in ('seo','media_buying','social_media','interface','creation') then
    raise exception 'Invalid service filter.' using errcode='22023';
  end if;
  if p_service_filter is not null and p_scope_type <> 'client' then
    raise exception 'A service filter only applies to client-scope reports.' using errcode='22023';
  end if;

  v_lock := public.report_caller_client_service_lock();
  v_effective_filter := case
    when p_scope_type <> 'client' then null
    when v_lock is not null then v_lock
    else p_service_filter
  end;

  with eligible_logs as (
    select d.* from public.daily_logs d
    where d.date>=p_period_start and d.date<p_period_end_exclusive and extract(dow from d.date)<>5
      and ((p_scope_type='client' and d.client_id=p_client_id
            and (
              v_effective_filter is null
              or (v_effective_filter='own_entries' and d.user_id=public.app_user_id())
              or (v_effective_filter<>'own_entries' and public.daily_log_author_service(d.user_id)=v_effective_filter)
            ))
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
    md5(coalesce(string_agg(source_kind||':'||source_id||':'||snapshot::text,'|' order by source_kind,source_id),'')||':'||coalesce(v_effective_filter,'all'))
  into v_sources,v_hash from items;
  return jsonb_build_object('source_hash',v_hash,'sources',v_sources,'source_count',jsonb_array_length(v_sources),
    'effective_service_filter',v_effective_filter);
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. preview_report_sources_v2 — pass the new parameter through, default null (unchanged
--    behavior for any caller that doesn't send it yet).
-- ----------------------------------------------------------------------------
create or replace function public.preview_report_sources_v2(
  p_scope_type text,p_client_id text,p_subject_user_id text,p_employee_scope_mode text,p_employee_client_ids text[],
  p_period_start date,p_period_end_exclusive date,p_service_filter text default null
) returns jsonb language sql stable security definer set search_path=public,pg_temp
as $$ select public.report_source_manifest_v2($1,$2,$3,$4,$5,$6,$7,$8) $$;

-- ----------------------------------------------------------------------------
-- 6. create_report_draft_v2 — add p_service_filter, default null. The EFFECTIVE filter (after the
--    caller's own lock is applied — never the raw, client-requested value) is what gets persisted
--    on reports.client_service_filter and checked for creation-key consistency, exactly like
--    employee_scope_mode already is. A Locked agent's saved draft always records their forced
--    filter, never whatever (if anything) the browser happened to send.
-- ----------------------------------------------------------------------------
create or replace function public.create_report_draft_v2(
  p_scope_type text,p_client_id text,p_subject_user_id text,p_responsible_user_id text,
  p_employee_scope_mode text,p_employee_client_ids text[],p_period_start date,p_period_end_exclusive date,
  p_creator_note text,p_content_text text,p_expected_source_hash text,p_creation_key text,
  p_service_filter text default null
) returns public.reports language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_report public.reports%rowtype; v_manifest jsonb; v_hash text; v_version_id text; v_expected_responsible text;
  v_ids text[]; v_existing_content text; v_effective_filter text;
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
    v_ids,p_period_start,p_period_end_exclusive,p_service_filter);
  v_hash:=v_manifest->>'source_hash';
  v_effective_filter:=v_manifest->>'effective_service_filter';
  if p_expected_source_hash is distinct from v_hash then
    raise exception 'Report sources changed; rebuild the preview.' using errcode='40001';
  end if;
  insert into public.reports(id,client_id,type,period,generated_by,status,scope_type,subject_user_id,responsible_user_id,
    period_start,period_end_exclusive,creator_note,employee_scope_mode,employee_scope_client_ids,creation_key,source_hash,
    client_service_filter,created_at,updated_at)
  values('rpt-'||replace(gen_random_uuid()::text,'-',''),p_client_id,case when p_scope_type='client' then 'client' else 'internal' end,
    p_period_start::text||'_'||(p_period_end_exclusive-1)::text,public.app_user_id(),'draft',p_scope_type,p_subject_user_id,
    v_expected_responsible,p_period_start,p_period_end_exclusive,coalesce(p_creator_note,''),p_employee_scope_mode,
    case when p_employee_scope_mode='selected_clients' then v_ids else null end,p_creation_key,v_hash,
    v_effective_filter,now(),now()) returning * into v_report;
  insert into public.report_source_items(report_id,source_kind,source_id,source_date,user_id,client_id,snapshot)
  select v_report.id,x.source_kind,x.source_id,x.source_date,x.user_id,x.client_id,x.snapshot
  from jsonb_to_recordset(v_manifest->'sources') as x(source_kind text,source_id text,source_date date,user_id text,client_id text,snapshot jsonb);
  v_version_id:='rver-'||replace(gen_random_uuid()::text,'-','');
  insert into public.report_content_versions(id,report_id,version_no,content_text,source_hash,origin,created_by)
    values(v_version_id,v_report.id,1,p_content_text,v_hash,'generated',public.app_user_id());
  update public.reports set current_version_id=v_version_id where id=v_report.id returning * into v_report;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(v_report.id,public.app_user_id(),'created',
    jsonb_build_object('source_count',v_manifest->'source_count','employee_scope_mode',p_employee_scope_mode,
      'employee_scope_client_ids',case when p_employee_scope_mode='selected_clients' then to_jsonb(v_ids) else null end,
      'client_service_filter',v_effective_filter));
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

-- ----------------------------------------------------------------------------
-- 7. create_report_draft (legacy, backward-compatible entry point) — unchanged behavior: still
--    calls report_source_manifest_v2/create_report_draft_v2 without a service filter, so it keeps
--    defaulting to null ("All services") exactly as before. No redefinition needed; included here
--    only as a comment for reviewer context, since its call sites now resolve to the new
--    8/13-argument overloads above via PL/pgSQL default-argument matching.
-- ----------------------------------------------------------------------------

commit;
