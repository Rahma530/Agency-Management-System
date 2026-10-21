-- De-privilege ai_engineer at the database (RLS / SECURITY DEFINER) layer, to match the
-- owner's explicit instruction: ai_engineer loses every admin-equivalent / elevated,
-- application-wide access grant and becomes an ordinary agent role everywhere in this schema,
-- with exactly ONE deliberate exception — ai_engineer keeps the ability to impersonate
-- employees (employee-impersonation Edge Function + the matching client-side
-- canImpersonateEmployees()/canUseEmployeeTestingMode() checks in src/lib/permissions.ts).
-- Impersonation is NOT touched anywhere in this file.
--
-- This migration reverts the elevated grants originally introduced by:
--   - 20261018000000_align_ai_engineer_with_head_of_technical.sql
--   - 20261019000000_ai_engineer_full_application_authorization.sql
--   - 20261031700000_restore_ai_engineer_client_select_rls.sql (which re-added ai_engineer to
--     clients_select_rls after an intervening, since-superseded change)
--
-- It does NOT simply replay those three migrations backwards: every function and policy below
-- was re-derived from this repository's FULL migration history, in chronological order, so each
-- statement reproduces that object's TRUE, CURRENT, CUMULATIVE definition (as of
-- 20261123000000_daily_logs_department_team_lead_visibility_rollback.sql, the latest migration
-- at the time this file was written) with ai_engineer removed from every role-check list and
-- nothing else about the logic changed. In particular:
--   - task_visible(text,text,text) is intentionally left untouched: it was superseded by
--     task_visible_v2(text) in 20261104100000_task_visibility_cutover.sql and is dead code today
--     (no policy or RPC calls it any more) — reverting it would be a no-op with extra risk.
--   - users_update_guard()'s TRUE current body is the one produced by
--     20261115000000_daily_task_target_rollback.sql (that feature was added and then rolled
--     back), not the body in 20261030000000_users_update_guard_trigger.sql, which had already
--     drifted from production before this migration was written.
--   - daily_logs_select_rls's TRUE current body is the one produced by
--     20261123000000_daily_logs_department_team_lead_visibility_rollback.sql (that feature was
--     also added and then rolled back), i.e. byte-identical to
--     20261028100000_daily_logs_report_scope_visibility.sql.
--   - users_update_capacity_rls / users_update_profile_rls / users_deactivate_rls / employee_
--     manageable() / activities_select_rls were found, on inspection, to ALREADY exclude
--     ai_engineer in their current live definitions (20261101700000_users_edit_scope_hardening.sql
--     and 20261117000000_activities_task_participants_select.sql respectively, the latter
--     explicitly re-confirming the live activities_select_rls body as part of its own audit) —
--     left untouched here, nothing to revert.
--   - assignable_employees(text) was found to have REGRESSED since the original "already
--     correctly excludes ai_engineer" state described when this task was scoped: its current body
--     (20261102000000_departments_sort_order_and_assignable_employees.sql, following
--     20261101100000_task_cross_team_visibility.sql) excludes only executive/head_of_technical,
--     no longer ai_engineer. This is NOT an elevated-access grant TO ai_engineer (it governs
--     whether OTHER callers can pick ai_engineer as an assignee/staffing target, not what
--     ai_engineer itself can do) and so is deliberately left unchanged here — flagged in the
--     accompanying report for separate owner review, not folded into this de-privileging pass.
--   - report_role_has_module(text) still lists ai_engineer among the roles that may open the
--     Reports module's UI at all. Left unchanged here and flagged as genuinely unsure: it is a
--     module-visibility gate, not itself a data-access grant (report_scope_accessible /
--     report_subject_creatable / report_row_editable below already deny ai_engineer any report
--     content, read or write, once this migration applies), so removing it may just be tidying up
--     a now-meaningless UI gate, or may be an intentional allowance for ai_engineer to use the
--     Reports module for its own, non-privileged work. Left for the owner to decide.
--
-- Every statement below only removes ai_engineer from a role list / CASE branch / IN-list; no
-- other predicate, column, grant, or comment text is otherwise changed.
begin;

-- ============================================================================
-- SECTION 1 — SECURITY DEFINER functions
-- ============================================================================

