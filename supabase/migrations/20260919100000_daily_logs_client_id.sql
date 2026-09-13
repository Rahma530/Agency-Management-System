-- ============================================================================
-- Module 12, Phase 3: link daily_logs to a client.
-- ============================================================================
--
-- Single nullable client_id, matching every other work-artifact table in
-- this schema (tasks/briefs/campaigns all model "one row = one client",
-- never an array). A day's work genuinely spanning multiple clients is
-- already handled today by writing multiple daily_logs rows — nothing
-- prevents more than one log per user per day, so this doesn't need a new
-- many-to-many shape to cover that case.
--
-- RLS: deliberately UNCHANGED. daily_logs_select_rls stays
-- direct_report_visible(user_id) exactly as it is today — this column is
-- for filtering/aggregation WITHIN that existing visibility scope (a team
-- lead's own reports' logs, or, for executive/head_of_technical, everyone's).
-- It is explicitly NOT used to widen daily_logs visibility to AM roles for
-- other departments' clients — the Team Activity tab (Module 12, Phase 4)
-- was deliberately scoped to tasks_select_rls only, never raw daily-log
-- text, so no new policy is needed here.
-- ============================================================================

begin;

alter table public.daily_logs
  add column if not exists client_id text references public.clients (id);

create index if not exists idx_daily_logs_client_id on public.daily_logs (client_id);

commit;
