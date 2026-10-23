-- SERVICE BRIEF SUBMIT — END-TO-END RELEASE CANDIDATE (STATIC REVIEW ONLY; NOT EXECUTED).
--
-- Scope:
--   1. Add public.briefs.submitted_at as nullable timestamptz with no default, when absent.
--   2. Recreate briefs_select_rls, briefs_update_rls, and briefs_write_rls from the approved
--      migration lineage, retaining ai_engineer parity and mapping every confirmed Agent role to
--      its own service assignment.
--   3. Add one restrictive SELECT publication gate so unrelated permissive policies cannot expose
--      drafts to employee service-team roles.
--   4. Preserve mark_brief_viewed(text), briefs_select_designer_social, and
--      briefs_select_portal_rls without changing their definitions.
--
-- Historical data:
--   No row is backfilled or automatically published. If submitted_at is newly added, every
--   existing row receives NULL. If it already exists, every existing value is left unchanged.
--   Approved historical rows must be restored separately by explicit ID.
--
-- RLS composition:
--   Permissive policies combine with OR. Restrictive policies combine with AND against the
--   permissive result. briefs_submission_gate_rls therefore requires publication for employee
--   service-team roles without changing the row scopes granted by the existing policies.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare
  v_rls_enabled boolean;
  v_column_exists boolean;
  v_column_is_timestamptz boolean;
  v_column_is_nullable boolean;
  v_column_default text;
  v_unexpected_published_rows boolean;
  v_server_version_num integer;
  v_designer_qual text;
  v_portal_qual text;
begin
  v_server_version_num := current_setting('server_version_num')::integer;
  if v_server_version_num < 100000 then
    raise exception 'Release preflight failed: PostgreSQL 10 or newer is required for restrictive policies; detected server_version_num %.', v_server_version_num;
  end if;

  if to_regrole('authenticated') is null then
    raise exception 'Release preflight failed: required role authenticated is missing.';
  end if;

  if to_regclass('public.briefs') is null then
    raise exception 'Release preflight failed: required table public.briefs is missing.';
  end if;

  select c.relrowsecurity
  into v_rls_enabled
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'briefs'
    and c.relkind in ('r', 'p');

  if v_rls_enabled is distinct from true then
    raise exception 'Release preflight failed: RLS must already be enabled on public.briefs.';
  end if;

  if exists (
    select 1
    from (values
      ('id'),
      ('client_id'),
      ('service_type'),
      ('submitted_by'),
      ('team_lead_viewed_at')
    ) as required(column_name)
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'briefs'
        and c.column_name = required.column_name
    )
  ) then
    raise exception 'Release preflight failed: public.briefs is missing one or more required columns.';
  end if;

  if to_regprocedure('public.app_user_role()') is null
    or to_regprocedure('public.app_user_id()') is null
    or to_regprocedure('public.portal_client_id()') is null
    or to_regprocedure('public.client_am_agent_is_caller(text)') is null
    or to_regprocedure('public.client_has_service(text,text)') is null
    or to_regprocedure('public.agent_assigned(text,text)') is null
    or to_regprocedure('public.agent_assigned_any_service(text)') is null then
    raise exception 'Release preflight failed: one or more required authorization functions are missing.';
  end if;

  if exists (
    select 1
    from (values
      ('public.app_user_role()'),
      ('public.app_user_id()'),
      ('public.portal_client_id()'),
      ('public.client_am_agent_is_caller(text)'),
      ('public.client_has_service(text,text)'),
      ('public.agent_assigned(text,text)')
    ) as required(function_signature)
    where not has_function_privilege(
      'authenticated',
      required.function_signature,
      'EXECUTE'
    )
  ) then
    raise exception 'Release preflight failed: authenticated cannot execute one or more functions used by the final RLS policies.';
  end if;

  if to_regprocedure('public.mark_brief_viewed(text)') is null then
    raise exception 'Release preflight failed: public.mark_brief_viewed(text) is missing.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.mark_brief_viewed(text)',
    'EXECUTE'
  ) then
    raise exception 'Release preflight failed: authenticated cannot execute public.mark_brief_viewed(text).';
  end if;

  if not has_table_privilege('authenticated', 'public.briefs', 'SELECT')
    or not has_table_privilege('authenticated', 'public.briefs', 'INSERT')
    or not has_table_privilege('authenticated', 'public.briefs', 'UPDATE') then
    raise exception 'Release preflight failed: authenticated must already have effective SELECT, INSERT, and UPDATE on public.briefs.';
  end if;

  if exists (
    select required.policyname
    from (values
      ('briefs_select_rls'),
      ('briefs_select_designer_social'),
      ('briefs_update_rls'),
      ('briefs_write_rls'),
      ('briefs_select_portal_rls')
    ) as required(policyname)
    where not exists (
      select 1
      from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename = 'briefs'
        and p.policyname = required.policyname
    )
  ) then
    raise exception 'Release preflight failed: one or more expected briefs policies are missing.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'briefs'
      and p.policyname in ('briefs_select_designer_social', 'briefs_select_portal_rls')
      and (
        p.cmd <> 'SELECT'
        or p.permissive <> 'PERMISSIVE'
        or not ('authenticated'::name = any (p.roles))
      )
  ) then
    raise exception 'Release preflight failed: preserved Designer/Portal policies are not permissive authenticated SELECT policies as expected.';
  end if;

  select lower(p.qual)
  into v_designer_qual
  from pg_catalog.pg_policies p
  where p.schemaname = 'public'
    and p.tablename = 'briefs'
    and p.policyname = 'briefs_select_designer_social';

  select lower(p.qual)
  into v_portal_qual
  from pg_catalog.pg_policies p
  where p.schemaname = 'public'
    and p.tablename = 'briefs'
    and p.policyname = 'briefs_select_portal_rls';

  if v_designer_qual is null
    or position('graphic_designer' in v_designer_qual) = 0
    or position('video_editor' in v_designer_qual) = 0
    or position('submitted_by' in v_designer_qual) = 0
    or position('app_user_id' in v_designer_qual) = 0 then
    raise exception 'Release preflight failed: the preserved Designer policy has an unexpected scope.';
  end if;

  if v_portal_qual is null
    or position('client_id' in v_portal_qual) = 0
    or position('portal_client_id' in v_portal_qual) = 0 then
    raise exception 'Release preflight failed: the preserved Portal policy is not client-scoped as expected.';
  end if;

  select exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'briefs'
      and c.column_name = 'submitted_at'
  ) into v_column_exists;

  if v_column_exists then
    select
      c.udt_name = 'timestamptz',
      c.is_nullable = 'YES',
      c.column_default
    into v_column_is_timestamptz, v_column_is_nullable, v_column_default
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'briefs'
      and c.column_name = 'submitted_at';

    if v_column_is_timestamptz is distinct from true
      or v_column_is_nullable is distinct from true
      or v_column_default is not null then
      raise exception 'Release preflight failed: existing submitted_at must be nullable timestamptz with no default; existing data was not changed.';
    end if;

    raise notice 'submitted_at already exists; all historical values are intentionally left unchanged.';
  else
    execute 'alter table public.briefs add column submitted_at timestamptz null';

    execute 'select exists (select 1 from public.briefs where submitted_at is not null)'
    into v_unexpected_published_rows;

    if v_unexpected_published_rows then
      raise exception 'Release failed: adding submitted_at unexpectedly classified an existing row as published.';
    end if;
  end if;

  if not has_column_privilege(
    'authenticated',
    'public.briefs',
    'submitted_at',
    'UPDATE'
  ) then
    raise exception 'Release preflight failed: authenticated lacks effective UPDATE on public.briefs.submitted_at; no GRANT was added.';
  end if;
