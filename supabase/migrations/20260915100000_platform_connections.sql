-- ============================================================================
-- Module 6 (External Integrations Hub) — scaffolding only.
-- ============================================================================
--
-- This app has no real OAuth client, no third-party API keys, and no job
-- runner. What this migration builds is deliberately limited to what is
-- honestly useful without any of that:
--
-- 1. public.platform_connections — a MANUAL status tracker per (client,
--    platform). Staff record the real-world state of getting API access
--    from a client ("asked them for Meta Business Manager access" ->
--    pending -> connected once granted). This is not a fake OAuth flow and
--    never claims a live data connection exists — the app's own UI is
--    responsible for keeping the actual "Connect" action disabled and
--    labeled "Coming soon" regardless of what this table says.
--
--    There is deliberately NO credential/token/secret column here. Even an
--    empty placeholder column would misrepresent this table as a place
--    secrets belong. When real OAuth exists, tokens must live in a
--    service-role-only store (e.g. Supabase Vault, or a table with no grant
--    to `authenticated` at all) that only a future Edge Function can read —
--    never a column the browser-authenticated client can select.
--
-- 2. public.analytics_insights — a new, empty destination table for
--    performance/analytics/traffic data (Google Analytics / GA4, Search
--    Console, etc.), mirroring public.social_insights exactly. Nothing
--    writes to it yet; it exists so the data model for all three
--    integration categories (media buying -> campaigns, social ->
--    social_insights, analytics/traffic -> analytics_insights) is complete
--    ahead of any real pull. Read-only from the app, same as
--    campaigns/social_insights — a future integration would populate it via
--    the service role, never via this grant.
--
-- Deliberately NOT built here (documented for later instead of stubbed):
-- a daily-pull job needs a Supabase Edge Function (one per platform
-- category, or one dispatcher) plus a pg_cron schedule
-- (`select cron.schedule('daily-platform-pull', '0 2 * * *', $$ ... $$)`)
-- invoking it once every 24h, writing into campaigns/social_insights/
-- analytics_insights and stamping platform_connections.last_synced_at. An
-- empty function with nothing real to call would just be untested dead
-- code today, so it's left as a fast-follow once real API credentials
-- exist, not scaffolded here.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. platform_connections
-- ----------------------------------------------------------------------------
create table if not exists public.platform_connections (
  id text primary key,
  client_id text not null references public.clients (id),
  platform_category text not null check (platform_category in ('media_buying', 'analytics', 'social_media')),
  platform_name text not null,
  status text not null default 'not_connected' check (status in ('not_connected', 'pending', 'connected')),
  connected_by text references public.users (id),
  connected_at timestamptz,
  last_synced_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, platform_name)
);

grant select, insert, update on public.platform_connections to authenticated;

alter table public.platform_connections enable row level security;

-- Same audience as the Reports/Meetings tabs on ClientDashboard.tsx
-- (hasReportsAccess): Executive, Head of Technical, AM Team Lead, or the
-- client's own assigned AM Agent. Integration/credential logistics with a
-- client are treated as an Account Management relationship concern, not a
-- per-service-team one.
create policy "platform_connections_select_rls" on public.platform_connections
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

create policy "platform_connections_insert_rls" on public.platform_connections
for insert
to authenticated
with check (
  (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  )
  and (connected_by is null or connected_by = public.app_user_id())
);

create policy "platform_connections_update_rls" on public.platform_connections
for update
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
)
with check (
  (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  )
  and (connected_by is null or connected_by = public.app_user_id())
);

create index if not exists idx_platform_connections_client_id on public.platform_connections (client_id);

-- ----------------------------------------------------------------------------
-- 2. analytics_insights
-- ----------------------------------------------------------------------------
create table if not exists public.analytics_insights (
  id text primary key,
  client_id text not null references public.clients (id),
  platform text not null,
  metrics jsonb not null default '{}'::jsonb,
  date date not null
);

grant select on public.analytics_insights to authenticated;

alter table public.analytics_insights enable row level security;

-- Mirrors social_insights_select_rls, swapping the social-media team for
-- the SEO team: organic traffic/analytics is SEO-adjacent data, the same
-- way social engagement is social-media-adjacent data.
create policy "analytics_insights_select_rls" on public.analytics_insights
for select
to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'seo_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_agent' and public.agent_assigned(client_id, 'seo'))
);

create index if not exists idx_analytics_insights_client_id on public.analytics_insights (client_id);

commit;
