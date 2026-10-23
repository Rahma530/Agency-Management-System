-- PROPOSED MANUAL RELEASE SQL — NOT EXECUTED BY CODEX.
--
-- Purpose:
--   Restore the explicit Service Brief draft/publish lifecycle against the Production schema
--   state verified on 2026-10-14: public.briefs exists and submitted_at is absent. Repository
--   evidence does not prove which existing rows were historically published, so this repair does
--   not auto-publish any existing row. Existing rows remain intact and receive submitted_at = NULL.
--
-- Deliberately out of scope for this emergency repair:
--   1. Cross-service agent visibility through agent_assigned_any_service(client_id).
--   2. Client Portal draft visibility through briefs_select_portal_rls.
--
-- Re-run behavior:
--   * If submitted_at is absent, the script adds the nullable timestamptz column with no default.
--     PostgreSQL therefore preserves every existing row as an unpublished draft (NULL).
--   * If submitted_at already exists with the correct nullable type and no default, all data is
--     left unchanged. A re-run never classifies or publishes a row.
--   * The three application policies are recreated in their latest intended form every time.
--   * mark_brief_viewed(text), briefs_select_designer_social, and briefs_select_portal_rls are
--     verified/preserved, not changed.

begin;

-- Fail quickly rather than waiting indefinitely for concurrent writes in a live system.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare
  v_column_exists boolean;
  v_column_is_timestamptz boolean;
  v_column_is_nullable boolean;
  v_column_default text;
  v_unexpected_published_rows boolean;
  v_rls_enabled boolean;
begin
  if to_regrole('authenticated') is null then
    raise exception 'Required role authenticated is missing.';
  end if;

  if to_regclass('public.briefs') is null then
    raise exception 'Required table public.briefs is missing.';
  end if;

  select c.relrowsecurity
  into v_rls_enabled
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'briefs';

  if v_rls_enabled is distinct from true then
    raise exception 'RLS must already be enabled on public.briefs.';
  end if;

  if exists (
    select 1
    from (values
      ('client_id'),
      ('service_type'),
      ('submitted_by'),
      ('created_at'),
      ('updated_at'),
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
    raise exception 'public.briefs is missing one or more required columns.';
  end if;

  if to_regprocedure('public.app_user_role()') is null
    or to_regprocedure('public.app_user_id()') is null
    or to_regprocedure('public.client_am_agent_is_caller(text)') is null
    or to_regprocedure('public.client_has_service(text,text)') is null
    or to_regprocedure('public.agent_assigned_any_service(text)') is null then
    raise exception 'One or more required authorization functions are missing.';
  end if;

  if to_regprocedure('public.mark_brief_viewed(text)') is null then
    raise exception 'Required RPC public.mark_brief_viewed(text) is missing.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.mark_brief_viewed(text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated cannot execute public.mark_brief_viewed(text).';
  end if;

  if not has_table_privilege('authenticated', 'public.briefs', 'SELECT')
    or not has_table_privilege('authenticated', 'public.briefs', 'INSERT')
    or not has_table_privilege('authenticated', 'public.briefs', 'UPDATE') then
    raise exception 'authenticated must already have effective SELECT, INSERT, and UPDATE on public.briefs.';
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
      raise exception 'Existing submitted_at must be nullable timestamptz with no default; refusing to alter an incompatible column.';
    end if;

    raise notice 'submitted_at already exists; all existing publication values intentionally left unchanged.';
  else
    -- Adding a nullable column with no default preserves every existing row and assigns NULL.
    -- No timestamp or row count is treated as evidence that a row was historically published.
    execute 'alter table public.briefs add column submitted_at timestamptz null';

    execute 'select exists (select 1 from public.briefs where submitted_at is not null)'
    into v_unexpected_published_rows;

    if v_unexpected_published_rows then
      raise exception 'Adding submitted_at unexpectedly classified an existing row as published.';
    end if;
  end if;

  -- A relation-level UPDATE grant applies to columns added later. This assertion proves that the
  -- new column is covered, so no broader or redundant column-level GRANT is needed.
  if not has_column_privilege(
    'authenticated',
    'public.briefs',
    'submitted_at',
    'UPDATE'
  ) then
    raise exception 'authenticated lacks effective UPDATE on public.briefs.submitted_at.';
  end if;
end
$$;

-- Latest intended SELECT policy from 20261018000000, while preserving the six Agent roles in the
-- currently verified Production policy: AI Engineer matches Head of Technical, service teams
-- require publication, and the pre-existing cross-service Agent behavior is kept unchanged because
-- tightening it is explicitly a separate release.
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

-- Latest intended UPDATE policy from 20261018000000. Service Team Leads/Agents are intentionally
-- absent, so they remain view-only. mark_brief_viewed(text) remains their narrow write path.
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

-- Latest intended INSERT policy from 20261020000000. This does not add a table or column GRANT;
-- it only preserves the final RLS rule already expected by the current frontend.
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

-- Explicit final assertions. These inspect state only; any failure rolls back the whole release.
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
    raise exception 'Final submitted_at definition is invalid.';
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
    raise exception 'One or more required briefs policies are missing after repair.';
  end if;

  if to_regprocedure('public.mark_brief_viewed(text)') is null
    or not has_function_privilege('authenticated', 'public.mark_brief_viewed(text)', 'EXECUTE') then
    raise exception 'mark_brief_viewed(text) was not preserved.';
  end if;
end
$$;

-- Ensure PostgREST sees the new column after this transaction commits.
notify pgrst, 'reload schema';

commit;