-- employee_visible(target_id, target_role) — current body per
-- 20261104100000_task_visibility_cutover.sql (custom-roles arms from
-- 20261101600000_custom_roles_employee_visibility.sql, task_assignees-membership swap from the
-- cutover itself). Only the leading `public.app_user_role() = 'ai_engineer' or` disjunct is
-- removed.
create or replace function public.employee_visible(target_id text, target_role text)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
    or (target_role in ('graphic_designer', 'video_editor') and public.app_user_role() <> 'sales')
    or (public.app_user_role() = 'am_team_lead' and target_role in ('am_team_lead', 'am_agent'))
    or (public.app_user_role() = 'media_buying_team_lead' and target_role in ('media_buying_team_lead', 'media_buying_agent'))
    or (public.app_user_role() = 'seo_team_lead' and target_role in ('seo_team_lead', 'seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager'))
    or (public.app_user_role() = 'social_media_team_lead' and target_role in ('social_media_team_lead', 'social_media_agent'))
    or (public.app_user_role() = 'am_agent' and target_role in ('am_agent', 'am_team_lead'))
    or (public.app_user_role() = 'media_buying_agent' and target_role in ('media_buying_agent', 'media_buying_team_lead'))
    or (public.app_user_role() = 'seo_agent' and target_role in ('seo_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'programming_agent' and target_role in ('programming_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'seo_content_agent' and target_role in ('seo_content_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'seo_backlink_agent' and target_role in ('seo_backlink_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'store_manager' and target_role in ('store_manager', 'seo_team_lead'))
    or (public.app_user_role() = 'social_media_agent' and target_role in ('social_media_agent', 'social_media_team_lead'))
    or (public.app_user_role() = 'sales' and target_role = 'sales')
    or (
      target_role in ('am_agent', 'am_team_lead') and exists (
        select 1 from public.clients c
        where (c.am_agent_id = target_id or c.am_team_lead_id = target_id) and (
          public.app_user_role() in ('media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
          or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(c.id, 'media_buying'))
          or (public.app_user_role() = 'seo_agent' and public.agent_assigned(c.id, 'seo'))
          or (public.app_user_role() = 'store_manager' and public.agent_assigned(c.id, 'seo'))
          or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(c.id, 'social_media'))
          or exists (
            select 1 from public.tasks t
            where t.client_id = c.id
              and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
          )
        )
      )
    )
    or (
      public.app_user_role() <> 'sales'
      and exists (
        select 1 from public.custom_roles cr
        join public.departments d on d.id = cr.department_id
        where cr.id = target_role and cr.is_active and d.is_shared_resource
      )
    )
    or (
      public.app_has_permission('employees.view_department_peers')
      and exists (
        select 1 from public.custom_roles me
        join public.custom_roles other on other.department_id = me.department_id
        where me.id = public.app_user_role() and other.id = target_role
          and other.is_active and me.is_active
      )
    );
$function$;

-- direct_report_visible(target_id) — unchanged since 20261019000000. Only the leading
-- `public.app_user_role() = 'ai_engineer' or` disjunct is removed.
create or replace function public.direct_report_visible(target_id text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
    or exists (
      select 1 from public.users u where u.id = target_id and (
        (public.app_user_role() = 'am_team_lead' and u.role = 'am_agent')
        or (public.app_user_role() = 'media_buying_team_lead' and u.role = 'media_buying_agent')
        or (public.app_user_role() = 'seo_team_lead' and u.role in ('seo_agent', 'programming_agent'))
        or (public.app_user_role() = 'social_media_team_lead' and u.role = 'social_media_agent')
      )
    );
$$;

-- task_visible_v2(p_task_id) — current body per 20261104000000_task_visibility_functions.sql,
-- the live visibility function behind tasks_select_rls/tasks_update_rls/task_comments_*/
-- task_attachments_*/the task-attachments storage policies/report_source_manifest_v2. ai_engineer
-- removed from the admin tier only.
create or replace function public.task_visible_v2(p_task_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (
    select id, created_by, client_id, parent_task_id
    from public.tasks
    where id = p_task_id
  )
  select
    public.app_user_role() <> 'sales'
    and exists (select 1 from t)
    and (
      public.app_user_role() in ('executive', 'head_of_technical')
      or exists (select 1 from t where t.created_by = public.app_user_id())
      or exists (
        select 1 from public.task_assignees ta
        where ta.task_id = p_task_id and ta.user_id = public.app_user_id()
      )
      or (
        public.app_user_role() in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
        and (
          exists (select 1 from t join public.users u on u.id = t.created_by where u.team = public.app_user_team())
          or exists (
            select 1 from public.task_assignees ta
            join public.users u on u.id = ta.user_id
            where ta.task_id = p_task_id and u.team = public.app_user_team()
          )
          or (
            public.app_user_role() = 'seo_team_lead'
            and (
              exists (select 1 from t join public.users u on u.id = t.created_by where u.team = 'Programming')
              or exists (
                select 1 from public.task_assignees ta
                join public.users u on u.id = ta.user_id
                where ta.task_id = p_task_id and u.team = 'Programming'
              )
            )
          )
        )
      )
      or (
        public.app_user_role() = 'am_agent'
        and exists (select 1 from t where t.client_id is not null and public.client_am_agent_is_caller(t.client_id))
      )
      or (
        public.app_user_role() = 'marketing_manager'
        and (
          exists (select 1 from t join public.users u on u.id = t.created_by where u.role in ('graphic_designer', 'video_editor'))
          or exists (
            select 1 from public.task_assignees ta
            join public.users u on u.id = ta.user_id
            where ta.task_id = p_task_id and u.role in ('graphic_designer', 'video_editor')
          )
        )
      )
      or exists (
        select 1 from t where t.parent_task_id is not null and public.task_visible_v2(t.parent_task_id)
      )
    );
$$;

-- task_closable(p_task_id) — current body per 20261104000000_task_visibility_functions.sql.
-- ai_engineer removed from the admin tier only.
create or replace function public.task_closable(p_task_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.app_user_role() in ('executive', 'head_of_technical')
    or exists (select 1 from public.tasks t where t.id = p_task_id and t.created_by = public.app_user_id())
    or exists (
      select 1 from public.task_assignees ta
      where ta.task_id = p_task_id and ta.user_id = public.app_user_id()
    );
$$;

-- report_scope_accessible(p_client_id, p_agent_id) — current body per
-- 20261107300000_report_workspace_lifecycle_hardening.sql. The standalone
-- `when public.app_user_role()='ai_engineer' then true` CASE branch is removed; every other
-- branch (including the custom-roles arm) is unchanged.
create or replace function public.report_scope_accessible(p_client_id text,p_agent_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select case
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

-- mark_brief_viewed(p_brief_id) — current body per
-- 20261026000000_head_of_technical_mark_brief_viewed_parity.sql. ai_engineer removed from the
-- unconditional-bypass in-list, leaving head_of_technical in place.
create or replace function public.mark_brief_viewed(p_brief_id text)
returns public.briefs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_brief public.briefs;
begin
  select * into v_brief from public.briefs where id = p_brief_id;
  if not found then
    raise exception 'Brief not found';
  end if;
  if not (
    public.app_user_role() = 'head_of_technical'
    or (public.app_user_role() = 'seo_team_lead' and v_brief.service_type = 'seo' and public.client_has_service(v_brief.client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_team_lead' and v_brief.service_type = 'media_buying' and public.client_has_service(v_brief.client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_team_lead' and v_brief.service_type = 'social_media' and public.client_has_service(v_brief.client_id, 'social_media'))
  ) then
    raise exception 'You do not have permission to mark this brief as viewed.';
  end if;
  update public.briefs set team_lead_viewed_at = now()
  where id = p_brief_id returning * into v_brief;
  return v_brief;
end;
$$;

-- get_client_access(p_client_id) — current body per
-- 20261030500000_protect_client_access_columns.sql. ai_engineer removed from the unconditional
-- disjunct.
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
  v_client public.clients;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to view this client''s access details.';
  end if;

  insert into public.client_access_log (client_id, accessed_by)
  values (p_client_id, public.app_user_id());

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

-- update_client_access(...) — current body per 20261030500000_protect_client_access_columns.sql
-- (returns void). ai_engineer removed from the unconditional disjunct.
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
  v_client public.clients;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
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

-- update_client_dates(...) — current body per 20261030800000_update_client_dates_rpc.sql.
-- ai_engineer removed from the leadership in-list.
create or replace function public.update_client_dates(
  p_client_id text,
  p_start_date date,
  p_renewal_date date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
    or (public.app_user_role() = 'sales' and v_client.sales_owner_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to edit this client''s dates.';
  end if;

  update public.clients
  set start_date = p_start_date, renewal_date = p_renewal_date
  where id = p_client_id;
end;
$$;

-- update_client_details(p_client_id, p_patch) — current body per
-- 20261031000000_update_client_details_blank_numerics.sql. ai_engineer removed from the
-- leadership in-list; every validation/allow-list rule unchanged.
create or replace function public.update_client_details(p_client_id text, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_key text;
  v_allowed_keys text[] := array[
    'name', 'client_contact_name', 'phone_number', 'website_or_social_link', 'sector', 'industry',
    'services', 'other_services', 'sales_brief', 'contract_value', 'due_value', 'remaining_value',
    'contract_duration_months', 'start_date', 'renewal_date'
  ];
  v_name text;
  v_sector text;
  v_services text[];
  v_other_services text[];
  v_contract_value numeric;
  v_due_value numeric;
  v_remaining_value numeric;
  v_contract_duration_months integer;
  v_start_date date;
  v_renewal_date date;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
    or (public.app_user_role() = 'sales' and v_client.sales_owner_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to edit this client.';
  end if;

  for v_key in select jsonb_object_keys(p_patch) loop
    if not (v_key = any(v_allowed_keys)) then
      raise exception 'Unknown or disallowed field: %', v_key;
    end if;
  end loop;

  if p_patch ? 'name' then
    v_name := p_patch ->> 'name';
    if v_name is null or btrim(v_name) = '' then
      raise exception 'name cannot be blank';
    end if;
  end if;

  if p_patch ? 'sector' then
    v_sector := nullif(p_patch ->> 'sector', '');
    if v_sector is not null and v_sector not in ('E-Commerce', 'Service') then
      raise exception 'sector must be E-Commerce, Service, or null';
    end if;
  end if;

  if p_patch ? 'services' then
    select coalesce(array_agg(value), array[]::text[]) into v_services
    from jsonb_array_elements_text(p_patch -> 'services');
    if not (v_services <@ array['seo', 'social_media', 'media_buying']) then
      raise exception 'services must only contain seo, social_media, media_buying';
    end if;
  end if;

  if p_patch ? 'other_services' then
    select coalesce(array_agg(value), array[]::text[]) into v_other_services
    from jsonb_array_elements_text(p_patch -> 'other_services');
  end if;

  if p_patch ? 'services' or p_patch ? 'other_services' then
    if coalesce(v_services, v_client.services) && coalesce(v_other_services, v_client.other_services) then
      raise exception 'services and other_services must not overlap';
    end if;
  end if;

  if p_patch ? 'contract_value' then
    v_contract_value := nullif(p_patch ->> 'contract_value', '')::numeric;
    if v_contract_value is not null and v_contract_value < 0 then
      raise exception 'contract_value must be >= 0';
    end if;
  end if;

  if p_patch ? 'due_value' then
    v_due_value := nullif(p_patch ->> 'due_value', '')::numeric;
    if v_due_value is not null and v_due_value < 0 then
      raise exception 'due_value must be >= 0';
    end if;
  end if;

  if p_patch ? 'remaining_value' then
    v_remaining_value := nullif(p_patch ->> 'remaining_value', '')::numeric;
    if v_remaining_value is not null and v_remaining_value < 0 then
      raise exception 'remaining_value must be >= 0';
    end if;
  end if;

  if p_patch ? 'contract_duration_months' then
    v_contract_duration_months := nullif(p_patch ->> 'contract_duration_months', '')::integer;
    if v_contract_duration_months is not null and v_contract_duration_months < 0 then
      raise exception 'contract_duration_months must be >= 0';
    end if;
  end if;

  if p_patch ? 'start_date' then
    v_start_date := nullif(p_patch ->> 'start_date', '')::date;
  end if;

  if p_patch ? 'renewal_date' then
    v_renewal_date := nullif(p_patch ->> 'renewal_date', '')::date;
  end if;

  update public.clients set
    name = case when p_patch ? 'name' then v_name else name end,
    client_contact_name = case when p_patch ? 'client_contact_name' then nullif(p_patch ->> 'client_contact_name', '') else client_contact_name end,
    phone_number = case when p_patch ? 'phone_number' then nullif(p_patch ->> 'phone_number', '') else phone_number end,
    website_or_social_link = case when p_patch ? 'website_or_social_link' then nullif(p_patch ->> 'website_or_social_link', '') else website_or_social_link end,
    sector = case when p_patch ? 'sector' then v_sector else sector end,
    industry = case when p_patch ? 'industry' then nullif(p_patch ->> 'industry', '') else industry end,
    services = case when p_patch ? 'services' then v_services else services end,
    other_services = case when p_patch ? 'other_services' then v_other_services else other_services end,
    sales_brief = case when p_patch ? 'sales_brief' then nullif(p_patch ->> 'sales_brief', '') else sales_brief end,
    contract_value = case when p_patch ? 'contract_value' then v_contract_value else contract_value end,
    due_value = case when p_patch ? 'due_value' then v_due_value else due_value end,
    remaining_value = case when p_patch ? 'remaining_value' then v_remaining_value else remaining_value end,
    contract_duration_months = case when p_patch ? 'contract_duration_months' then v_contract_duration_months else contract_duration_months end,
    start_date = case when p_patch ? 'start_date' then v_start_date else start_date end,
    renewal_date = case when p_patch ? 'renewal_date' then v_renewal_date else renewal_date end
  where id = p_client_id;
end;
$$;

-- close_client(...) — current body per 20261031400000_client_lifecycle_close_reopen.sql.
-- ai_engineer removed from the role gate.
create or replace function public.close_client(
  p_client_id text,
  p_stop_date date,
  p_closure_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_caller_id text;
  v_caller_role text;
  v_open_period_id text;
  v_open_period_started_on date;
  v_closure_reason text;
begin
  if auth.role() is distinct from 'service_role' then
    v_caller_id := public.app_user_id();
    v_caller_role := public.app_user_role();

    if auth.uid() is null or v_caller_id is null or v_caller_role is null then
      raise exception 'You must be signed in as a KMS employee to close a client.';
    end if;

    if v_caller_role not in ('executive', 'head_of_technical', 'am_team_lead', 'am_agent') then
      raise exception 'You do not have permission to close this client.';
    end if;
  end if;

  select *
  into v_client
  from public.clients
  where id = p_client_id
  for update;

  if not found then
    raise exception 'Client not found.';
  end if;

  if auth.role() is distinct from 'service_role'
    and v_caller_role = 'am_agent'
    and v_client.am_agent_id is distinct from v_caller_id then
    raise exception 'You do not have permission to close this client.';
  end if;

  if v_client.status = 'closed' then
    raise exception 'This client is already closed.';
  end if;

  if p_stop_date is null then
    raise exception 'Stop / Loss Date is required.';
  end if;

  if p_stop_date > current_date then
    raise exception 'Stop / Loss Date cannot be in the future.';
  end if;

  if v_client.start_date is not null and p_stop_date < v_client.start_date then
    raise exception 'Stop / Loss Date cannot be earlier than the Start Date.';
  end if;

  v_closure_reason := nullif(btrim(p_closure_reason), '');
  if v_closure_reason is null then
    raise exception 'Closure Reason is required.';
  end if;

  select id, started_on
  into v_open_period_id, v_open_period_started_on
  from public.client_lifecycle_periods
  where client_id = p_client_id
    and ended_on is null
  for update;

  if v_open_period_id is not null then
    if p_stop_date < v_open_period_started_on then
      raise exception 'Stop / Loss Date cannot be earlier than the current lifecycle period start date.';
    end if;

    update public.client_lifecycle_periods
    set ended_on = p_stop_date,
        closure_reason = v_closure_reason,
        updated_at = now()
    where id = v_open_period_id;
  elsif v_client.start_date is not null then
    insert into public.client_lifecycle_periods (
      id,
      client_id,
      started_on,
      ended_on,
      closure_reason
    ) values (
      gen_random_uuid()::text,
      p_client_id,
      v_client.start_date,
      p_stop_date,
      v_closure_reason
    );
  end if;

  update public.clients
  set status = 'closed',
      churned_at = p_stop_date::timestamp at time zone 'UTC',
      churn_reason = v_closure_reason
  where id = p_client_id;
end;
$$;

-- reopen_client(...) — current body per 20261031400000_client_lifecycle_close_reopen.sql.
-- ai_engineer removed from the role gate.
create or replace function public.reopen_client(
  p_client_id text,
  p_reopen_date date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_caller_id text;
  v_caller_role text;
  v_existing_open_period_id text;
  v_has_lifecycle_history boolean;
  v_latest_ended_on date;
  v_legacy_ended_on date;
begin
  if auth.role() is distinct from 'service_role' then
    v_caller_id := public.app_user_id();
    v_caller_role := public.app_user_role();

    if auth.uid() is null or v_caller_id is null or v_caller_role is null then
      raise exception 'You must be signed in as a KMS employee to reopen a client.';
    end if;

    if v_caller_role not in ('executive', 'head_of_technical', 'am_team_lead', 'am_agent') then
      raise exception 'You do not have permission to reopen this client.';
    end if;
  end if;

  select *
  into v_client
  from public.clients
  where id = p_client_id
  for update;

  if not found then
    raise exception 'Client not found.';
  end if;

  if auth.role() is distinct from 'service_role'
    and v_caller_role = 'am_agent'
    and v_client.am_agent_id is distinct from v_caller_id then
    raise exception 'You do not have permission to reopen this client.';
  end if;

  if v_client.status <> 'closed' then
    raise exception 'Only a closed client can be reopened.';
  end if;

  if p_reopen_date is null then
    raise exception 'Reopen Date is required.';
  end if;

  if p_reopen_date > current_date then
    raise exception 'Reopen Date cannot be in the future.';
  end if;

  select id
  into v_existing_open_period_id
  from public.client_lifecycle_periods
  where client_id = p_client_id
    and ended_on is null
  for update;

  if v_existing_open_period_id is not null then
    raise exception 'This client already has an open lifecycle period.';
  end if;

  select exists (
    select 1
    from public.client_lifecycle_periods
    where client_id = p_client_id
  ) into v_has_lifecycle_history;

  select max(ended_on)
  into v_latest_ended_on
  from public.client_lifecycle_periods
  where client_id = p_client_id;

  if not v_has_lifecycle_history
    and v_client.start_date is not null
    and p_reopen_date < v_client.start_date then
    raise exception 'Reopen Date cannot be earlier than the original Start Date.';
  end if;

  if not v_has_lifecycle_history
    and v_client.start_date is not null
    and v_client.churned_at is not null then
    v_legacy_ended_on := (v_client.churned_at at time zone 'UTC')::date;

    if v_legacy_ended_on >= v_client.start_date
      and v_legacy_ended_on <= current_date then
      v_latest_ended_on := v_legacy_ended_on;
    end if;
  end if;

  if v_latest_ended_on is not null and p_reopen_date < v_latest_ended_on then
    raise exception 'Reopen Date cannot be earlier than the latest lifecycle period end date.';
  end if;

  if not v_has_lifecycle_history
    and v_legacy_ended_on is not null
    and v_legacy_ended_on >= v_client.start_date
    and v_legacy_ended_on <= current_date then
    insert into public.client_lifecycle_periods (
      id,
      client_id,
      started_on,
      ended_on,
      closure_reason
    ) values (
      gen_random_uuid()::text,
      p_client_id,
      v_client.start_date,
      v_legacy_ended_on,
      v_client.churn_reason
    );
  end if;

  insert into public.client_lifecycle_periods (
    id,
    client_id,
    started_on,
    ended_on,
    closure_reason
  ) values (
    gen_random_uuid()::text,
    p_client_id,
    p_reopen_date,
    null,
    null
  );

  update public.clients
  set status = 'active',
      churned_at = null,
      churn_reason = null
  where id = p_client_id;
end;
$$;

-- confirm_client_renewal(p_client_id) — current body per
-- 20261031500000_client_confirm_renewal.sql. ai_engineer removed from the role gate.
create or replace function public.confirm_client_renewal(p_client_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_caller_id text;
  v_caller_role text;
  v_max_sequence integer;
  v_next_sequence integer;
  v_completed_target_date date;
begin
  v_caller_id := public.app_user_id();

  if auth.role() is distinct from 'service_role' then
    v_caller_role := public.app_user_role();

    if auth.uid() is null or v_caller_id is null or v_caller_role is null then
      raise exception 'You must be signed in as a KMS employee to confirm a client renewal.';
    end if;

    if v_caller_role not in ('executive', 'head_of_technical', 'am_team_lead', 'am_agent') then
      raise exception 'You do not have permission to confirm this client renewal.';
    end if;
  elsif v_caller_id is null then
    raise exception 'A KMS employee identity is required to record this client renewal.';
  end if;

  select *
  into v_client
  from public.clients
  where id = p_client_id
  for update;

  if not found then
    raise exception 'Client not found.';
  end if;

  if auth.role() is distinct from 'service_role'
    and v_caller_role = 'am_agent'
    and v_client.am_agent_id is distinct from v_caller_id then
    raise exception 'You do not have permission to confirm this client renewal.';
  end if;

  if v_client.status <> 'renewal' then
    raise exception 'Only a client in Renewal status can have its renewal confirmed.';
  end if;

  if v_client.renewal_date is null then
    raise exception 'This client has no renewal date set. Set one in Client Dates above before confirming renewal.';
  end if;

  v_completed_target_date := v_client.renewal_date;

  select max(renewal_sequence)
  into v_max_sequence
  from public.client_renewal_events
  where client_id = p_client_id;

  if v_client.renewal_history_count is not null then
    if v_client.renewal_history_count <> coalesce(v_max_sequence, 0) then
      raise exception 'Renewal history is inconsistent for this client. Confirmation was not recorded.';
    end if;

    v_next_sequence := v_client.renewal_history_count + 1;
  else
    v_next_sequence := coalesce(v_max_sequence, 0) + 1;
  end if;

  insert into public.client_renewal_events (
    id,
    client_id,
    completed_target_date,
    actual_renewal_date,
    renewal_sequence,
    recorded_by
  ) values (
    gen_random_uuid()::text,
    p_client_id,
    v_completed_target_date,
    current_date,
    v_next_sequence,
    v_caller_id
  );

  update public.clients
  set status = 'active',
      renewal_date = (v_completed_target_date + interval '1 year')::date,
      renewal_history_count = v_next_sequence
  where id = p_client_id;
end;
$$;

-- confirm_employee_portal_entry(employee_id) — current body per
-- 20261031800000_employee_portal_entry_confirmation.sql. ai_engineer removed from the role gate.
create or replace function public.confirm_employee_portal_entry(employee_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_role text;
  v_target public.users;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in as a KMS employee to confirm portal entry.';
  end if;

  select role
  into v_caller_role
  from public.users
  where auth_id = auth.uid()
    and deactivated_at is null;

  if not found or v_caller_role not in ('executive', 'head_of_technical') then
    raise exception 'You do not have permission to confirm employee portal entry.';
  end if;

  if exists (
    select 1
    from public.impersonation_sessions
    where employee_auth_id = auth.uid()
      and ended_at is null
  ) then
    raise exception 'Portal entry cannot be confirmed from an impersonation session.';
  end if;

  select *
  into v_target
  from public.users
  where id = employee_id
  for update;

  if not found then
    raise exception 'Employee not found.';
  end if;

  if v_target.auth_id is null then
    raise exception 'Employee does not have a linked Auth account.';
  end if;

  if v_target.deactivated_at is not null then
    raise exception 'A deactivated employee cannot be marked Done.';
  end if;

  update public.users
  set portal_entry_confirmed_at = coalesce(portal_entry_confirmed_at, now())
  where id = employee_id;
end;
$$;

-- users_update_guard() — TRUE current body per
-- 20261115000000_daily_task_target_rollback.sql (the daily_task_target feature itself was added
-- and then rolled back, so this trigger's Rule 5 was removed along with it; this is the body
-- production actually runs today — it differs from 20261030000000_users_update_guard_trigger.sql,
-- which had already drifted). ai_engineer removed from Rule 3 (team/manager_id changes on someone
-- else's row) and from Rule 4's unrestricted role-change tier; every other rule is unchanged.
create or replace function public.users_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id text;
  caller_role text;
  seo_dept_roles text[] := array['seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager'];
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;

  if new.id is distinct from old.id then
    raise exception 'id cannot be changed.';
  end if;
  if new.auth_id is distinct from old.auth_id then
    raise exception 'auth_id cannot be changed here — it is only ever set once, by the employee invitation/test-account setup process.';
  end if;

  caller_id := public.app_user_id();
  caller_role := public.app_user_role();

  if old.id = caller_id then
    if new.role is distinct from old.role then
      raise exception 'You cannot change your own role.';
    end if;
    if new.team is distinct from old.team then
      raise exception 'You cannot change your own team.';
    end if;
    if new.manager_id is distinct from old.manager_id then
      raise exception 'You cannot change your own manager.';
    end if;
  end if;

  if (new.team is distinct from old.team) or (new.manager_id is distinct from old.manager_id) then
    if caller_role not in ('executive', 'head_of_technical') then
      raise exception 'Only Executive or Head of Technical may change team or manager.';
    end if;
  end if;

  if new.role is distinct from old.role then
    if caller_role in ('executive', 'head_of_technical') then
      null;
    elsif caller_role = 'am_team_lead' then
      if old.role is distinct from 'am_agent' or new.role is distinct from 'am_agent' then
        raise exception 'Account Management Team Leads may only change role within am_agent.';
      end if;
    elsif caller_role = 'media_buying_team_lead' then
      if old.role is distinct from 'media_buying_agent' or new.role is distinct from 'media_buying_agent' then
        raise exception 'Media Buying Team Leads may only change role within media_buying_agent.';
      end if;
    elsif caller_role = 'seo_team_lead' then
      if not (old.role = any(seo_dept_roles) and new.role = any(seo_dept_roles)) then
        raise exception 'SEO Team Leads may only change role among SEO department agent roles (seo_agent, programming_agent, seo_content_agent, seo_backlink_agent, store_manager).';
      end if;
    elsif caller_role = 'social_media_team_lead' then
      if old.role is distinct from 'social_media_agent' or new.role is distinct from 'social_media_agent' then
        raise exception 'Social Media Team Leads may only change role within social_media_agent.';
      end if;
    else
      raise exception 'You are not authorized to change role.';
    end if;
  end if;

  return new;
end;
$$;

-- delete_tasks(p_task_ids) — current body per 20261113000000_task_hard_delete.sql. ai_engineer
-- removed from the role gate (client-side canHardDeleteTasks() in src/lib/permissions.ts already
-- excludes it).
create or replace function public.delete_tasks(p_task_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text := public.app_user_role();
  v_actor_id text := public.app_user_id();
  v_task_id text;
  v_task public.tasks;
  v_subtree_ids text[];
  v_all_ids text[] := array[]::text[];
  v_subtasks_count integer;
  v_comments_count integer;
  v_attachments_count integer;
  v_deleted_count integer;
begin
  if v_actor_role not in ('executive', 'head_of_technical') then
    raise exception 'Only executive or head_of_technical may hard-delete tasks.';
  end if;

  if p_task_ids is null or array_length(p_task_ids, 1) is null then
    raise exception 'p_task_ids must not be empty.';
  end if;

  if array_length(p_task_ids, 1) > 200 then
    raise exception 'Cannot delete more than 200 tasks in a single call (got %).', array_length(p_task_ids, 1);
  end if;

  foreach v_task_id in array p_task_ids loop
    select * into v_task from public.tasks where id = v_task_id;
    if v_task.id is null then
      continue;
    end if;

    with recursive subtree as (
      select t.id from public.tasks t where t.id = v_task_id
      union all
      select c.id from public.tasks c join subtree s on c.parent_task_id = s.id
    )
    select array_agg(id) into v_subtree_ids from subtree;

    v_subtasks_count := array_length(v_subtree_ids, 1) - 1;
    select count(*) into v_comments_count from public.task_comments where task_id = any(v_subtree_ids);
    select count(*) into v_attachments_count from public.task_attachments where task_id = any(v_subtree_ids);

    insert into public.deletion_log (entity_type, entity_id, entity_name, deleted_by, snapshot, related_counts)
    values (
      'task',
      v_task.id,
      v_task.title,
      v_actor_id,
      to_jsonb(v_task),
      jsonb_build_object('subtasks', v_subtasks_count, 'comments', v_comments_count, 'attachments', v_attachments_count)
    );

    v_all_ids := v_all_ids || v_subtree_ids;
  end loop;

  if array_length(v_all_ids, 1) is null then
    return jsonb_build_object(
      'requested_count', array_length(p_task_ids, 1),
      'deleted_task_ids', '[]'::jsonb,
      'total_deleted_count', 0
    );
  end if;

  select array_agg(distinct x) into v_all_ids from unnest(v_all_ids) as x;

  delete from public.task_comments where task_id = any(v_all_ids);
  delete from public.task_attachments where task_id = any(v_all_ids);
  delete from public.task_assignee_log where task_id = any(v_all_ids);

  delete from public.tasks where id = any(v_all_ids);
  get diagnostics v_deleted_count = row_count;

  return jsonb_build_object(
    'requested_count', array_length(p_task_ids, 1),
    'deleted_task_ids', to_jsonb(v_all_ids),
    'total_deleted_count', v_deleted_count
  );
end;
$$;

-- merge_clients(p_keep_id, p_duplicate_id) — current body per 20261114000000_merge_clients.sql.
-- ai_engineer removed from the role gate (client-side canMergeClients() already excludes it).
create or replace function public.merge_clients(p_keep_id text, p_duplicate_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text := public.app_user_role();
  v_actor_id text := public.app_user_id();
  v_duplicate public.clients;
  v_log_id uuid;
  v_related_counts jsonb := '{}'::jsonb;
  v_assignments_deleted integer := 0;
  v_assignments_moved integer := 0;
  v_rec record;
  v_colname text;
  v_pk_key smallint[];
  v_pk_col text;
  v_table_name text;
  v_moved integer;
  v_deleted integer;
  v_row_id text;
begin
  if v_actor_role not in ('executive', 'head_of_technical') then
    raise exception 'Only executive or head_of_technical may merge clients.';
  end if;

  if p_keep_id is null or p_duplicate_id is null then
    raise exception 'p_keep_id and p_duplicate_id are both required.';
  end if;
  if p_keep_id = p_duplicate_id then
    raise exception 'p_keep_id and p_duplicate_id must be different clients.';
  end if;

  select * into v_duplicate from public.clients where id = p_duplicate_id;
  if v_duplicate.id is null then
    raise exception 'Duplicate client % not found.', p_duplicate_id;
  end if;
  if not exists (select 1 from public.clients where id = p_keep_id) then
    raise exception 'Keep client % not found.', p_keep_id;
  end if;

  insert into public.deletion_log (entity_type, entity_id, entity_name, deleted_by, snapshot, related_counts)
  values ('client', v_duplicate.id, v_duplicate.name, v_actor_id, to_jsonb(v_duplicate), '{}'::jsonb)
  returning id into v_log_id;

  delete from public.assignments
  where client_id = p_duplicate_id
    and service_type in (select service_type from public.assignments where client_id = p_keep_id);
  get diagnostics v_assignments_deleted = row_count;

  update public.assignments set client_id = p_keep_id where client_id = p_duplicate_id;
  get diagnostics v_assignments_moved = row_count;

  v_related_counts := v_related_counts || jsonb_build_object(
    'assignments', jsonb_build_object('moved', v_assignments_moved, 'deleted_duplicates', v_assignments_deleted)
  );

  for v_rec in
    select con.conrelid, con.conkey
    from pg_constraint con
    where con.contype = 'f'
      and con.confrelid = 'public.clients'::regclass
      and con.conrelid <> 'public.assignments'::regclass
  loop
    if array_length(v_rec.conkey, 1) > 1 then
      raise exception 'merge_clients does not support multi-column foreign keys (table %).', v_rec.conrelid::regclass;
    end if;

    select a.attname into v_colname
    from pg_attribute a
    where a.attrelid = v_rec.conrelid and a.attnum = v_rec.conkey[1];

    v_table_name := v_rec.conrelid::regclass::text;
    v_moved := 0;
    v_deleted := 0;

    begin
      execute format('update %s set %I = %L where %I = %L', v_rec.conrelid::regclass, v_colname, p_keep_id, v_colname, p_duplicate_id);
      get diagnostics v_moved = row_count;
    exception when unique_violation then
      select con2.conkey into v_pk_key
      from pg_constraint con2
      where con2.contype = 'p' and con2.conrelid = v_rec.conrelid;

      if v_pk_key is null or array_length(v_pk_key, 1) > 1 then
        raise exception 'merge_clients needs a single-column primary key to resolve conflicts on table % (found none, or a composite key).', v_table_name;
      end if;

      select a.attname into v_pk_col
      from pg_attribute a
      where a.attrelid = v_rec.conrelid and a.attnum = v_pk_key[1];

      for v_row_id in execute format('select %I::text from %s where %I = %L', v_pk_col, v_rec.conrelid::regclass, v_colname, p_duplicate_id)
      loop
        begin
          execute format('update %s set %I = %L where %I = %L', v_rec.conrelid::regclass, v_colname, p_keep_id, v_pk_col, v_row_id);
          v_moved := v_moved + 1;
        exception when unique_violation then
          execute format('delete from %s where %I = %L', v_rec.conrelid::regclass, v_pk_col, v_row_id);
          v_deleted := v_deleted + 1;
        end;
      end loop;
    end;

    v_related_counts := v_related_counts || jsonb_build_object(
      v_table_name, jsonb_build_object('moved', v_moved, 'deleted_duplicates', v_deleted)
    );
  end loop;

  update public.deletion_log set related_counts = v_related_counts where id = v_log_id;

  delete from public.clients where id = p_duplicate_id;

  return jsonb_build_object('keep_id', p_keep_id, 'duplicate_id', p_duplicate_id, 'related_counts', v_related_counts);
end;
$$;

-- merge_clients_preview(p_keep_id, p_duplicate_id) — current body per
-- 20261114000000_merge_clients.sql. ai_engineer removed from the role gate.
create or replace function public.merge_clients_preview(p_keep_id text, p_duplicate_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text := public.app_user_role();
  v_related_counts jsonb := '{}'::jsonb;
  v_rec record;
  v_colname text;
  v_count integer;
  v_assignments_total integer;
  v_assignments_conflict integer;
  v_table_name text;
begin
  if v_actor_role not in ('executive', 'head_of_technical') then
    raise exception 'Only executive or head_of_technical may preview a client merge.';
  end if;

  if p_keep_id is null or p_duplicate_id is null then
    raise exception 'p_keep_id and p_duplicate_id are both required.';
  end if;
  if p_keep_id = p_duplicate_id then
    raise exception 'p_keep_id and p_duplicate_id must be different clients.';
  end if;
  if not exists (select 1 from public.clients where id = p_duplicate_id) then
    raise exception 'Duplicate client % not found.', p_duplicate_id;
  end if;
  if not exists (select 1 from public.clients where id = p_keep_id) then
    raise exception 'Keep client % not found.', p_keep_id;
  end if;

  select count(*) into v_assignments_total from public.assignments where client_id = p_duplicate_id;
  select count(*) into v_assignments_conflict
  from public.assignments
  where client_id = p_duplicate_id
    and service_type in (select service_type from public.assignments where client_id = p_keep_id);

  v_related_counts := v_related_counts || jsonb_build_object(
    'assignments', jsonb_build_object('moved', v_assignments_total - v_assignments_conflict, 'deleted_duplicates', v_assignments_conflict)
  );

  for v_rec in
    select con.conrelid, con.conkey
    from pg_constraint con
    where con.contype = 'f'
      and con.confrelid = 'public.clients'::regclass
      and con.conrelid <> 'public.assignments'::regclass
  loop
    if array_length(v_rec.conkey, 1) > 1 then
      raise exception 'merge_clients_preview does not support multi-column foreign keys (table %).', v_rec.conrelid::regclass;
    end if;

    select a.attname into v_colname
    from pg_attribute a
    where a.attrelid = v_rec.conrelid and a.attnum = v_rec.conkey[1];

    v_table_name := v_rec.conrelid::regclass::text;

    execute format('select count(*) from %s where %I = %L', v_rec.conrelid::regclass, v_colname, p_duplicate_id) into v_count;

    v_related_counts := v_related_counts || jsonb_build_object(v_table_name, jsonb_build_object('count', v_count));
  end loop;

  return v_related_counts;
end;
$$;

-- ============================================================================
-- SECTION 2 — RLS policies
-- ============================================================================

-- --- public.users ---

drop policy if exists "users_insert_admin_rls" on public.users;
create policy "users_insert_admin_rls" on public.users for insert to authenticated with check (
  public.app_user_role() in ('executive', 'head_of_technical') and auth_id is null
);

-- --- public.clients ---

drop policy if exists "clients_select_rls" on public.clients;
create policy "clients_select_rls"
on public.clients
for select
to authenticated
using (
  case public.app_user_role()
    when 'sales' then sales_owner_id = public.app_user_id()
    when 'executive' then true
    when 'head_of_technical' then true
    when 'am_team_lead' then true
    when 'am_agent' then am_agent_id = public.app_user_id()
    when 'media_buying_team_lead' then true
    when 'media_buying_agent' then public.agent_assigned(id, 'media_buying')
    when 'seo_team_lead' then true
    when 'social_media_team_lead' then true
    when 'seo_agent' then (
      public.agent_assigned(id, 'seo')
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
      )
    )
    when 'social_media_agent' then (
      public.agent_assigned(id, 'social_media')
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
      )
    )
    else exists (
      select 1
      from public.tasks t
      where t.client_id = clients.id
        and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
    )
  end
);

drop policy if exists "clients_update_am_assignment_rls" on public.clients;
create policy "clients_update_am_assignment_rls" on public.clients for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'sales' and sales_owner_id = public.app_user_id())
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'sales' and sales_owner_id = public.app_user_id())
);

drop policy if exists "clients_delete_rls" on public.clients;
create policy "clients_delete_rls" on public.clients for delete to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
);

drop policy if exists "clients_insert_leadership_rls" on public.clients;
create policy "clients_insert_leadership_rls" on public.clients for insert to authenticated with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  and public.app_user_id() is not null and sales_owner_id is null
  and (am_team_lead_id is null or exists (select 1 from public.users u where u.id = am_team_lead_id and u.role = 'am_team_lead' and u.auth_id is not null and u.deactivated_at is null))
  and (am_agent_id is null or exists (select 1 from public.users u where u.id = am_agent_id and u.role in ('am_agent', 'am_team_lead') and u.auth_id is not null and u.deactivated_at is null))
);

-- --- public.client_portal_users ---

drop policy if exists "client_portal_users_select_staff_rls" on public.client_portal_users;
create policy "client_portal_users_select_staff_rls" on public.client_portal_users for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

drop policy if exists "client_portal_users_insert_staff_rls" on public.client_portal_users;
create policy "client_portal_users_insert_staff_rls" on public.client_portal_users for insert to authenticated with check (
  auth_id is null and (public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id)))
);

-- --- public.briefs / public.brief_revisions ---

drop policy if exists "briefs_select_rls" on public.briefs;
create policy "briefs_select_rls" on public.briefs for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and submitted_at is not null)
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and submitted_at is not null)
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and submitted_at is not null)
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id) and submitted_at is not null)
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

drop policy if exists "briefs_write_rls" on public.briefs;
create policy "briefs_write_rls" on public.briefs for insert to authenticated with check (
  submitted_by = public.app_user_id() and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

drop policy if exists "briefs_update_rls" on public.briefs;
create policy "briefs_update_rls" on public.briefs for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

drop policy if exists "brief_revisions_select_rls" on public.brief_revisions;
create policy "brief_revisions_select_rls" on public.brief_revisions for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and edited_by = public.app_user_id())
);

drop policy if exists "brief_revisions_insert_rls" on public.brief_revisions;
create policy "brief_revisions_insert_rls" on public.brief_revisions for insert to authenticated with check (
  edited_by = public.app_user_id() and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
    or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

-- --- public.assignments ---

drop policy if exists "assignments_select_rls" on public.assignments;
create policy "assignments_select_rls" on public.assignments for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and agent_id = public.app_user_id())
);

drop policy if exists "assignments_update_rls" on public.assignments;
create policy "assignments_update_rls" on public.assignments
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
);

drop policy if exists "assignments_insert_rls" on public.assignments;
create policy "assignments_insert_rls" on public.assignments
for insert to authenticated
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (
    public.app_user_role() in ('executive', 'head_of_technical')
    and service_type in ('seo', 'media_buying', 'social_media')
    and public.client_has_service(client_id, service_type)
    and exists (
      select 1
      from public.users assignee
      where assignee.id = agent_id
        and assignee.auth_id is not null
        and assignee.deactivated_at is null
        and (
          (service_type = 'seo' and assignee.role in (
            'seo_team_lead',
            'seo_agent',
            'seo_content_agent',
            'seo_backlink_agent'
          ))
          or (service_type = 'media_buying' and assignee.role in (
            'media_buying_team_lead',
            'media_buying_agent'
          ))
          or (service_type = 'social_media' and assignee.role in (
            'social_media_team_lead',
            'social_media_agent'
          ))
        )
    )
  )
);

