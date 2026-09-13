-- ============================================================================
-- Module 12, Phase 5: "New assignment" notification badge for agent roles.
-- ============================================================================
--
-- Mirrors clients.am_team_lead_viewed_at, at the grain each role actually
-- has a relationship to a client through:
--
--   - seo_agent / media_buying_agent / social_media_agent are formally
--     assigned to a client via a row in `assignments` (one per client +
--     service_type) — so the badge lives on assignments.viewed_at, cleared
--     whenever the row's agent_id changes (App.tsx's handleAssignServiceAgent
--     already updates agent_id in place on reassignment) and set when that
--     agent opens the client (ClientDashboard.tsx).
--
--   - programming_agent has deliberately NO assignments relationship (Module
--     12 Phase 1: task-based only, same as graphic_designer/video_editor) —
--     there is no "you now own this client" row to hang a badge on. The
--     closest equivalent is tasks.assignee_viewed_at: cleared whenever a
--     task's assigned_to changes, set when the assignee opens the client
--     that task belongs to. This column is generic (any task, any assignee)
--     but is only surfaced in the UI for programming_agent, since that's the
--     only role this phase was asked to cover that has no assignments row.
--
-- Both are notification-badge-only, per the confirmed default — never used
-- to gate access to anything.
-- ============================================================================

begin;

alter table public.assignments add column if not exists viewed_at timestamptz;
alter table public.tasks add column if not exists assignee_viewed_at timestamptz;

-- Widen assignments_update_rls so the assigned agent (not just their team
-- lead) can write their own row's viewed_at. The app layer only ever sends
-- { viewed_at } from the agent-viewed path, matching how every other
-- "mark as viewed" write in this schema works (no column-level RLS anywhere
-- else either — e.g. am_team_lead's clients.am_team_lead_viewed_at write
-- goes through the same broad clients_update_am_assignment_rls policy).
drop policy if exists "assignments_update_rls" on public.assignments;
create policy "assignments_update_rls" on public.assignments
for update to authenticated
using (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
)
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
);

commit;
