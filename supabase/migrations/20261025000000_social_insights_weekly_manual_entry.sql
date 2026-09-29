-- Weekly manual-entry write path for social_insights.
--
-- This SUPERSEDES the read-only decision recorded in 20260907090000_table_grants.sql ("8.
-- social_insights — read-only from the app (populated by an external platform-metrics
-- integration via the service-role key, not the browser)"). That external integration was never
-- built (confirmed: no insert/update code anywhere in the app or any Edge Function touches this
-- table), leaving social_insights permanently empty and the Social Media half of the AI
-- Orchestrator/reporting pipeline (aggregateSocialMetrics() in src/lib/reportingEngine.ts) with no
-- real data to read. This migration opens a manual, RLS-gated write path as a bridge until that
-- integration exists — a deliberate reversal of the earlier decision, not an oversight.
begin;

-- week_start_date is a new, separate column rather than repurposing the existing `date` column,
-- since `date` already means "the single day this row is for" and silently redefining it for a
-- week-anchor would make old and new rows indistinguishable. The app keeps `date` in sync with
-- `week_start_date` on every weekly write (date = week_start_date) purely so that
-- aggregateSocialMetrics()/inRange() in reportingEngine.ts keep working completely unmodified —
-- that code is not touched by this migration and doesn't need to know weekly rows exist.
alter table public.social_insights
  add column week_start_date date;

alter table public.social_insights
  add constraint social_insights_week_start_date_matches_date
  check (week_start_date is null or date = week_start_date);

-- One row per client/platform/week — lets the app upsert (onConflict) rather than insert a new
-- row every time an agent edits an already-entered week's numbers. This deliberately departs from
-- capacity_logs/daily_logs' append-only precedent: those are immutable point-in-time log entries,
-- while a weekly social metric is "current best-known numbers" feeding a live aggregation and
-- client-facing reports, where correcting a mistake via update is the right model, not superseding
-- rows. NULLs in week_start_date (pre-existing/legacy daily rows, if any ever appear) are treated
-- as distinct from each other by Postgres's default unique-constraint semantics, so this constraint
-- only actually applies to genuine weekly rows.
alter table public.social_insights
  add constraint social_insights_weekly_unique unique (client_id, platform, week_start_date);

-- NOTE (aggregation-math limitation, not fixed here): aggregateSocialMetrics() matches rows to a
-- reporting period via inRange(date, range), a plain string comparison against a single date. A
-- weekly row's entire numbers are therefore attributed wholly to whichever period contains its
-- week_start_date — a week that starts 2026-02-26 and runs into March counts 100% toward
-- February's comparison and 0% toward March's, with no proportional split. This is a real
-- granularity side effect of feeding weekly rows into logic written for daily ones; it is accepted
-- and documented (see the matching comment on aggregateSocialMetrics() in reportingEngine.ts)
-- rather than fixed, since proportional date-splitting is materially more engineering than this
-- feature's three-field weekly form warrants.

-- INSERT/UPDATE RLS: the social_media_agent actually assigned to this client, the
-- social_media_team_lead for this client, or (TEMPORARY, see below) head_of_technical/ai_engineer.
-- Mirrors social_insights_select_rls's existing role-scoping helpers (agent_assigned,
-- client_has_service) exactly, so the write gate can never be broader than the existing read gate.
create policy "social_insights_write_rls" on public.social_insights
for insert to authenticated
with check (
  (public.app_user_role() = 'social_media_agent' and public.agent_assigned(client_id, 'social_media'))
  or (public.app_user_role() = 'social_media_team_lead' and public.client_has_service(client_id, 'social_media'))
  -- TEMPORARY TRANSITION FEATURE — intended for removal once social_media_agent/
  -- social_media_team_lead users are onboarded and actively entering their own weekly numbers.
  -- Grants head_of_technical/ai_engineer write access purely so this feature can be tested
  -- end-to-end before real agents are using it. Same convention as Employee Impersonation's
  -- "TEMPORARY TRANSITION FEATURE" comments in src/App.tsx — flagged here so it reads as a
  -- bridge grant to be revoked later, not a permanent one.
  or (public.app_user_role() in ('head_of_technical', 'ai_engineer') and public.client_has_service(client_id, 'social_media'))
);

create policy "social_insights_update_rls" on public.social_insights
for update to authenticated
using (
  (public.app_user_role() = 'social_media_agent' and public.agent_assigned(client_id, 'social_media'))
  or (public.app_user_role() = 'social_media_team_lead' and public.client_has_service(client_id, 'social_media'))
  -- TEMPORARY TRANSITION FEATURE — see the insert policy above and src/App.tsx's Employee
  -- Impersonation comments for the convention this follows.
  or (public.app_user_role() in ('head_of_technical', 'ai_engineer') and public.client_has_service(client_id, 'social_media'))
)
with check (
  (public.app_user_role() = 'social_media_agent' and public.agent_assigned(client_id, 'social_media'))
  or (public.app_user_role() = 'social_media_team_lead' and public.client_has_service(client_id, 'social_media'))
  -- TEMPORARY TRANSITION FEATURE — see the insert policy above and src/App.tsx's Employee
  -- Impersonation comments for the convention this follows.
  or (public.app_user_role() in ('head_of_technical', 'ai_engineer') and public.client_has_service(client_id, 'social_media'))
);

grant insert, update on public.social_insights to authenticated;

commit;
