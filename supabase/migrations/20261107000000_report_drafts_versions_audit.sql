-- Versioned report drafts, immutable source snapshots, AI proposals, and audit events.
-- Repository migration only: deploying/applying this file is a separate production action.

alter table public.reports
  add column if not exists scope_type text,
  add column if not exists subject_user_id text references public.users (id),
  add column if not exists responsible_user_id text references public.users (id),
  add column if not exists period_start date,
  add column if not exists period_end_exclusive date,
  add column if not exists creator_note text not null default '',
  add column if not exists current_version_id text,
  add column if not exists source_hash text,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text references public.users (id),
  add column if not exists archive_reason text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.reports drop constraint if exists reports_scope_type_check;
alter table public.reports add constraint reports_scope_type_check
  check (scope_type is null or scope_type in ('client', 'employee'));
alter table public.reports drop constraint if exists reports_new_scope_shape_check;
alter table public.reports add constraint reports_new_scope_shape_check check (
  scope_type is null
  or (scope_type = 'client' and client_id is not null and subject_user_id is null)
  or (scope_type = 'employee' and client_id is null and subject_user_id is not null)
);
alter table public.reports drop constraint if exists reports_period_bounds_check;
alter table public.reports add constraint reports_period_bounds_check
  check (period_start is null or period_end_exclusive is null or period_start < period_end_exclusive);

create index if not exists idx_reports_subject_user_id on public.reports (subject_user_id);
create index if not exists idx_reports_active_scope on public.reports (scope_type, client_id, subject_user_id)
  where archived_at is null;

create table if not exists public.report_content_versions (
  id text primary key default ('rver-' || replace(gen_random_uuid()::text, '-', '')),
  report_id text not null references public.reports (id) on delete restrict,
  version_no integer not null check (version_no > 0),
  content_text text not null,
  source_hash text not null,
  origin text not null check (origin in ('generated', 'manual', 'ai_applied', 'regenerated')),
  created_by text not null references public.users (id),
  created_at timestamptz not null default now(),
  unique (report_id, version_no)
);

alter table public.reports drop constraint if exists reports_current_version_id_fkey;
alter table public.reports add constraint reports_current_version_id_fkey
  foreign key (current_version_id) references public.report_content_versions (id) deferrable initially deferred;

create table if not exists public.report_source_items (
  id text primary key default ('rsrc-' || replace(gen_random_uuid()::text, '-', '')),
  report_id text not null references public.reports (id) on delete restrict,
  source_kind text not null check (source_kind in ('daily_log', 'extra_note')),
  source_id text not null,
  source_date date not null,
  user_id text not null references public.users (id),
  client_id text references public.clients (id),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (report_id, source_kind, source_id)
);

create table if not exists public.report_ai_suggestions (
  id text primary key default ('rais-' || replace(gen_random_uuid()::text, '-', '')),
  report_id text not null references public.reports (id) on delete restrict,
  base_version_id text not null references public.report_content_versions (id),
  source_hash text not null,
  suggested_text text not null,
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
  requested_by text not null references public.users (id),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  applied_by text references public.users (id)
);

