-- Widens daily_logs visibility for report generation, without touching its existing rule.
--
-- daily_logs_select_rls today is direct_report_visible(user_id) only — the author, their direct
-- manager, or executive/head_of_technical (20260908190000_narrow_personal_data_visibility.sql).
-- client_id (added later, 20260919100000_daily_logs_client_id.sql) was deliberately left out of
-- that visibility rule at the time — that migration's own comment says it's "for filtering/
-- aggregation WITHIN that existing visibility scope... explicitly NOT used to widen daily_logs
-- visibility to AM roles for other departments' clients."
--
-- This migration reverses that choice, but deliberately NOT via report_scope_accessible(client_id,
-- null): that function (20261019000000_ai_engineer_full_application_authorization.sql) grants each
-- department role (media_buying_*/seo_*/social_media_*) visibility for ITS OWN report-generation
-- purposes, scoped by that department's own assignment to the client — not a general "see this
-- client's logs" grant. ClientDashboard.tsx's Activity Logs tab has no department filter of its
-- own (clientLogs filters only by client_id — see ClientDashboard.tsx's own comment there), so
-- using report_scope_accessible as this policy's second branch would have let e.g. a
-- media_buying_agent assigned to a client see that same client's SEO- and Social Media-authored
-- logs too, through that same always-visible, unfiltered tab — a cross-department exposure never
-- actually shipped (this migration was never applied), caught in audit before it went live.
--
-- The fix: the second branch lists the roles that should see every department's logs for a client
-- explicitly — executive/head_of_technical/ai_engineer (leadership, parity with how those three
-- are treated everywhere else in this schema) and the AM roles (am_team_lead unconditionally,
-- am_agent scoped to their own client via client_am_agent_is_caller) — the roles whose job is
-- actually cross-department oversight of a client's account. Department roles
-- (media_buying_*/seo_*/social_media_*) are deliberately left out of this branch and keep exactly
-- their existing direct_report_visible(user_id) visibility (their own logs, or their direct
-- reports' logs) — unchanged from today. The existing direct_report_visible(user_id) branch itself
-- is untouched — a log with no client_id, or one no AM/leadership role is tied to, still falls back
-- to exactly the same visibility it has today.
begin;

drop policy if exists "daily_logs_select_rls" on public.daily_logs;
create policy "daily_logs_select_rls" on public.daily_logs
for select to authenticated
using (
  public.direct_report_visible(user_id)
  or (client_id is not null and (
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  ))
);

commit;
