-- Additive custom-role support for employee_visible(), per the agreed business rules for a
-- shared-creative-pool custom role (e.g. a "UI Designer" role inside the Creative & Design
-- department):
--   (a) Shared creative pool: visible to every non-sales caller, exactly like graphic_designer/
--       video_editor already are (the existing `target_role in ('graphic_designer','video_editor')
--       and app_user_role() <> 'sales'` arm, left untouched below).
--   (b) Department peers: visible to another custom role in the same department ONLY when the
--       caller holds app_has_permission('employees.view_department_peers') (department default or
--       per-role override, from 20261101400000_custom_roles_departments_foundation.sql).
--
-- Every existing OR arm below is copied VERBATIM from the current definition
-- (20261101300000_sync_role_check_and_employee_visible.sql) — same order, same parentheses,
-- nothing altered, nothing removed. Only two new OR arms are appended at the very end, at the
-- same top-level OR nesting as every other arm. This means:
--   - All 19 built-in roles see EXACTLY what they see today — zero regression, since no existing
--     branch changed and neither new arm can ever be satisfied by a built-in role (arm (a) doesn't
--     care about the caller's own role beyond "not sales", which was already true for every
--     built-in role that isn't sales under the existing graphic_designer/video_editor arm's own
--     "<> 'sales'" condition; arm (b) requires app_has_permission(), which
--     20261101400000_custom_roles_departments_foundation.sql's app_has_permission() returns false
--     for unconditionally for all 19 built-in roles).
--   - A custom role's own row stays visible via the existing, unconditional `target_id =
--     app_user_id()` arm — unaffected by anything here.
--   - head_of_technical/executive/ai_engineer continue to see a custom role's row via the existing
--     `app_user_role() = 'ai_engineer' or ... app_user_role() in ('executive','head_of_technical')`
--     arms, unaffected by anything here.
--
-- No other object changes. No change to users_update_guard() or any users_*_rls write policy —
-- custom roles still have no UPDATE/INSERT policy on public.users at all, so this migration only
-- ever widens SELECT-time visibility, never write access.
begin;

create or replace function public.employee_visible(target_id text, target_role text)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select public.app_user_role() = 'ai_engineer'
    or target_id = public.app_user_id()
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
          or exists (select 1 from public.tasks t where t.client_id = c.id and t.assigned_to = public.app_user_id())
        )
      )
    )
    -- Additive arm (a): a custom role in a shared-resource department (e.g. Creative & Design) is
    -- visible to every non-sales employee, exactly like graphic_designer/video_editor above.
    or (
      public.app_user_role() <> 'sales'
      and exists (
        select 1 from public.custom_roles cr
        join public.departments d on d.id = cr.department_id
        where cr.id = target_role and cr.is_active and d.is_shared_resource
      )
    )
    -- Additive arm (b): a custom role sees its own department's peers only when explicitly
    -- granted employees.view_department_peers (department default or per-role override).
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
