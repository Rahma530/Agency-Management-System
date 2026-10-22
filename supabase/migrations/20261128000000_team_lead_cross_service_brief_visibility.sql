-- Team Leads (SEO/Media Buying/Social Media) can now see every SUBMITTED service brief for a
-- client they can already open — not just their own department's brief.
--
-- Before this change, briefs_select_rls (20261014100000_brief_submitted_at_visibility.sql) scoped
-- each department team lead's branch to BOTH their own service_type AND submitted_at is not null:
--   (app_user_role() = 'seo_team_lead' and service_type = 'seo' and client_has_service(...) and submitted_at is not null)
-- so a SEO Team Lead opening a client's Service Briefs tab could only ever see the SEO brief,
-- even though the UI itself (ClientDashboard.tsx's hasBriefViewAccess/canViewBriefContent) already
-- lists every one of the client's services as a selectable sub-tab regardless of the viewer's own
-- department — RLS silently returned zero rows for every OTHER service's brief, so those sub-tabs
-- always rendered as "Pending", never as the actually-submitted content a teammate on another
-- department had already filled in. Per the agency owner: when a Team Lead opens any client
-- (including a newly onboarded one), they should be able to read every other service's brief too,
-- once it's submitted — this is read access only, nothing about who may EDIT a brief changes
-- (briefs_update_rls/briefs_write_rls, and canEditServiceBrief, are both untouched: still
-- executive/head_of_technical/am_team_lead/am_agent-only).
--
-- Scope: the 3 department TEAM LEAD branches only. The individual-agent branch
-- (seo_agent/media_buying_agent/social_media_agent via agent_assigned_any_service) and the
-- designer branch (graphic_designer/video_editor, service_type = 'creative') are both left exactly
-- as they were — this was asked for Team Leads specifically, not individual agents, who stay
-- scoped to the clients/services they're personally assigned to. mark_brief_viewed() (RPC in
-- 20261013100000_service_brief_view_only_for_departments.sql) is also untouched — it tracks a
-- department's own SLA on its own brief, which is a different concept from being allowed to READ
-- another department's already-submitted one.
begin;

drop policy "briefs_select_rls" on public.briefs;

create policy "briefs_select_rls" on public.briefs
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() in ('seo_team_lead', 'media_buying_team_lead', 'social_media_team_lead') and submitted_at is not null)
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id) and submitted_at is not null)
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

commit;
