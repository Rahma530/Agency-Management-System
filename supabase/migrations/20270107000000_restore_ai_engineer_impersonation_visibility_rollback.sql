-- Rollback for 20270107000000_restore_ai_engineer_impersonation_visibility.sql — restores
-- employee_visible() to its body from 20270106000000_head_of_sales_team_and_brief_visibility.sql
-- (i.e. removes the restored leading `public.app_user_role() = 'ai_engineer' or` disjunct again,
-- keeping the head_of_sales branch).
begin;

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
      public.app_user_role() = 'head_of_sales'
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

commit;
