-- Report service buckets: multi-select services + a dedicated Creative bucket.
--
-- Until now reports.client_service_filter / p_service_filter held ONE service (or null = every
-- service). Two things changed:
--   1. p_service_filter (and reports.client_service_filter) may now be a comma-separated LIST of
--      buckets, e.g. 'media_buying,social_media,seo,interface,creation,other'. The signatures do
--      NOT change (no new overloads, nothing to drop), so preview_report_sources_v2 and
--      create_report_draft_v2 keep working as they are and simply pass the string through.
--   2. A new bucket 'creative' = work done by graphic_designer / video_editor (a shared pool with
--      no ServiceType). 'other' = work by a role that maps to no service (AM, technical, etc).
--
-- A source is included when its author's bucket is one of the listed buckets:
--   bucket = 'creative'  if the author's role is graphic_designer / video_editor,
--   bucket = daily_log_author_service(user) if that is not null (seo / media_buying /
--            social_media / interface / creation),
--   bucket = 'other'     otherwise.
-- Single-value filters keep their exact previous meaning, because a single service maps to the
-- same authors as before (creative roles never had a service, so they never matched one).
--
-- Unchanged on purpose:
--   - A Locked role's own lock still wins over whatever filter the caller sends
--     (report_caller_client_service_lock), including 'own_entries'.
--   - Employee-scope manifests and every other RPC are untouched.
--   - source_hash still covers the effective filter, so a different selection is a different
--     report and save-time hash checks keep working.
--
-- Idempotent: create or replace / drop constraint if exists / create constraint.
-- Note: no rollback file. Reverting means re-applying 20261125000000 for the manifest function
-- and restoring its constraint, which only works while no list-valued report exists.

begin;

-- ----------------------------------------------------------------------------
-- 1. Allowed values on stored reports: a list of known buckets (or the lock's own_entries).
-- ----------------------------------------------------------------------------
alter table public.reports drop constraint if exists reports_client_service_filter_check;
alter table public.reports add constraint reports_client_service_filter_check check (
  client_service_filter is null
  or (scope_type = 'client' and string_to_array(client_service_filter, ',') <@ array[
    'seo','media_buying','social_media','interface','creation','other','creative','own_entries'
  ]::text[])
);

-- ----------------------------------------------------------------------------
-- 2. Validation of a client-requested filter (lock values are never sent by the client).
-- ----------------------------------------------------------------------------
create or replace function public.report_service_filter_valid(p_filter text)
returns boolean
language sql immutable
as $$
  select cardinality(string_to_array(p_filter, ',')) > 0
    and string_to_array(p_filter, ',') <@ array[
      'seo','media_buying','social_media','interface','creation','other','creative'
    ]::text[];
$$;

-- ----------------------------------------------------------------------------
-- 3. Bucket of one work author (see the header for the rules).
-- ----------------------------------------------------------------------------
create or replace function public.report_bucket_for_user(p_user_id text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when (select u.role from public.users u where u.id = p_user_id) in ('graphic_designer','video_editor')
      then 'creative'
    else coalesce(public.daily_log_author_service(p_user_id), 'other')
  end;
$$;

-- ----------------------------------------------------------------------------
-- 4. report_source_manifest_v2 — same signature and output shape as 20261125000000. Only the
--    validation of p_service_filter and the author predicate in eligible_logs changed.
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

  if p_service_filter is not null and not public.report_service_filter_valid(p_service_filter) then
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
              or (v_effective_filter<>'own_entries'
                  and public.report_bucket_for_user(d.user_id) = any(string_to_array(v_effective_filter, ',')))
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

commit;
