-- Continuing the same audit: these RPC action-functions also called
-- app_user_role()/app_user_id()/app_user_team() more than once per invocation. Unlike
-- task_visible_v2/employee_visible/report_scope_accessible, these don't run per-ROW under RLS —
-- each runs once per discrete user action (viewing a brief, reading client access credentials,
-- archiving/approving a report) — so the redundant calls here cost a few extra users-table
-- lookups per action, not thousands per page load. Real waste, just a smaller multiplier; fixed
-- for the same reason and the same way: compute each repeated value once into a local variable at
-- the top of the function body, reference the variable everywhere the function previously called
-- app_user_role()/app_user_id()/app_user_team() directly. Zero logic change — every condition,
-- comparison and branch is identical to before, confirmed by generating this rewrite as a pure
-- mechanical substitution (declare the variable, assign it from the exact original call, replace
-- every other occurrence of that same call with the variable) rather than retyped by hand.
-- Same signatures as before, so existing grants on each function are preserved automatically by
-- CREATE OR REPLACE FUNCTION (Postgres never resets ACLs on a same-signature replace).
begin;

create or replace function public.mark_brief_viewed(p_brief_id text)
returns public.briefs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_brief public.briefs; v_cached_role text;
begin
  v_cached_role:=public.app_user_role();

  select * into v_brief from public.briefs where id = p_brief_id;
  if not found then
    raise exception 'Brief not found';
  end if;
  if not (
    v_cached_role = 'head_of_technical'
    or (v_cached_role = 'seo_team_lead' and v_brief.service_type = 'seo' and public.client_has_service(v_brief.client_id, 'seo'))
    or (v_cached_role = 'media_buying_team_lead' and v_brief.service_type = 'media_buying' and public.client_has_service(v_brief.client_id, 'media_buying'))
    or (v_cached_role = 'social_media_team_lead' and v_brief.service_type = 'social_media' and public.client_has_service(v_brief.client_id, 'social_media'))
  ) then
    raise exception 'You do not have permission to mark this brief as viewed.';
  end if;
  update public.briefs set team_lead_viewed_at = now()
  where id = p_brief_id returning * into v_brief;
  return v_brief;
end;
$$;

create or replace function public.get_client_access(p_client_id text)
returns table (
  general_email text,
  general_email_password text,
  store_platform_username text,
  store_platform_password text,
  social_media_username text,
  social_media_password text,
  ad_account_username text,
  ad_account_password text,
  ad_account_setup_type text,
  payment_card_details text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients; v_cached_role text; v_cached_uid text;
begin
  v_cached_role:=public.app_user_role();
  v_cached_uid:=public.app_user_id();

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = v_cached_uid)
  ) then
    raise exception 'You do not have permission to view this client''s access details.';
  end if;

  insert into public.client_access_log (client_id, accessed_by)
  values (p_client_id, v_cached_uid);

  return query select
    v_client.general_email,
    v_client.general_email_password,
    v_client.store_platform_username,
    v_client.store_platform_password,
    v_client.social_media_username,
    v_client.social_media_password,
    v_client.ad_account_username,
    v_client.ad_account_password,
    v_client.ad_account_setup_type,
    v_client.payment_card_details;
end;
$$;

create or replace function public.get_client_access_attachments(p_client_id text)
returns table (
  id text,
  storage_path text,
  filename text,
  file_size bigint,
  mime_type text,
  label text,
  uploaded_by text,
  uploaded_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients; v_cached_role text; v_cached_uid text;
begin
  v_cached_role:=public.app_user_role();
  v_cached_uid:=public.app_user_id();

  select * into v_client from public.clients c where c.id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    v_cached_role = 'ai_engineer'
    or v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = v_cached_uid)
  ) then
    raise exception 'You do not have permission to view this client''s access attachments.';
  end if;

  insert into public.client_access_log (client_id, accessed_by)
  values (p_client_id, v_cached_uid);

  return query
    select caa.id, caa.storage_path, caa.filename, caa.file_size, caa.mime_type, caa.label,
           caa.uploaded_by, caa.uploaded_at
    from public.client_access_attachments caa
    where caa.client_id = p_client_id
    order by caa.uploaded_at desc;
end;
$$;

create or replace function public.insert_client_access_attachment(
  p_client_id text,
  p_storage_path text,
  p_filename text,
  p_file_size bigint,
  p_mime_type text,
  p_label text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_id text; v_cached_role text; v_cached_uid text;
begin
  v_cached_role:=public.app_user_role();
  v_cached_uid:=public.app_user_id();

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    v_cached_role = 'ai_engineer'
    or v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = v_cached_uid)
  ) then
    raise exception 'You do not have permission to upload an access attachment for this client.';
  end if;

  v_id := 'cxa-' || replace(gen_random_uuid()::text, '-', '');

  insert into public.client_access_attachments
    (id, client_id, storage_path, filename, file_size, mime_type, label, uploaded_by)
  values
    (v_id, p_client_id, p_storage_path, p_filename, p_file_size, p_mime_type, p_label, v_cached_uid);

  return v_id;
end;
$$;

