-- SERVICE BRIEF SUBMIT — FINAL RELEASE CANDIDATE (STATIC REVIEW ONLY; NOT EXECUTED).
--
-- Scope:
--   1. Add public.briefs.submitted_at as nullable timestamptz with no default, when absent.
--   2. Recreate only briefs_select_rls, briefs_update_rls, and briefs_write_rls.
--   3. Preserve mark_brief_viewed(text), briefs_select_designer_social, and
--      briefs_select_portal_rls without changing their definitions.
--
-- Historical data:
--   No row is backfilled or automatically published. If submitted_at is newly added, every
--   existing row receives NULL. If it already exists, every existing value is left unchanged.
--
-- RLS composition:
--   PostgreSQL combines applicable permissive policies with OR. The preserved Designer and Portal
--   SELECT policies can independently permit a row that briefs_select_rls does not permit.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Preflight: fail before DDL when the schema, dependencies, grants, or preserved policies do not
-- match the release assumptions. Any later failure still rolls the entire transaction back.
do $$
declare
  v_rls_enabled boolean;
  v_column_exists boolean;
  v_column_is_timestamptz boolean;
  v_column_is_nullable boolean;
  v_column_default text;
  v_unexpected_published_rows boolean;
begin
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
    or to_regprocedure('public.client_am_agent_is_caller(text)') is null
    or to_regprocedure('public.client_has_service(text,text)') is null
    or to_regprocedure('public.agent_assigned_any_service(text)') is null then
    raise exception 'Release preflight failed: one or more required authorization functions are missing.';
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
    -- Metadata-only addition on supported PostgreSQL versions: no default and no backfill.
    execute 'alter table public.briefs add column submitted_at timestamptz null';

    execute 'select exists (select 1 from public.briefs where submitted_at is not null)'
    into v_unexpected_published_rows;

    if v_unexpected_published_rows then
      raise exception 'Release failed: adding submitted_at unexpectedly classified an existing row as published.';
    end if;
  end if;

  -- The verified table-level UPDATE privilege should cover the newly-added column. Abort instead
  -- of adding a new GRANT when the effective privilege does not match that expectation.
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

-- SELECT is based on 20261014100000 + 20261018000000, with ai_engineer parity and the six
-- currently confirmed Agent roles preserved. Every service Team Lead/Agent branch requires an
-- explicit publication timestamp. The existing cross-service assignment function is unchanged.
drop policy if exists "briefs_select_rls" on public.briefs;
create policy "briefs_select_rls" on public.briefs
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and submitted_at is not null)
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and submitted_at is not null)
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and submitted_at is not null)
  or (public.app_user_role() in ('seo_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id) and submitted_at is not null)
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

-- UPDATE matches the final 20261018000000 definition. Service Team Leads/Agents remain view-only;
-- mark_brief_viewed(text) remains their narrow, preserved acknowledgement path.
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

-- INSERT matches the final 20261020000000 definition, including leadership and ai_engineer parity.
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

-- Final assertions. These do not classify or update any historical brief.
do $$
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
      ('briefs_select_rls', 'SELECT'),
      ('briefs_select_designer_social', 'SELECT'),
      ('briefs_update_rls', 'UPDATE'),
      ('briefs_write_rls', 'INSERT'),
      ('briefs_select_portal_rls', 'SELECT')
    ) as required(policyname, policycmd)
    where not exists (
      select 1
      from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename = 'briefs'
        and p.policyname = required.policyname
        and p.cmd = required.policycmd
        and p.permissive = 'PERMISSIVE'
        and 'authenticated'::name = any (p.roles)
    )
  ) then
    raise exception 'Release verification failed: one or more required permissive authenticated briefs policies are missing or have an unexpected command.';
  end if;

  if to_regprocedure('public.mark_brief_viewed(text)') is null
    or not has_function_privilege('authenticated', 'public.mark_brief_viewed(text)', 'EXECUTE') then
    raise exception 'Release verification failed: mark_brief_viewed(text) was not preserved.';
  end if;

  raise notice 'RLS reminder: permissive policies combine with OR; preserved Designer and Portal SELECT policies may independently permit a row.';
end
$$;

notify pgrst, 'reload schema';

commit;
