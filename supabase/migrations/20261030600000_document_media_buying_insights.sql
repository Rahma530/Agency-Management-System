-- Documents public.media_buying_insights in this migration history for the first time.
--
-- This table was applied to the LIVE database manually, from the unmerged branch
-- claude/media-buying-periodic-entry (its own 20261027000000_media_buying_insights.sql) — that
-- branch was never merged into main, so this table, its RLS policies, and its grants existed on
-- the live database without ever being part of this repo's committed migration history. Confirmed
-- via audit: no migration on main creates public.media_buying_insights, yet
-- 20261029100000_insights_service_role_grants.sql (which IS on main) already grants service_role
-- privileges on it — that migration only works on the live database because the table was already
-- there from the manual apply; it would fail outright on a fresh database built from this
-- migration history in order, which is exactly the gap this migration closes.
--
-- Every statement below is written to be fully idempotent (if not exists / drop then create /
-- repeatable grants), so running it against the live database — which already has all of this —
-- is a safe no-op, and running it against a fresh database produces the identical end state.
--
-- Table definition, index, RLS policies, and predicates below are copied verbatim from that
-- branch's 20261027000000_media_buying_insights.sql — same 11 columns, same unique constraint,
-- same source check, same FKs, same three policies with the exact same predicates (mirroring
-- campaigns_select_rls/campaigns_update_rls, per that migration's own comments). Only the grants
-- differ: that original migration granted select/insert/update to authenticated but never granted
-- service_role at all (the gap 20261029100000_insights_service_role_grants.sql's guarded grant
-- patches); this migration states both explicitly, matching every other insights table
-- (social_insights, seo_insights) in this schema. No truncate/references/trigger/maintain grants
-- are added to either role, consistent with 20261030300000_revoke_excess_privileges.sql's
-- precedent of not handing out those unused default privileges on any table.
--
-- The frontend feature (MediaBuyingInsightRecord, LogMediaBuyingMetricsModal.tsx, App.tsx's
-- fetch/write handlers, ClientDashboard.tsx's canLogMediaBuyingMetrics gate,
-- reportingEngine.ts's aggregateMediaBuyingMetrics integration — all of it still only exists on
-- the unmerged branch) is NOT included here and is a separate task. This migration documents the
-- database object only, so the live database's actual state is captured in version control, the
-- same reasoning as every other "document the live state" migration in this history
-- (20261030300000_revoke_excess_privileges.sql, 20261030400000_drop_users_password.sql).
begin;

create table if not exists public.media_buying_insights (
  id text primary key,
  client_id text not null references public.clients (id),
  platform text not null,
  week_start_date date not null,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  roas numeric,
  source text not null default 'manual' check (source in ('manual', 'platform_api')),
  created_by text references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, platform, week_start_date)
);

create index if not exists idx_media_buying_insights_client_id on public.media_buying_insights (client_id);

alter table public.media_buying_insights enable row level security;

drop policy if exists "media_buying_insights_select_rls" on public.media_buying_insights;
create policy "media_buying_insights_select_rls" on public.media_buying_insights
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
);

drop policy if exists "media_buying_insights_write_rls" on public.media_buying_insights;
create policy "media_buying_insights_write_rls" on public.media_buying_insights
for insert to authenticated
with check (
  public.app_user_role() = 'media_buying_team_lead'
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

drop policy if exists "media_buying_insights_update_rls" on public.media_buying_insights;
create policy "media_buying_insights_update_rls" on public.media_buying_insights
for update to authenticated
using (
  public.app_user_role() = 'media_buying_team_lead'
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
)
with check (
  public.app_user_role() = 'media_buying_team_lead'
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

grant select, insert, update on public.media_buying_insights to authenticated;
grant select, insert, update, delete on public.media_buying_insights to service_role;

commit;