-- --- public.campaigns / public.social_insights / public.analytics_insights ---

drop policy if exists "campaigns_select_rls" on public.campaigns;
create policy "campaigns_select_rls" on public.campaigns for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
);

drop policy if exists "social_insights_select_rls" on public.social_insights;
create policy "social_insights_select_rls" on public.social_insights for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'social_media_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(client_id, 'social_media'))
);

-- social_insights_write_rls/update_rls (20261025000000_social_insights_weekly_manual_entry.sql)
-- carried a TEMPORARY TRANSITION bridge grant for head_of_technical/ai_engineer. ai_engineer is
-- removed; head_of_technical's own bridge grant is left exactly as that migration's own comments
-- describe it (to be revoked later, separately, once real department users are onboarded).
drop policy if exists "social_insights_write_rls" on public.social_insights;
create policy "social_insights_write_rls" on public.social_insights
for insert to authenticated
with check (
  (public.app_user_role() = 'social_media_agent' and public.agent_assigned(client_id, 'social_media'))
  or (public.app_user_role() = 'social_media_team_lead' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() = 'head_of_technical' and public.client_has_service(client_id, 'social_media'))
);

drop policy if exists "social_insights_update_rls" on public.social_insights;
create policy "social_insights_update_rls" on public.social_insights
for update to authenticated
using (
  (public.app_user_role() = 'social_media_agent' and public.agent_assigned(client_id, 'social_media'))
  or (public.app_user_role() = 'social_media_team_lead' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() = 'head_of_technical' and public.client_has_service(client_id, 'social_media'))
)
with check (
  (public.app_user_role() = 'social_media_agent' and public.agent_assigned(client_id, 'social_media'))
  or (public.app_user_role() = 'social_media_team_lead' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() = 'head_of_technical' and public.client_has_service(client_id, 'social_media'))
);

