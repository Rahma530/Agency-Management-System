-- Fixes a confirmed bug surfaced while auditing users_update_guard_trigger
-- (20261030000000_users_update_guard_trigger.sql): employee_visible()'s seo_team_lead branch only
-- ever granted visibility into 'seo_agent'/'programming_agent' — seo_content_agent and
-- seo_backlink_agent (real, insertable roles; users_role_check already permits all 18 UserRole
-- values) were never added to it, so a seo_team_lead couldn't see those rows at all, regardless of
-- anything that trigger allows once a row IS visible.
--
-- Copies the live function body from 20261019000000_ai_engineer_full_application_authorization.sql
-- exactly, with only two changes:
--   1. The seo_team_lead branch's target_role list gains seo_content_agent and seo_backlink_agent,
--      alongside the existing seo_team_lead/seo_agent/programming_agent.
--   2. Two new branches, mirroring the existing seo_agent self-and-lead branch exactly: a
--      seo_content_agent sees seo_content_agent/seo_team_lead rows, and a seo_backlink_agent sees
--      seo_backlink_agent/seo_team_lead rows (each own role plus their team lead — the same shape
--      every other agent role already gets).
-- Everything else — every other role's branch, the client-assignment exists() clause at the end —
-- is unchanged.
begin;

create or replace function public.employee_visible(target_id text, target_role text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.app_user_role() = 'ai_engineer'
    or target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
    or (target_role in ('graphic_designer', 'video_editor') and public.app_user_role() <> 'sales')
    or (public.app_user_role() = 'am_team_lead' and target_role in ('am_team_lead', 'am_agent'))
    or (public.app_user_role() = 'media_buying_team_lead' and target_role in ('media_buying_team_lead', 'media_buying_agent'))
    or (public.app_user_role() = 'seo_team_lead' and target_role in ('seo_team_lead', 'seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent'))
    or (public.app_user_role() = 'social_media_team_lead' and target_role in ('social_media_team_lead', 'social_media_agent'))
    or (public.app_user_role() = 'am_agent' and target_role in ('am_agent', 'am_team_lead'))
    or (public.app_user_role() = 'media_buying_agent' and target_role in ('media_buying_agent', 'media_buying_team_lead'))
    or (public.app_user_role() = 'seo_agent' and target_role in ('seo_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'programming_agent' and target_role in ('programming_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'seo_content_agent' and target_role in ('seo_content_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'seo_backlink_agent' and target_role in ('seo_backlink_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'social_media_agent' and target_role in ('social_media_agent', 'social_media_team_lead'))
    or (public.app_user_role() = 'sales' and target_role = 'sales')
    or (
      target_role in ('am_agent', 'am_team_lead') and exists (
        select 1 from public.clients c
        where (c.am_agent_id = target_id or c.am_team_lead_id = target_id) and (
          public.app_user_role() in ('media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
          or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(c.id, 'media_buying'))
          or (public.app_user_role() = 'seo_agent' and public.agent_assigned(c.id, 'seo'))
          or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(c.id, 'social_media'))
          or exists (select 1 from public.tasks t where t.client_id = c.id and t.assigned_to = public.app_user_id())
        )
      )
    );
$$;

commit;
