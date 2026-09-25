-- Fix: executive/head_of_technical/ai_engineer were never added to briefs_write_rls or
-- brief_revisions_insert_rls, even though canEditServiceBrief() (lib/permissions.ts) has always
-- promised these three roles unconditional brief-edit rights. Pre-existing bug, unrelated to the
-- ai_engineer alignment work: briefs_update_rls already covers them (editing an EXISTING brief's
-- fields succeeds), but creating a client's FIRST brief for a given service (briefs_write_rls) and
-- the append-only revision-history row written on every save, including that first one
-- (brief_revisions_insert_rls), have always excluded these three roles — the insert is silently
-- rejected by RLS and swallowed by App.tsx's catch block, while the UI still reports success.
begin;

drop policy if exists "briefs_write_rls" on public.briefs;
create policy "briefs_write_rls" on public.briefs for insert to authenticated with check (
  submitted_by = public.app_user_id() and (
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

drop policy if exists "brief_revisions_insert_rls" on public.brief_revisions;
create policy "brief_revisions_insert_rls" on public.brief_revisions for insert to authenticated with check (
  edited_by = public.app_user_id() and (
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
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

commit;