drop policy if exists "analytics_insights_select_rls" on public.analytics_insights;
create policy "analytics_insights_select_rls" on public.analytics_insights for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'seo_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_agent' and public.agent_assigned(client_id, 'seo'))
);

-- --- public.seo_insights / public.media_buying_insights ---

drop policy if exists "seo_insights_select_rls" on public.seo_insights;
create policy "seo_insights_select_rls" on public.seo_insights
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'seo_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_agent' and public.agent_assigned(client_id, 'seo'))
);

drop policy if exists "media_buying_insights_select_rls" on public.media_buying_insights;
create policy "media_buying_insights_select_rls" on public.media_buying_insights
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
);

-- --- public.platform_connections ---

drop policy if exists "platform_connections_select_rls" on public.platform_connections;
create policy "platform_connections_select_rls" on public.platform_connections for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

drop policy if exists "platform_connections_insert_rls" on public.platform_connections;
create policy "platform_connections_insert_rls" on public.platform_connections for insert to authenticated with check (
  (public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id)))
  and (connected_by is null or connected_by = public.app_user_id())
);

drop policy if exists "platform_connections_update_rls" on public.platform_connections;
create policy "platform_connections_update_rls" on public.platform_connections for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
) with check (
  (public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id)))
  and (connected_by is null or connected_by = public.app_user_id())
);

