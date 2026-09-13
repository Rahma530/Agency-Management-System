-- ============================================================================
-- Module 12, Phase 4: widen task_visible() so am_agent can see every
-- department's tasks for a client they're assigned to (needed for the new
-- "Team Activity" tab on ClientDashboard.tsx).
-- ============================================================================
--
-- Today task_visible(assigned_to, parent_task_id) gives am_team_lead (and
-- executive/head_of_technical) full org-wide task visibility, but am_agent
-- falls into the generic "own team only" branch — so an am_agent can see
-- other am_agents' tasks, but never a seo_agent/media_buying_agent/
-- graphic_designer task for a client they personally own. That's a real gap
-- against the Team Activity tab's requirement ("consolidated view of ALL
-- work by ANY department/agent for a client"), not a cosmetic one.
--
-- This is a narrow, targeted widening: am_agent gains visibility only into
-- tasks belonging to clients where they are the assigned am_agent
-- (client_am_agent_is_caller, the same helper already used for
-- reports/comparisons/campaign view access). It does not touch daily_logs —
-- per the confirmed Phase 4 decision, the Team Activity tab surfaces task
-- status only, never raw daily-log text, so daily_logs RLS is untouched.
-- ============================================================================

begin;

create or replace function public.task_visible(
  p_assigned_to text,
  p_parent_task_id text default null,
  p_client_id text default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.app_user_role() <> 'sales'
    and (
      public.app_user_role() in (
        'executive', 'head_of_technical',
        'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
      )
      or (
        public.app_user_role() in ('graphic_designer', 'video_editor')
        and p_assigned_to = public.app_user_id()
      )
      or (
        public.app_user_role() not in ('graphic_designer', 'video_editor')
        and (
          p_assigned_to = public.app_user_id()
          or exists (
            select 1 from public.users u
            where u.id = p_assigned_to and u.team = public.app_user_team()
          )
        )
      )
      or (
        public.app_user_role() = 'am_agent'
        and p_client_id is not null
        and public.client_am_agent_is_caller(p_client_id)
      )
      or (
        p_parent_task_id is not null
        and exists (
          select 1 from public.tasks pt
          where pt.id = p_parent_task_id
            and public.task_visible(pt.assigned_to, pt.parent_task_id, pt.client_id)
        )
      )
    );
$$;

drop policy if exists "tasks_select_rls" on public.tasks;
create policy "tasks_select_rls" on public.tasks
for select to authenticated
using (public.task_visible(assigned_to, parent_task_id, client_id));

commit;
