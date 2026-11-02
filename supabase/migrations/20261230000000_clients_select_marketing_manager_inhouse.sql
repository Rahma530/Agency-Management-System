-- Fixes a real bug the owner just reported: Inhouse tasks visible to Executive/Head of Technical
-- in the Inhouse tab were NOT showing for marketing_manager, even after
-- 20261228000000_task_visibility_inhouse_restriction.sql (which widened task_visible_v2 to let
-- marketing_manager see any is_inhouse task unconditionally).
--
-- Root cause: task_visible_v2 is only half the story for the Inhouse tab. App.tsx's own
-- isInhouseTask() decides whether a task belongs in the tab by checking
-- `clients.find(c => c.id === task.client_id)?.is_inhouse` against the frontend's already-loaded
-- `clients` array — and that array is itself RLS-scoped by clients_select_rls, a COMPLETELY
-- separate policy from task_visible_v2 that was never touched by that earlier migration.
-- clients_select_rls (20261124000000_ai_engineer_deprivilege.sql) has no explicit branch for
-- marketing_manager, so it fell into the generic `else` case: a client row is visible only if the
-- caller personally has an assigned task for it (task_assignees). marketing_manager essentially
-- never personally assigns themselves to a task, so in practice they could see ZERO client rows
-- at all — meaning `clients.find(...)` always returned undefined for them, is_inhouse always read
-- as false, and isInhouseTask() filtered every single Inhouse task out of their `inhouseTasks`
-- array before it ever reached CrossTeamTaskBoard — regardless of what task_visible_v2 allowed.
--
-- Fix: clients_select_rls (CREATE OR REPLACE'd verbatim except for one addition) gets an explicit
-- `when 'marketing_manager'` branch: `is_inhouse OR <the same else-branch fallback every other
-- unlisted role already gets>` — so marketing_manager can now see Kesraa/Fast Growth's client rows
-- (and only those among clients they don't otherwise have the generic fallback access to), closing
-- the gap without widening their access to any other, non-inhouse client.
begin;

drop policy if exists "clients_select_rls" on public.clients;
create policy "clients_select_rls"
on public.clients
for select
to authenticated
using (
  case public.app_user_role()
    when 'sales' then sales_owner_id = public.app_user_id()
    when 'executive' then true
    when 'head_of_technical' then true
    when 'am_team_lead' then true
    when 'am_agent' then am_agent_id = public.app_user_id()
    when 'media_buying_team_lead' then true
    when 'media_buying_agent' then public.agent_assigned(id, 'media_buying')
    when 'seo_team_lead' then true
    when 'social_media_team_lead' then true
    when 'seo_agent' then (
      public.agent_assigned(id, 'seo')
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
      )
    )
    when 'social_media_agent' then (
      public.agent_assigned(id, 'social_media')
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
      )
    )
    when 'marketing_manager' then (
      is_inhouse
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
      )
    )
    else exists (
      select 1
      from public.tasks t
      where t.client_id = clients.id
        and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
    )
  end
);

commit;