-- --- public.capacity_logs ---

drop policy if exists "capacity_logs_insert_rls" on public.capacity_logs;
create policy "capacity_logs_insert_rls" on public.capacity_logs for insert to authenticated with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
  and public.employee_visible_by_id(agent_id)
);

-- --- public.meetings ---

drop policy if exists "meetings_select_rls" on public.meetings;
create policy "meetings_select_rls" on public.meetings for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead') or am_agent_id = public.app_user_id()
);

drop policy if exists "meetings_insert_rls" on public.meetings;
create policy "meetings_insert_rls" on public.meetings for insert to authenticated with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id() and public.client_am_agent_is_caller(client_id))
);

drop policy if exists "meetings_update_rls" on public.meetings;
create policy "meetings_update_rls" on public.meetings for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id())
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id())
);

-- --- public.brief_field_schemas ---

drop policy if exists "brief_field_schemas_write_rls" on public.brief_field_schemas;
create policy "brief_field_schemas_write_rls" on public.brief_field_schemas for all to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'am_agent')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'am_agent')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
);

-- --- storage.objects: meeting-recordings ---

drop policy if exists "meeting_recordings_objects_select_rls" on storage.objects;
create policy "meeting_recordings_objects_select_rls" on storage.objects for select to authenticated using (
  bucket_id = 'meeting-recordings' and (public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead') or public.client_am_agent_is_caller((storage.foldername(name))[1]))
);

drop policy if exists "meeting_recordings_objects_insert_rls" on storage.objects;
create policy "meeting_recordings_objects_insert_rls" on storage.objects for insert to authenticated with check (
  bucket_id = 'meeting-recordings' and (public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead') or public.client_am_agent_is_caller((storage.foldername(name))[1]))
);

-- --- public.client_contracts + storage.objects: client-contracts ---

drop policy if exists "client_contracts_select_rls" on public.client_contracts;
create policy "client_contracts_select_rls" on public.client_contracts for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'sales' and exists (select 1 from public.clients c where c.id = client_id and c.sales_owner_id = public.app_user_id()))
);