create table if not exists public.report_audit_events (
  id text primary key default ('raud-' || replace(gen_random_uuid()::text, '-', '')),
  report_id text not null references public.reports (id) on delete restrict,
  actor_id text not null references public.users (id),
  action text not null check (action in ('created', 'edited', 'approved', 'ai_requested', 'ai_applied', 'archived', 'restored')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_report_versions_report on public.report_content_versions (report_id, version_no desc);
create index if not exists idx_report_sources_report on public.report_source_items (report_id, source_date);
create index if not exists idx_report_suggestions_report on public.report_ai_suggestions (report_id, created_at desc);
create index if not exists idx_report_audit_report on public.report_audit_events (report_id, created_at desc);
create index if not exists idx_daily_logs_client_date on public.daily_logs (client_id, date);
create index if not exists idx_daily_logs_user_date on public.daily_logs (user_id, date);
create index if not exists idx_extra_notes_user_date on public.extra_notes (user_id, date);

create or replace function public.report_subject_creatable(
  p_scope_type text,
  p_client_id text,
  p_subject_user_id text
) returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me text := public.app_user_id();
  v_role text := public.app_user_role();
  v_target_role text;
begin
  if v_me is null or p_scope_type not in ('client', 'employee') then return false; end if;
  if p_scope_type = 'employee' then
    if p_subject_user_id is null or p_client_id is not null then return false; end if;
    select role into v_target_role from public.users where id = p_subject_user_id and deactivated_at is null;
    if v_target_role is null then return false; end if;
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

create or replace function public.report_row_readable(p_report_id text) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
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
language plpgsql stable security definer set search_path = public
as $$
declare v_report public.reports%rowtype;
begin
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

revoke all on function public.report_subject_creatable(text,text,text) from public;
revoke all on function public.report_row_readable(text) from public;
revoke all on function public.report_row_editable(text) from public;
grant execute on function public.report_subject_creatable(text,text,text) to authenticated;
grant execute on function public.report_row_readable(text) to authenticated;
grant execute on function public.report_row_editable(text) to authenticated;

alter table public.report_content_versions enable row level security;
alter table public.report_source_items enable row level security;
alter table public.report_ai_suggestions enable row level security;
alter table public.report_audit_events enable row level security;

drop policy if exists report_versions_select_rls on public.report_content_versions;
create policy report_versions_select_rls on public.report_content_versions for select to authenticated
  using (public.report_row_readable(report_id));
drop policy if exists report_sources_select_rls on public.report_source_items;
create policy report_sources_select_rls on public.report_source_items for select to authenticated
  using (public.report_row_readable(report_id));
drop policy if exists report_suggestions_select_rls on public.report_ai_suggestions;
create policy report_suggestions_select_rls on public.report_ai_suggestions for select to authenticated
  using (public.report_row_readable(report_id));
drop policy if exists report_audit_select_rls on public.report_audit_events;
create policy report_audit_select_rls on public.report_audit_events for select to authenticated
  using (public.report_row_readable(report_id));

grant select on public.report_content_versions, public.report_source_items, public.report_ai_suggestions, public.report_audit_events to authenticated;
grant all on public.report_content_versions, public.report_source_items, public.report_ai_suggestions, public.report_audit_events to service_role;

drop policy if exists reports_select_rls on public.reports;
create policy reports_select_rls on public.reports for select to authenticated using (
  generated_by = public.app_user_id()
  or (scope_type = 'employee' and public.direct_report_visible(subject_user_id))
  or (scope_type = 'client' and public.report_scope_accessible(client_id, null))
  or (scope_type is null and comparison_id is not null and public.comparison_scope_accessible(comparison_id))
);
drop policy if exists reports_insert_rls on public.reports;
create policy reports_insert_rls on public.reports for insert to authenticated with check (
  -- Browser inserts remain available only to the legacy comparison-backed flow. Versioned
  -- reports must use create_report_draft(), which atomically writes sources/version/audit.
  generated_by = public.app_user_id()
  and scope_type is null
  and comparison_id is not null
  and public.comparison_scope_accessible(comparison_id)
);
drop policy if exists reports_update_rls on public.reports;
create policy reports_update_rls on public.reports for update to authenticated
  using (public.report_row_editable(id)) with check (
    public.report_row_editable(id) and (
      (scope_type is null and comparison_id is not null and public.comparison_scope_accessible(comparison_id))
      or (scope_type is not null and public.report_subject_creatable(scope_type, client_id, subject_user_id))
    )
  );

-- Direct browser writes are retained only for the legacy comparison-draft/approval flow. All
-- versioned-report content, identity, source, archive, and AI fields are RPC-only.
revoke update on public.reports from authenticated;
grant update (status, approved_by, approved_at, comparison_id, period, client_id, type, updated_at)
  on public.reports to authenticated;

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
language plpgsql security definer set search_path = public
as $$
declare
  v_report public.reports%rowtype;
  v_version_id text;
  v_hash text;
begin
  if not public.report_subject_creatable(p_scope_type, p_client_id, p_subject_user_id) then
    raise exception 'Not authorized to create this report.' using errcode = '42501';
  end if;
  if p_period_start is null or p_period_end_exclusive is null or p_period_start >= p_period_end_exclusive then
    raise exception 'Invalid report period.' using errcode = '22007';
  end if;

  insert into public.reports (
    id, client_id, type, period, generated_by, status, scope_type, subject_user_id,
    responsible_user_id, period_start, period_end_exclusive, creator_note, created_at, updated_at
  ) values (
    'rpt-' || replace(gen_random_uuid()::text, '-', ''), p_client_id,
    case when p_scope_type = 'client' then 'client' else 'internal' end,
    p_period_start::text || '_' || (p_period_end_exclusive - 1)::text,
    public.app_user_id(), 'draft', p_scope_type, p_subject_user_id, p_responsible_user_id,
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
    values (v_version_id, v_report.id, 1, coalesce(p_content_text, ''), v_hash, 'generated', public.app_user_id());
  update public.reports set current_version_id = v_version_id, source_hash = v_hash where id = v_report.id returning * into v_report;
  insert into public.report_audit_events (report_id, actor_id, action, metadata)
    values (v_report.id, public.app_user_id(), 'created', jsonb_build_object('source_count', (select count(*) from public.report_source_items where report_id = v_report.id)));
  return v_report;
end;
$$;

create or replace function public.save_report_version(p_report_id text, p_content_text text, p_origin text default 'manual')
returns public.report_content_versions
language plpgsql security definer set search_path = public
as $$
declare v_report public.reports%rowtype; v_version public.report_content_versions%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized to edit this report.' using errcode='42501'; end if;
  if p_origin not in ('manual','regenerated') then raise exception 'Invalid version origin.'; end if;
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

create or replace function public.archive_report(p_report_id text, p_reason text, p_restore boolean default false)
returns public.reports language plpgsql security definer set search_path=public
as $$
declare v_report public.reports%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized to archive this report.' using errcode='42501'; end if;
  if p_restore then
    update public.reports set archived_at=null,archived_by=null,archive_reason=null,updated_at=now() where id=p_report_id returning * into v_report;
    insert into public.report_audit_events(report_id,actor_id,action) values(p_report_id,public.app_user_id(),'restored');
  else
    update public.reports set archived_at=now(),archived_by=public.app_user_id(),archive_reason=nullif(trim(p_reason),''),updated_at=now() where id=p_report_id returning * into v_report;
    insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'archived',jsonb_build_object('reason',coalesce(nullif(trim(p_reason),''),'not provided')));
  end if;
  return v_report;
end;
$$;

create or replace function public.approve_report(p_report_id text)
returns public.reports language plpgsql security definer set search_path=public
as $$
declare v_report public.reports%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized to approve this report.' using errcode='42501'; end if;
  update public.reports set status='final',approved_by=public.app_user_id(),approved_at=now(),updated_at=now()
    where id=p_report_id and archived_at is null returning * into v_report;
  if not found then raise exception 'Report is archived or missing.'; end if;
  insert into public.report_audit_events(report_id,actor_id,action,metadata)
    values(p_report_id,public.app_user_id(),'approved',jsonb_build_object('version_id',v_report.current_version_id));
  return v_report;
end;
$$;

create or replace function public.create_report_ai_suggestion(p_report_id text,p_base_version_id text,p_source_hash text,p_suggested_text text)
returns public.report_ai_suggestions language plpgsql security definer set search_path=public
as $$
declare v_report public.reports%rowtype; v_suggestion public.report_ai_suggestions%rowtype;
begin
  if not public.report_row_editable(p_report_id) then raise exception 'Not authorized to request AI for this report.' using errcode='42501'; end if;
  select * into v_report from public.reports where id=p_report_id and archived_at is null;
  if v_report.current_version_id is distinct from p_base_version_id or v_report.source_hash is distinct from p_source_hash then raise exception 'The report changed while the suggestion was generated.' using errcode='40001'; end if;
  insert into public.report_ai_suggestions(report_id,base_version_id,source_hash,suggested_text,requested_by)
    values(p_report_id,p_base_version_id,p_source_hash,p_suggested_text,public.app_user_id()) returning * into v_suggestion;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(p_report_id,public.app_user_id(),'ai_requested',jsonb_build_object('suggestion_id',v_suggestion.id));
  return v_suggestion;
end;
$$;

create or replace function public.apply_report_ai_suggestion(p_suggestion_id text)
returns public.report_content_versions language plpgsql security definer set search_path=public
as $$
declare v_suggestion public.report_ai_suggestions%rowtype; v_report public.reports%rowtype; v_version public.report_content_versions%rowtype;
begin
  select * into v_suggestion from public.report_ai_suggestions where id=p_suggestion_id and status='pending' for update;
  if not found or not public.report_row_editable(v_suggestion.report_id) then raise exception 'Suggestion is unavailable.' using errcode='42501'; end if;
  select * into v_report from public.reports where id=v_suggestion.report_id and archived_at is null for update;
  if v_report.current_version_id is distinct from v_suggestion.base_version_id or v_report.source_hash is distinct from v_suggestion.source_hash then raise exception 'Suggestion is stale and cannot be applied.' using errcode='40001'; end if;
  insert into public.report_content_versions(report_id,version_no,content_text,source_hash,origin,created_by)
    values(v_report.id,(select coalesce(max(version_no),0)+1 from public.report_content_versions where report_id=v_report.id),v_suggestion.suggested_text,v_report.source_hash,'ai_applied',public.app_user_id()) returning * into v_version;
  update public.reports set current_version_id=v_version.id,updated_at=now() where id=v_report.id;
  update public.report_ai_suggestions set status='applied',applied_at=now(),applied_by=public.app_user_id() where id=p_suggestion_id;
  insert into public.report_audit_events(report_id,actor_id,action,metadata) values(v_report.id,public.app_user_id(),'ai_applied',jsonb_build_object('suggestion_id',p_suggestion_id,'version_id',v_version.id));
  return v_version;
end;
$$;

revoke all on function public.create_report_draft(text,text,text,text,date,date,text,text) from public;
revoke all on function public.save_report_version(text,text,text) from public;
revoke all on function public.archive_report(text,text,boolean) from public;
revoke all on function public.approve_report(text) from public;
revoke all on function public.create_report_ai_suggestion(text,text,text,text) from public;
revoke all on function public.apply_report_ai_suggestion(text) from public;
grant execute on function public.create_report_draft(text,text,text,text,date,date,text,text) to authenticated;
grant execute on function public.save_report_version(text,text,text) to authenticated;
grant execute on function public.archive_report(text,text,boolean) to authenticated;
grant execute on function public.approve_report(text) to authenticated;
grant execute on function public.create_report_ai_suggestion(text,text,text,text) to authenticated;
grant execute on function public.apply_report_ai_suggestion(text) to authenticated;
