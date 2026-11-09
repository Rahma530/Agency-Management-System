-- Fix: ai_engineer's "Impersonate Employee" picker no longer lists every employee, regressing
-- from the owner's explicit, unchanged requirement that ai_engineer keep full impersonation
-- coverage (stated verbatim in 20261124000000_ai_engineer_deprivilege.sql's own header: "ai_engineer
-- keeps the ability to impersonate employees ... Impersonation is NOT touched anywhere in this
-- file").
--
-- Root cause: EmployeeImpersonation.tsx has no RLS path of its own — it is handed the SAME global
-- `employees`/`users` list every other screen in the app uses (fetched once under
-- users_select_rls -> employee_visible()), then just filters it client-side to active accounts
-- (isActiveEmployee). That migration's own header says "Impersonation is NOT touched anywhere in
-- this file" and that is true of the impersonation Edge Function and the
-- canImpersonateEmployees()/canUseEmployeeTestingMode() checks — but employee_visible() WAS
-- touched (its leading `public.app_user_role() = 'ai_engineer' or` disjunct, which previously gave
-- ai_engineer an unconditional view of every row in public.users, was removed as part of the
-- general de-privileging sweep). Since the picker's candidate list is just that same RLS-filtered
-- users list, removing it silently narrowed "impersonate anyone" down to "impersonate whichever
-- handful of people the rest of employee_visible()'s per-department branches happen to let
-- ai_engineer see" (in practice: almost nobody, since ai_engineer matches none of those
-- operational branches).
--
-- Fix: restore exactly that one disjunct, in its original position (first in the OR chain,
-- confirmed byte-identical to its pre-deprivilege body in
-- 20261104100000_task_visibility_cutover.sql / 20261101600000_custom_roles_employee_visibility.sql),
-- on top of the head_of_sales branch added by 20270106000000_head_of_sales_team_and_brief_visibility.sql.
-- Nothing else in employee_visible() changes, and no other object touched by the deprivilege
-- migration is reverted here — this is scoped to the one function impersonation's employee list
-- actually depends on.
--
-- Trade-off to flag explicitly: restoring this disjunct does mean ai_engineer regains the ability
-- to see every employee's basic profile row (name, email, role — not edit/update rights; those
-- stay independently denied by users_update_capacity_rls/users_update_profile_rls/
-- users_deactivate_rls, which the deprivilege migration confirmed already excluded ai_engineer on
-- their own and are untouched here) anywhere in the app that reads the same global users list —
-- not only inside the impersonation modal. There is no narrower mechanism available: the picker
-- was never backed by its own RLS scope, so keeping "impersonate anyone" and "see only a few
-- people's names elsewhere" are not both achievable without giving the impersonation picker its
-- own dedicated, differently-scoped data path (a larger change, not done here).
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
