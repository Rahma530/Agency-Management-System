-- Close the remaining server-side authorization and integrity gaps in the versioned report
-- workspace. This follows the base workspace migration so environments that already applied the
-- first file receive the same hardening without rewriting migration history.

create or replace function public.report_role_has_module(p_role text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_role in (
    'executive', 'head_of_technical', 'am_team_lead', 'am_agent',
    'media_buying_team_lead', 'media_buying_agent', 'seo_team_lead', 'seo_agent',
    'store_manager', 'seo_content_agent', 'seo_backlink_agent',
    'social_media_team_lead', 'social_media_agent', 'ai_engineer'
  ) or exists (
    select 1
    from public.custom_roles cr
    join public.custom_role_modules crm on crm.role_id = cr.id
    where cr.id = p_role and cr.is_active and crm.module_id = 'reports'
  );
$$;

create or replace function public.report_module_accessible() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = public.app_user_id() and u.deactivated_at is null
      and public.report_role_has_module(u.role)
  );
$$;

create or replace function public.report_role_is_subject(p_role text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_role in (
    'am_agent', 'media_buying_agent', 'seo_agent', 'store_manager',
    'seo_content_agent', 'seo_backlink_agent', 'social_media_agent'
  ) or exists (
    select 1
    from public.custom_roles cr
    join public.custom_role_modules crm on crm.role_id = cr.id
    where cr.id = p_role and cr.is_active and crm.module_id = 'reports'
  );
$$;

create or replace function public.report_subject_creatable(
  p_scope_type text,
  p_client_id text,
  p_subject_user_id text
) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_me text := public.app_user_id();
  v_role text := public.app_user_role();
  v_target_role text;
begin
  if v_me is null or not public.report_module_accessible()
    or p_scope_type not in ('client', 'employee') then
    return false;
  end if;
  if p_scope_type = 'employee' then
    if p_subject_user_id is null or p_client_id is not null then return false; end if;
    select role into v_target_role from public.users where id = p_subject_user_id and deactivated_at is null;
    if v_target_role is null or not public.report_role_is_subject(v_target_role) then return false; end if;
    if p_subject_user_id = v_me then return true; end if;
    if v_role in ('executive', 'head_of_technical') then return true; end if;
    if v_role = 'ai_engineer' then return false; end if;
    return (v_role = 'am_team_lead' and v_target_role = 'am_agent')
      or (v_role = 'media_buying_team_lead' and v_target_role = 'media_buying_agent')
      or (v_role = 'seo_team_lead' and v_target_role in ('seo_agent','store_manager','seo_content_agent','seo_backlink_agent'))
      or (v_role = 'social_media_team_lead' and v_target_role = 'social_media_agent');
  end if;
  if p_client_id is null or p_subject_user_id is not null or v_role = 'ai_engineer' then return false; end if;
  return public.report_scope_accessible(p_client_id, null);
end;
$$;

revoke all on function public.report_role_has_module(text) from public;
revoke all on function public.report_role_is_subject(text) from public;
revoke all on function public.report_module_accessible() from public;
revoke all on function public.report_subject_creatable(text,text,text) from public;
grant execute on function public.report_module_accessible() to authenticated;
grant execute on function public.report_subject_creatable(text,text,text) to authenticated;

create or replace function public.report_row_readable(p_report_id text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select public.report_module_accessible() and exists (
    select 1 from public.reports r
    where r.id = p_report_id and (
      r.generated_by = public.app_user_id()
      or (r.scope_type = 'employee' and public.direct_report_visible(r.subject_user_id))
      or (r.scope_type = 'client' and public.report_scope_accessible(r.client_id, null))
      or (r.scope_type is null and r.comparison_id is not null and public.comparison_scope_accessible(r.comparison_id))
    )
  );
$$;

create or replace function public.report_row_editable(p_report_id text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_report public.reports%rowtype;
begin
  if not public.report_module_accessible() then return false; end if;
  select * into v_report from public.reports where id = p_report_id;
  if not found then return false; end if;
  if v_report.generated_by = public.app_user_id() then return true; end if;
  if public.app_user_role() in ('executive', 'head_of_technical') then return true; end if;
  if public.app_user_role() = 'ai_engineer' then return false; end if;
  if v_report.scope_type is null and v_report.comparison_id is not null then
    return public.comparison_scope_accessible(v_report.comparison_id);
  end if;
  return public.report_subject_creatable(v_report.scope_type, v_report.client_id, v_report.subject_user_id);
end;
$$;

drop policy if exists reports_select_rls on public.reports;
create policy reports_select_rls on public.reports for select to authenticated
  using (public.report_row_readable(id));
drop policy if exists reports_insert_rls on public.reports;
create policy reports_insert_rls on public.reports for insert to authenticated with check (
  public.report_module_accessible()
  and generated_by = public.app_user_id()
  and scope_type is null
  and comparison_id is not null
  and public.comparison_scope_accessible(comparison_id)
);

alter table public.reports drop constraint if exists reports_creator_note_length_check;
alter table public.reports add constraint reports_creator_note_length_check
  check (char_length(creator_note) <= 4000);
alter table public.report_content_versions drop constraint if exists report_content_versions_length_check;
alter table public.report_content_versions add constraint report_content_versions_length_check
  check (char_length(content_text) between 1 and 12000);
alter table public.report_ai_suggestions drop constraint if exists report_ai_suggestions_length_check;
alter table public.report_ai_suggestions add constraint report_ai_suggestions_length_check
  check (char_length(suggested_text) between 1 and 12000);

create or replace function public.report_numeric_tokens(p_text text) returns text[]
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct replace(m[1], ',', '.')), array[]::text[])
  from regexp_matches(
    translate(coalesce(p_text, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
    '-?[0-9]+(?:[.,][0-9]+)?',
    'g'
  ) as m;
$$;

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

create or replace function public.save_report_version(p_report_id text, p_content_text text, p_origin text default 'manual')
returns public.report_content_versions
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_report public.reports%rowtype; v_version public.report_content_versions%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized to edit this report.' using errcode='42501'; end if;
  if p_origin not in ('manual','regenerated') then raise exception 'Invalid version origin.'; end if;
  if nullif(trim(coalesce(p_content_text, '')), '') is null or char_length(p_content_text) > 12000 then
    raise exception 'Report content is invalid.' using errcode='22023';
  end if;
  select * into v_report from public.reports where id = p_report_id and archived_at is null for update;
  if not found then raise exception 'Report is archived or missing.'; end if;
  insert into public.report_content_versions (report_id, version_no, content_text, source_hash, origin, created_by)
  values (p_report_id, (select coalesce(max(version_no),0)+1 from public.report_content_versions where report_id=p_report_id), p_content_text, v_report.source_hash, p_origin, public.app_user_id())
  returning * into v_version;
  update public.reports set current_version_id=v_version.id, updated_at=now() where id=p_report_id;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'edited',jsonb_build_object('version_id',v_version.id));
  return v_version;
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
    string_agg(source_date::text || ' ' || coalesce(snapshot->>'summary_text', snapshot->>'note_text', ''), E'\n' order by source_date, source_kind, source_id))
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

create or replace function public.update_legacy_report_draft(
  p_report_id text,
  p_comparison_id text,
  p_period text,
  p_client_id text,
  p_type text
) returns public.reports
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_report public.reports%rowtype;
  v_comparison public.client_comparisons%rowtype;
begin
  select * into v_report from public.reports where id=p_report_id and scope_type is null for update;
  if not found or not public.report_row_editable(p_report_id) then
    raise exception 'Legacy report is unavailable.' using errcode='42501';
  end if;
  select * into v_comparison from public.client_comparisons where id=p_comparison_id;
  if not found or not public.comparison_scope_accessible(p_comparison_id)
    or v_comparison.client_id is null or v_comparison.client_id is distinct from p_client_id
    or p_type <> 'client' or v_comparison.period_current is distinct from p_period then
    raise exception 'Invalid legacy report scope.' using errcode='42501';
  end if;
  update public.reports set client_id=v_comparison.client_id,type='client',period=v_comparison.period_current,comparison_id=p_comparison_id,
    status='draft',approved_by=null,approved_at=null,updated_at=now()
  where id=p_report_id returning * into v_report;
  return v_report;
end;
$$;

-- Versioned reports and legacy mutations now use audited/validated RPCs exclusively.
revoke update on public.reports from authenticated;
revoke all on function public.report_numeric_tokens(text) from public;
revoke all on function public.update_legacy_report_draft(text,text,text,text,text) from public;
grant execute on function public.update_legacy_report_draft(text,text,text,text,text) to authenticated;
grant execute on function public.report_numeric_tokens(text) to authenticated;
