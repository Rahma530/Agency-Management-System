-- Widens daily_logs visibility for department Team Leads (media_buying_team_lead/seo_team_lead/
-- social_media_team_lead) to their OWN department's agents, for any client their department
-- services — without reintroducing the cross-department leak that
-- 20261028100000_daily_logs_report_scope_visibility.sql deliberately avoided.
--
-- Background: that migration gave executive/head_of_technical/ai_engineer/am_team_lead (+am_agent
-- scoped to their own clients) unrestricted visibility of a client's daily_logs, but explicitly
-- left department Team Leads out of that branch, with this reasoning in its own comment:
-- ClientDashboard.tsx's Activity Logs tab has no department filter of its own (it filters only by
-- client_id), so granting e.g. a media_buying_team_lead "see every log for this client" would
-- have also surfaced that same client's SEO- and Social Media-authored logs through that same
-- unfiltered tab — a cross-department exposure, not something department Team Leads should see.
--
-- Reported gap this migration fixes: department Team Leads were left with only
-- direct_report_visible(user_id) — their own logs, or their direct reports' logs under the
-- employee record's explicit "reports to" field. A department Team Lead could not see an
-- auto-generated (source='auto_task') daily_log for an agent who is genuinely working that
-- department's clients, but who the org chart does not record as that Team Lead's direct report
-- (e.g. a cross-team collaborator, or a missing/incorrect "reports to" value) — even though the
-- underlying task-completion trigger (auto_daily_log_from_delivered_task) itself fires for every
-- role identically, with no exclusion.
--
-- Fix: add one branch per department, scoped by BOTH (a) the client actually subscribing to that
-- department's service (client_has_service) and (b) the log's AUTHOR holding one of that
-- department's own roles (agent or team lead) — never just "any log for this client" like the
-- am_team_lead branch. This mirrors, on the SQL side, the exact role roster
-- TEAM_LEAD_TO_AGENT_ROLE (src/data/roles.ts) already defines client-side for each department
-- Team Lead, so a seo_team_lead viewer only ever gains visibility into SEO-authored logs — never
-- a media_buying- or social_media-authored log for the very same client — closing the original
-- gap without reopening the cross-department exposure the prior migration avoided.
--
-- The existing direct_report_visible(user_id) branch, and the unconditional executive/
-- head_of_technical/ai_engineer/am_team_lead/am_agent branch, are both untouched.
begin;

drop policy if exists "daily_logs_select_rls" on public.daily_logs;
create policy "daily_logs_select_rls" on public.daily_logs
for select to authenticated
using (
  public.direct_report_visible(user_id)
  or (client_id is not null and (
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (
      public.app_user_role() = 'media_buying_team_lead'
      and public.client_has_service(client_id, 'media_buying')
      and exists (
        select 1 from public.users u
        where u.id = daily_logs.user_id and u.role in ('media_buying_agent', 'media_buying_team_lead')
      )
    )
    or (
      public.app_user_role() = 'seo_team_lead'
      and public.client_has_service(client_id, 'seo')
      and exists (
        select 1 from public.users u
        where u.id = daily_logs.user_id
          and u.role in ('seo_agent', 'store_manager', 'seo_content_agent', 'seo_backlink_agent', 'seo_team_lead')
      )
    )
    or (
      public.app_user_role() = 'social_media_team_lead'
      and public.client_has_service(client_id, 'social_media')
      and exists (
        select 1 from public.users u
        where u.id = daily_logs.user_id and u.role in ('social_media_agent', 'social_media_team_lead')
      )
    )
  ))
);

commit;