drop policy if exists "client_contracts_insert_rls" on public.client_contracts;
create policy "client_contracts_insert_rls" on public.client_contracts for insert to authenticated with check (
  uploaded_by = public.app_user_id() and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() = 'sales' and exists (select 1 from public.clients c where c.id = client_id and c.sales_owner_id = public.app_user_id()))
  )
);

drop policy if exists "client_contracts_delete_rls" on public.client_contracts;
create policy "client_contracts_delete_rls" on public.client_contracts for delete to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'sales' and exists (select 1 from public.clients c where c.id = client_contracts.client_id and c.sales_owner_id = public.app_user_id()))
);

drop policy if exists "client_contracts_objects_select_rls" on storage.objects;
create policy "client_contracts_objects_select_rls" on storage.objects
for select
to authenticated
using (
  bucket_id = 'client-contracts'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(storage.objects.name))[1])
    or exists (
      select 1 from public.clients c
      where c.id = (storage.foldername(storage.objects.name))[1]
        and c.sales_owner_id = public.app_user_id()
    )
  )
);

drop policy if exists "client_contracts_objects_insert_rls" on storage.objects;
create policy "client_contracts_objects_insert_rls" on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'client-contracts'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(storage.objects.name))[1])
    or exists (
      select 1 from public.clients c
      where c.id = (storage.foldername(storage.objects.name))[1]
        and c.sales_owner_id = public.app_user_id()
    )
  )
);