create or replace function public.delete_client_access_attachment(p_attachment_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.client_access_attachments;
  v_client public.clients; v_cached_role text;
begin
  v_cached_role:=public.app_user_role();

  select * into v_row from public.client_access_attachments where id = p_attachment_id;
  if not found then
    raise exception 'Attachment not found';
  end if;

  select * into v_client from public.clients where id = v_row.client_id;

  if not (
    v_cached_role = 'ai_engineer'
    or v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to delete this client''s access attachment.';
  end if;

  delete from public.client_access_attachments where id = p_attachment_id;
end;
$$;

create or replace function public.update_client_access(
  p_client_id text,
  p_general_email text,
  p_general_email_password text,
  p_store_platform_username text,
  p_store_platform_password text,
  p_social_media_username text,
  p_social_media_password text,
  p_ad_account_username text,
  p_ad_account_password text,
  p_ad_account_setup_type text,
  p_payment_card_details text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients; v_cached_role text;
begin
  v_cached_role:=public.app_user_role();

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to edit this client''s access details.';
  end if;

  update public.clients
  set
    general_email = p_general_email,
    general_email_password = p_general_email_password,
    store_platform_username = p_store_platform_username,
    store_platform_password = p_store_platform_password,
    social_media_username = p_social_media_username,
    social_media_password = p_social_media_password,
    ad_account_username = p_ad_account_username,
    ad_account_password = p_ad_account_password,
    ad_account_setup_type = p_ad_account_setup_type,
    payment_card_details = p_payment_card_details
  where id = p_client_id;
end;
$$;

create or replace function public.report_row_editable(p_report_id text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_report public.reports%rowtype; v_cached_role text;
begin
  v_cached_role:=public.app_user_role();

  if not public.report_module_accessible() then return false; end if;
  select * into v_report from public.reports where id = p_report_id;
  if not found then return false; end if;
  if v_report.generated_by = public.app_user_id() then return true; end if;
  if v_cached_role in ('executive', 'head_of_technical') then return true; end if;
  if v_cached_role = 'ai_engineer' then return false; end if;
  if v_report.scope_type is null and v_report.comparison_id is not null then
    return public.comparison_scope_accessible(v_report.comparison_id);
  end if;
  return public.report_subject_creatable(v_report.scope_type, v_report.client_id, v_report.subject_user_id);
end;
$$;

create or replace function public.apply_report_ai_suggestion(p_suggestion_id text)
returns public.report_content_versions language plpgsql security definer set search_path=public,pg_temp as $$
declare v_s public.report_ai_suggestions%rowtype; v_r public.reports%rowtype; v_v public.report_content_versions%rowtype; v_cached_uid text;
begin
  v_cached_uid:=public.app_user_id();

  select * into v_s from public.report_ai_suggestions where id=p_suggestion_id and status='pending' for update;
  if not found or not public.report_row_editable(v_s.report_id) then raise exception 'Suggestion unavailable.' using errcode='42501'; end if;
  select * into v_r from public.reports where id=v_s.report_id for update;
  if v_r.archived_at is not null or v_r.status='final' then raise exception 'Final or archived reports are immutable.' using errcode='55000'; end if;
  if v_r.current_version_id is distinct from v_s.base_version_id or v_r.source_hash is distinct from v_s.source_hash then raise exception 'Suggestion is stale.' using errcode='40001'; end if;
  insert into public.report_content_versions(report_id,version_no,content_text,source_hash,origin,created_by)
    values(v_r.id,(select coalesce(max(version_no),0)+1 from public.report_content_versions where report_id=v_r.id),v_s.suggested_text,v_r.source_hash,'ai_applied',v_cached_uid) returning * into v_v;
  update public.reports set current_version_id=v_v.id,updated_at=now() where id=v_r.id;
  update public.report_ai_suggestions set status='applied',applied_at=now(),applied_by=v_cached_uid where id=p_suggestion_id;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(v_r.id,v_cached_uid,'ai_applied',jsonb_build_object('suggestion_id',p_suggestion_id,'version_id',v_v.id));
  return v_v;
end $$;

create or replace function public.archive_report_v2(p_report_id text,p_reason text,p_restore boolean,p_expected_version_id text)
returns public.reports language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.reports%rowtype; v_cached_uid text;
begin
  v_cached_uid:=public.app_user_id();

  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  select * into v_report from public.reports where id=p_report_id for update;
  if not found then raise exception 'Report missing.'; end if;
  if p_expected_version_id is null or v_report.current_version_id is distinct from p_expected_version_id then raise exception 'Report changed; refresh before changing archive state.' using errcode='40001'; end if;
  if p_restore then
    if v_report.archived_at is null then raise exception 'Report is not archived.' using errcode='55000'; end if;
    update public.reports set archived_at=null,archived_by=null,archive_reason=null,updated_at=now() where id=p_report_id returning * into v_report;
    insert into public.report_audit_events(report_id,actor_id,action) values(p_report_id,v_cached_uid,'restored');
  else
    if v_report.archived_at is not null then raise exception 'Report is already archived.' using errcode='55000'; end if;
    if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Archive reason is required.' using errcode='22023'; end if;
    update public.reports set archived_at=now(),archived_by=v_cached_uid,archive_reason=trim(p_reason),updated_at=now() where id=p_report_id returning * into v_report;
    insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,v_cached_uid,'archived',jsonb_build_object('reason',trim(p_reason),'expected_version_id',p_expected_version_id));
  end if; return v_report;
end $$;

create or replace function public.approve_report_v2(p_report_id text,p_expected_version_id text) returns public.reports
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.reports%rowtype; v_cached_uid text;
begin
  v_cached_uid:=public.app_user_id();

  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized.' using errcode='42501'; end if;
  select * into v_report from public.reports where id=p_report_id for update;
  if not found or v_report.archived_at is not null or v_report.status='final' or v_report.current_version_id is null then raise exception 'Report cannot be approved in its current state.' using errcode='55000'; end if;
  if p_expected_version_id is null or v_report.current_version_id is distinct from p_expected_version_id then raise exception 'Report changed; refresh before approval.' using errcode='40001'; end if;
  update public.reports set status='final',approved_by=v_cached_uid,approved_at=now(),updated_at=now() where id=p_report_id returning * into v_report;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,v_cached_uid,'approved',jsonb_build_object('version_id',v_report.current_version_id));
  return v_report;
end $$;

commit;
