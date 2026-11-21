-- Follow-up to 20270122000000_optimize_task_visibility_functions.sql: audit of every RLS
-- helper function in the schema for the same redundant-identity-lookup pattern.
--
-- Checked: agent_assigned, agent_assigned_any_service, client_am_agent_is_caller,
-- client_has_service, employee_visible_by_id, comparison_scope_accessible — each of these already
-- calls app_user_role()/app_user_id() at most once, so none of them needed a change.
--
-- Two did NOT pass the audit, and are fixed here the same way (leading CTE, same mechanical
-- substitution, zero logic change):
--   - employee_visible(target_id, target_role): calls public.app_user_role() 23 separate times and
--     public.app_user_id() 3 times in ONE invocation. This is the RLS check behind seeing another
--     employee's row (users table and anything that joins it for employee-scoped visibility) — on
--     a users list, that's 23x per employee row, which is worse than task_visible_v2 ever was.
--   - report_scope_accessible(p_client_id, p_agent_id): calls public.app_user_role() 8 times and
--     public.app_user_id() once in one invocation — the gate behind every Reports-feature access
--     check (report_drafts, comparisons).
--
-- As before: nested calls this function makes to OTHER functions (agent_assigned,
-- client_has_service, client_am_agent_is_caller, app_has_permission, direct_report_visible) are
-- left untouched — those already do at most one identity lookup internally, and changing their
-- signatures to accept a shared cached value would be a much bigger, riskier refactor for a small
-- additional gain. Only each function's OWN direct, repeated calls are deduplicated.
begin;

create or replace function public.employee_visible(target_id text, target_role text)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  with ctx as (
    select public.app_user_role() as role, public.app_user_id() as uid
  )
  select target_id = ctx.uid
    or ctx.role in ('executive', 'head_of_technical')
    or (target_role in ('graphic_designer', 'video_editor') and ctx.role <> 'sales')
    or (ctx.role = 'am_team_lead' and target_role in ('am_team_lead', 'am_agent'))
    or (ctx.role = 'media_buying_team_lead' and target_role in ('media_buying_team_lead', 'media_buying_agent'))
    or (ctx.role = 'seo_team_lead' and target_role in ('seo_team_lead', 'seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager'))
    or (ctx.role = 'social_media_team_lead' and target_role in ('social_media_team_lead', 'social_media_agent'))
    or (ctx.role = 'am_agent' and target_role in ('am_agent', 'am_team_lead'))
    or (ctx.role = 'media_buying_agent' and target_role in ('media_buying_agent', 'media_buying_team_lead'))
    or (ctx.role = 'seo_agent' and target_role in ('seo_agent', 'seo_team_lead'))
    or (ctx.role = 'programming_agent' and target_role in ('programming_agent', 'seo_team_lead'))
    or (ctx.role = 'seo_content_agent' and target_role in ('seo_content_agent', 'seo_team_lead'))
    or (ctx.role = 'seo_backlink_agent' and target_role in ('seo_backlink_agent', 'seo_team_lead'))
    or (ctx.role = 'store_manager' and target_role in ('store_manager', 'seo_team_lead'))
    or (ctx.role = 'social_media_agent' and target_role in ('social_media_agent', 'social_media_team_lead'))
    or (ctx.role = 'sales' and target_role = 'sales')
    or (
      ctx.role = 'head_of_sales'
      and target_role in (
        'am_team_lead', 'am_agent',
        'media_buying_team_lead', 'media_buying_agent',
        'seo_team_lead', 'seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager',
        'social_media_team_lead', 'social_media_agent',
        'graphic_designer', 'video_editor'
      )
    )
    or (
      target_role in ('am_agent', 'am_team_lead') and exists (
        select 1 from public.clients c
        where (c.am_agent_id = target_id or c.am_team_lead_id = target_id) and (
          ctx.role in ('media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
          or (ctx.role = 'media_buying_agent' and public.agent_assigned(c.id, 'media_buying'))
          or (ctx.role = 'seo_agent' and public.agent_assigned(c.id, 'seo'))
          or (ctx.role = 'store_manager' and public.agent_assigned(c.id, 'seo'))
          or (ctx.role = 'social_media_agent' and public.agent_assigned(c.id, 'social_media'))
          or exists (
            select 1 from public.tasks t
            where t.client_id = c.id
              and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = ctx.uid)
          )
        )
      )
    )
    or (
      ctx.role <> 'sales'
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
        where me.id = ctx.role and other.id = target_role
          and other.is_active and me.is_active
      )
    )
  from ctx;
$function$;

create or replace function public.report_scope_accessible(p_client_id text, p_agent_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  with ctx as (
    select public.app_user_role() as role, public.app_user_id() as uid
  )
  select case
    when p_client_id is not null then (
      ctx.role in ('executive','head_of_technical','am_team_lead')
      or (ctx.role='am_agent' and public.client_am_agent_is_caller(p_client_id))
      or (ctx.role='media_buying_team_lead' and public.client_has_service(p_client_id,'media_buying'))
      or (ctx.role='media_buying_agent' and public.agent_assigned(p_client_id,'media_buying'))
      or (ctx.role='seo_team_lead' and public.client_has_service(p_client_id,'seo'))
      or (ctx.role in ('seo_agent','store_manager','seo_content_agent','seo_backlink_agent') and public.agent_assigned(p_client_id,'seo'))
      or (ctx.role='social_media_team_lead' and public.client_has_service(p_client_id,'social_media'))
      or (ctx.role='social_media_agent' and public.agent_assigned(p_client_id,'social_media'))
      or (exists(
        select 1 from public.custom_roles cr
        join public.custom_role_modules crm on crm.role_id=cr.id and crm.module_id='reports'
        join public.assignments a on a.agent_id=ctx.uid and a.client_id=p_client_id
        where cr.id=ctx.role and cr.is_active
      ))
    )
    when p_agent_id is not null then public.direct_report_visible(p_agent_id)
    else false end
  from ctx;
$$;

commit;
