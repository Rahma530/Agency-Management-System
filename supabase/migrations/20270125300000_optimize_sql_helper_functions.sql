-- Last 4 from the audit: plain "language sql" helper functions (not plpgsql RPCs) that also
-- called app_user_role()/app_user_id() more than once per invocation, same pattern as
-- task_visible_v2/employee_visible/report_scope_accessible. Fixed the same way: a leading CTE
-- computes each repeated value once, referenced everywhere the body previously called the
-- function directly. Only the value(s) actually called more than once are cached — e.g.
-- task_closable calls app_user_role() just once (left as a direct call) but app_user_id() twice
-- (cached). Verified by diffing each original body (with only the repeated function calls
-- substituted for the CTE's columns) against the new one — identical. Same signatures, so
-- existing grants are preserved automatically by CREATE OR REPLACE FUNCTION.
begin;

create or replace function public.employee_manageable(target_id text, target_role text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  with ctx as (select public.app_user_role() as role)
  select ctx.role in ('executive', 'head_of_technical')
    or target_id = public.app_user_id()
    or (ctx.role = 'am_team_lead' and target_role in ('am_team_lead', 'am_agent'))
    or (ctx.role = 'media_buying_team_lead' and target_role in ('media_buying_team_lead', 'media_buying_agent'))
    or (ctx.role = 'seo_team_lead' and target_role in ('seo_team_lead', 'seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager'))
    or (ctx.role = 'social_media_team_lead' and target_role in ('social_media_team_lead', 'social_media_agent'))
  from ctx;
$$;

create or replace function public.app_has_permission(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ctx as (select public.app_user_role() as role)
  select case
    when ctx.role in (
      'executive', 'head_of_technical', 'sales', 'am_team_lead', 'am_agent',
      'media_buying_team_lead', 'media_buying_agent', 'seo_team_lead', 'seo_agent',
      'store_manager', 'seo_content_agent', 'seo_backlink_agent', 'programming_agent',
      'social_media_team_lead', 'social_media_agent', 'graphic_designer', 'video_editor',
      'ai_engineer', 'marketing_manager'
    ) then false
    when not exists (
      select 1 from public.permission_catalog pc where pc.key = p_key and pc.grantable
    ) then false
    when not exists (
      select 1 from public.custom_roles cr
      where cr.id = ctx.role and cr.is_active
    ) then false
    else coalesce(
      (
        select crp.granted
        from public.custom_role_permissions crp
        where crp.role_id = ctx.role and crp.permission_key = p_key
      ),
      exists (
        select 1
        from public.custom_roles cr
        join public.department_permissions dp on dp.department_id = cr.department_id
        where cr.id = ctx.role and dp.permission_key = p_key
      )
    )
  end
  from ctx;
$$;

create or replace function public.report_caller_client_service_lock()
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  with ctx as (select public.app_user_role() as role)
  select case
    when ctx.role in (
      'executive','head_of_technical','am_team_lead','am_agent',
      'seo_team_lead','media_buying_team_lead','social_media_team_lead'
    ) then null::text
    when ctx.role in ('seo_agent','store_manager','seo_content_agent','seo_backlink_agent') then 'seo'
    when ctx.role = 'media_buying_agent' then 'media_buying'
    when ctx.role = 'social_media_agent' then 'social_media'
    else 'own_entries'
  end
  from ctx;
$$;

create or replace function public.task_closable(p_task_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ctx as (select public.app_user_id() as uid)
  select
    public.app_user_role() in ('executive', 'head_of_technical')
    or exists (select 1 from public.tasks t where t.id = p_task_id and t.created_by = ctx.uid)
    or exists (
      select 1 from public.task_assignees ta
      where ta.task_id = p_task_id and ta.user_id = ctx.uid
    )
  from ctx;
$$;

commit;