drop policy if exists "client_contracts_objects_delete_rls" on storage.objects;
create policy "client_contracts_objects_delete_rls" on storage.objects for delete to authenticated using (
  bucket_id = 'client-contracts' and (public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead') or public.client_am_agent_is_caller((storage.foldername(name))[1]) or exists (select 1 from public.clients c where c.id = (storage.foldername(name))[1] and c.sales_owner_id = public.app_user_id()))
);

-- --- public.kpi_scores / public.task_attachments / public.task_comments ---
-- (the executive/head_of_technical/ai_engineer bypass added by
-- 20261020200000_leadership_ownership_override.sql; ai_engineer removed, ownership branch kept)

drop policy if exists "kpi_scores_update_rls" on public.kpi_scores;
create policy "kpi_scores_update_rls" on public.kpi_scores
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  or (reviewed_by = public.app_user_id() and public.direct_report_visible(user_id))
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical')
  or (reviewed_by = public.app_user_id() and public.direct_report_visible(user_id))
);

drop policy if exists "task_attachments_delete_rls" on public.task_attachments;
create policy "task_attachments_delete_rls" on public.task_attachments
for delete to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  or uploaded_by = public.app_user_id()
);

drop policy if exists "task_attachments_objects_delete_rls" on storage.objects;
create policy "task_attachments_objects_delete_rls" on storage.objects
for delete to authenticated
using (
  bucket_id = 'task-attachments'
  and (
    public.app_user_role() in ('executive', 'head_of_technical')
    or exists (
      select 1 from public.task_attachments a
      where a.storage_path = storage.objects.name
        and a.uploaded_by = public.app_user_id()
    )
  )
);

