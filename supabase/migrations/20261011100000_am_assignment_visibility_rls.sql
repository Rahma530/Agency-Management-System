-- Fix: "Assigned Team" tab shows the AM Agent / AM Team Leader as "Unassigned" for viewers
-- outside Account Management, even when clients.am_agent_id / am_team_lead_id is correctly
-- set by an authorized assigner (executive/head_of_technical/am_team_lead).
--
-- Root cause: the write path (handleAssignAMAgent/handleAssignAMTeamLead in App.tsx) is fine
-- — it correctly persists clients.am_agent_id/am_team_lead_id. The read path
-- (ClientDashboard.tsx's `users.find(u => u.id === client.am_agent_id)`) depends on the
-- VIEWER's own `users` row-visibility: employee_visible() only grants a department team lead
-- (media_buying/seo/social_media) or agent visibility into their OWN department's roles, never
-- 'am_agent'/'am_team_lead'. So a SEO/Media Buying/Social Media Team Leader (or one of their
-- agents), all of whom clients_select_rls already lets see this exact client, gets an empty
-- `users` row for the assigned AM and the UI falls back to its "Unassigned" default — the id is
-- there, the name just can't be resolved.
--
-- Fix: extend employee_visible() so anyone who can already see a given client (per
-- clients_select_rls's own per-role scoping, mirrored here) can also resolve the identity of
-- that client's assigned AM Agent / AM Team Leader. This does not grant blanket AM-directory
-- visibility — only the specific AM tied to a client the viewer can already open.
create or replace function public.employee_visible(target_id text, target_role text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
    or (target_role in ('graphic_designer', 'video_editor') and public.app_user_role() <> 'sales')
    or (public.app_user_role() = 'am_team_lead' and target_role in ('am_team_lead', 'am_agent'))
    or (public.app_user_role() = 'media_buying_team_lead' and target_role in ('media_buying_team_lead', 'media_buying_agent'))
    or (public.app_user_role() = 'seo_team_lead' and target_role in ('seo_team_lead', 'seo_agent', 'programming_agent'))
    or (public.app_user_role() = 'social_media_team_lead' and target_role in ('social_media_team_lead', 'social_media_agent'))
    or (public.app_user_role() = 'am_agent' and target_role in ('am_agent', 'am_team_lead'))
    or (public.app_user_role() = 'media_buying_agent' and target_role in ('media_buying_agent', 'media_buying_team_lead'))
    or (public.app_user_role() = 'seo_agent' and target_role in ('seo_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'programming_agent' and target_role in ('programming_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'social_media_agent' and target_role in ('social_media_agent', 'social_media_team_lead'))
    or (public.app_user_role() = 'sales' and target_role = 'sales')
    or (
      target_role in ('am_agent', 'am_team_lead')
      and exists (
        select 1 from public.clients c
        where (c.am_agent_id = target_id or c.am_team_lead_id = target_id)
          and (
            public.app_user_role() in ('media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
            or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(c.id, 'media_buying'))
            or (public.app_user_role() = 'seo_agent' and public.agent_assigned(c.id, 'seo'))
            or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(c.id, 'social_media'))
            or exists (select 1 from public.tasks t where t.client_id = c.id and t.assigned_to = public.app_user_id())
          )
      )
    );
$$;
