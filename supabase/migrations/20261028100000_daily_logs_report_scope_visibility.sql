-- Widens daily_logs visibility for report generation, without touching its existing rule.
--
-- daily_logs_select_rls today is direct_report_visible(user_id) only — the author, their direct
-- manager, or executive/head_of_technical (20260908190000_narrow_personal_data_visibility.sql).
-- client_id (added later, 20260919100000_daily_logs_client_id.sql) was deliberately left out of
-- that visibility rule at the time — that migration's own comment says it's "for filtering/
-- aggregation WITHIN that existing visibility scope... explicitly NOT used to widen daily_logs
-- visibility to AM roles for other departments' clients."
--
-- This migration reverses that choice on purpose: ClientDashboard.tsx's Activity Logs tab (always
-- visible on any client's page) is meant to show every department's work log for that client, not
-- just whatever the current viewer's management hierarchy happens to let through — today a
-- media_buying_agent or am_agent viewing a client sees close to none of the logs written about it,
-- since they rarely manage the log's author. Adding report_scope_accessible(client_id, null) as a
-- second, independent OR-branch means: a log tagged to a client becomes visible to anyone already
-- eligible to generate a report for that client (the exact same role/assignment check
-- client_comparisons_insert_rls/campaigns_update_rls already use), regardless of who wrote it or
-- where they sit in the management hierarchy. The existing direct_report_visible(user_id) branch
-- is untouched — a log with no client_id (or one no report-eligible role covers) still falls back
-- to exactly the same visibility it has today.
begin;

drop policy if exists "daily_logs_select_rls" on public.daily_logs;
create policy "daily_logs_select_rls" on public.daily_logs
for select to authenticated
using (
  public.direct_report_visible(user_id)
  or (client_id is not null and public.report_scope_accessible(client_id, null))
);

commit;