drop policy if exists "task_comments_update_rls" on public.task_comments;
create policy "task_comments_update_rls" on public.task_comments
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  or author_id = public.app_user_id()
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical')
  or author_id = public.app_user_id()
);

-- --- public.daily_logs ---
-- TRUE current body per 20261123000000_daily_logs_department_team_lead_visibility_rollback.sql
-- (byte-identical to 20261028100000_daily_logs_report_scope_visibility.sql — the department-team-
-- lead widening was added and then rolled back). ai_engineer removed from the unconditional branch.

drop policy if exists "daily_logs_select_rls" on public.daily_logs;
create policy "daily_logs_select_rls" on public.daily_logs
for select to authenticated
using (
  public.direct_report_visible(user_id)
  or (client_id is not null and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  ))
);

-- --- public.platforms (20261108000000_task_platforms.sql) ---

drop policy if exists "platforms_write_rls" on public.platforms;
create policy "platforms_write_rls" on public.platforms
for insert to authenticated
with check (public.app_user_role() in ('executive', 'head_of_technical'));

drop policy if exists "platforms_update_rls" on public.platforms;
create policy "platforms_update_rls" on public.platforms
for update to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical'))
with check (public.app_user_role() in ('executive', 'head_of_technical'));

-- --- public.deletion_log (20261113000000_task_hard_delete.sql) ---

drop policy if exists "deletion_log_select_rls" on public.deletion_log;
create policy "deletion_log_select_rls" on public.deletion_log
for select to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical'));

-- --- public.client_access_log (20261030500000_protect_client_access_columns.sql) ---

drop policy if exists "client_access_log_select_rls" on public.client_access_log;
create policy "client_access_log_select_rls" on public.client_access_log for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical')
);

commit;