end
$$;

-- Permissive business-scope policy. Service-team branches require publication directly, and the
-- restrictive gate below prevents a different permissive policy from bypassing that requirement.
drop policy if exists "briefs_select_rls" on public.briefs;
create policy "briefs_select_rls" on public.briefs
as permissive
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and submitted_at is not null)
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and submitted_at is not null)
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and submitted_at is not null)
  or (public.app_user_role() in ('seo_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager') and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo') and submitted_at is not null)
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying') and submitted_at is not null)
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media') and submitted_at is not null)
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

-- Restrictive publication gate:
--   * AM/leadership may read drafts through their existing permissive scope.
--   * Designer roles may read only rows already granted by the existing Creative/Social policies.
--   * Portal-only identities retain the existing client-scoped Portal policy, including its
--     current draft behavior.
--   * Every other authenticated employee role requires submitted_at, even if another permissive
--     policy is added later. An identity present in both users and client_portal_users is treated
--     as an employee first, preventing the Portal arm from bypassing the employee publication gate.
drop policy if exists "briefs_submission_gate_rls" on public.briefs;
create policy "briefs_submission_gate_rls" on public.briefs
as restrictive
for select to authenticated
using (
  case
    when public.app_user_role() is not null then
      public.app_user_role() in (
        'executive',
        'head_of_technical',
        'ai_engineer',
        'am_team_lead',
        'am_agent',
        'graphic_designer',
        'video_editor'
      )
      or submitted_at is not null
    else
      public.portal_client_id() is not null
  end
);

-- UPDATE matches 20261018000000. Service Team Leads/Agents remain view-only;
-- mark_brief_viewed(text) remains their preserved narrow acknowledgement path.
drop policy if exists "briefs_update_rls" on public.briefs;
create policy "briefs_update_rls" on public.briefs
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

-- INSERT matches 20261020000000, including leadership and ai_engineer parity.
drop policy if exists "briefs_write_rls" on public.briefs;
create policy "briefs_write_rls" on public.briefs
for insert to authenticated
with check (
  submitted_by = public.app_user_id()
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

do $$
declare
  v_select_qual text;
  v_gate_qual text;
  v_update_qual text;
  v_update_check text;
  v_insert_check text;
begin
  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'briefs'
      and c.column_name = 'submitted_at'
      and c.udt_name = 'timestamptz'
      and c.is_nullable = 'YES'
      and c.column_default is null
  ) then
    raise exception 'Release verification failed: submitted_at is not nullable timestamptz with no default.';
  end if;

  if exists (
    select required.policyname
    from (values
      ('briefs_select_rls', 'SELECT', 'PERMISSIVE'),
      ('briefs_submission_gate_rls', 'SELECT', 'RESTRICTIVE'),
      ('briefs_select_designer_social', 'SELECT', 'PERMISSIVE'),
      ('briefs_update_rls', 'UPDATE', 'PERMISSIVE'),
      ('briefs_write_rls', 'INSERT', 'PERMISSIVE'),
      ('briefs_select_portal_rls', 'SELECT', 'PERMISSIVE')
    ) as required(policyname, policycmd, policykind)
    where not exists (
      select 1
      from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename = 'briefs'
        and p.policyname = required.policyname
        and p.cmd = required.policycmd
        and p.permissive = required.policykind
        and 'authenticated'::name = any (p.roles)
    )
  ) then
    raise exception 'Release verification failed: one or more required briefs policies have an unexpected command, kind, or role.';
  end if;

  select lower(p.qual)
  into v_select_qual
  from pg_catalog.pg_policies p
  where p.schemaname = 'public'
    and p.tablename = 'briefs'
    and p.policyname = 'briefs_select_rls';

  select lower(p.qual)
  into v_gate_qual
  from pg_catalog.pg_policies p
  where p.schemaname = 'public'
    and p.tablename = 'briefs'
    and p.policyname = 'briefs_submission_gate_rls';

  select lower(p.qual), lower(p.with_check)
  into v_update_qual, v_update_check
  from pg_catalog.pg_policies p
  where p.schemaname = 'public'
    and p.tablename = 'briefs'
    and p.policyname = 'briefs_update_rls';

  select lower(p.with_check)
  into v_insert_check
  from pg_catalog.pg_policies p
  where p.schemaname = 'public'
    and p.tablename = 'briefs'
    and p.policyname = 'briefs_write_rls';

  if v_select_qual is null
    or position('submitted_at' in v_select_qual) = 0
    or position('agent_assigned' in v_select_qual) = 0
    or position('client_has_service' in v_select_qual) = 0
    or position('service_type' in v_select_qual) = 0
    or position('seo_agent' in v_select_qual) = 0
    or position('seo_content_agent' in v_select_qual) = 0
    or position('seo_backlink_agent' in v_select_qual) = 0
    or position('store_manager' in v_select_qual) = 0
    or position('media_buying_agent' in v_select_qual) = 0
    or position('social_media_agent' in v_select_qual) = 0
    or position('ai_engineer' in v_select_qual) = 0 then
    raise exception 'Release verification failed: briefs_select_rls is missing a required publication, service-assignment, role, or ai_engineer condition.';
  end if;

  if v_gate_qual is null
    or position('submitted_at' in v_gate_qual) = 0
    or position('portal_client_id' in v_gate_qual) = 0
    or position('app_user_role' in v_gate_qual) = 0 then
    raise exception 'Release verification failed: briefs_submission_gate_rls has an unexpected definition.';
  end if;

  if v_update_qual is null
    or v_update_check is null
    or position('ai_engineer' in v_update_qual) = 0
    or position('ai_engineer' in v_update_check) = 0
    or position('client_am_agent_is_caller' in v_update_qual) = 0
    or position('client_am_agent_is_caller' in v_update_check) = 0 then
    raise exception 'Release verification failed: briefs_update_rls has an unexpected definition.';
  end if;

  if v_insert_check is null
    or position('submitted_by' in v_insert_check) = 0
    or position('app_user_id' in v_insert_check) = 0
    or position('ai_engineer' in v_insert_check) = 0
    or position('client_am_agent_is_caller' in v_insert_check) = 0 then
    raise exception 'Release verification failed: briefs_write_rls has an unexpected definition.';
  end if;

  if not has_table_privilege('authenticated', 'public.briefs', 'SELECT')
    or not has_table_privilege('authenticated', 'public.briefs', 'INSERT')
    or not has_table_privilege('authenticated', 'public.briefs', 'UPDATE')
    or not has_column_privilege('authenticated', 'public.briefs', 'submitted_at', 'UPDATE') then
    raise exception 'Release verification failed: expected effective authenticated privileges are missing.';
  end if;

  if to_regprocedure('public.mark_brief_viewed(text)') is null
    or not has_function_privilege('authenticated', 'public.mark_brief_viewed(text)', 'EXECUTE') then
    raise exception 'Release verification failed: mark_brief_viewed(text) was not preserved.';
  end if;

  raise notice 'RLS verified: permissive scopes are ANDed with briefs_submission_gate_rls; Portal-only and Designer/AM/leadership draft access remains scoped by their existing permissive policies.';
end
$$;

notify pgrst, 'reload schema';

commit;

