-- Raise the hard cap on reports.content_text (p_content_text) from 12,000 to 60,000 characters.
--
-- Bug: create_report_draft_v2/save_report_version_v2 rejected "Invalid report content." the
-- moment char_length(p_content_text) > 12000. The draft text embeds each attachment's FULL signed
-- storage URL (ReportDraftWorkspace.tsx's renderWorkLogSection/renderLine -- the "View attachment"
-- short label is only substituted at PDF/HTML export time, never in the saved content_text
-- itself), and a signed URL is roughly 250-400 characters on its own. A client with many
-- attachments across a report period hit the 12,000 cap purely from URL text, with no actual
-- excess of real work-log content -- the error gave no hint of this, it just refused the save.
--
-- 60,000 is a generous bump, not an unbounded one: text columns have no inherent Postgres length
-- limit, so this is purely an app-level sanity cap against something pathological (a paste gone
-- wrong, a runaway AI rewrite), not a tuned "normal report" ceiling. Raise it again later if a
-- genuinely large report with many attachments still hits it.
--
-- Both function bodies below are otherwise byte-identical to their source migrations
-- (create_report_draft_v2: 20261125000000_report_client_service_filter.sql; save_report_version_v2:
-- 20261107300000_report_workspace_lifecycle_hardening.sql) -- only the 12000 -> 60000 numbers changed.
--
-- Idempotent: create or replace. No rollback file -- reverting means re-applying the matching
-- function body from the migrations named above, with char_length(...)>12000 restored.

begin;

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
  if nullif(trim(coalesce(p_content_text,'')),'') is null or char_length(p_content_text)>60000
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

create or replace function public.save_report_version_v2(p_report_id text,p_content_text text,p_origin text,p_expected_version_id text)
returns public.report_content_versions language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.reports%rowtype; v_version public.report_content_versions%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  if p_origin not in ('manual','regenerated') or nullif(trim(coalesce(p_content_text,'')),'') is null or char_length(p_content_text)>60000 then raise exception 'Invalid content.' using errcode='22023'; end if;
  select * into v_report from public.reports where id=p_report_id for update;
  if not found or v_report.archived_at is not null or v_report.status='final' then raise exception 'Final or archived reports are immutable.' using errcode='55000'; end if;
  if p_expected_version_id is null or v_report.current_version_id is distinct from p_expected_version_id then raise exception 'Report changed; refresh before saving.' using errcode='40001'; end if;
  insert into public.report_content_versions(report_id,version_no,content_text,source_hash,origin,created_by)
    values(p_report_id,(select coalesce(max(version_no),0)+1 from public.report_content_versions where report_id=p_report_id),p_content_text,v_report.source_hash,p_origin,public.app_user_id()) returning * into v_version;
  update public.reports set current_version_id=v_version.id,updated_at=now() where id=p_report_id;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'edited',jsonb_build_object('version_id',v_version.id,'expected_version_id',p_expected_version_id));
  return v_version;
end $$;

commit;
