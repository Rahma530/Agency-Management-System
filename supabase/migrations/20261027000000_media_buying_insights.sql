-- Weekly manual-entry periodic metrics for media buying — the fact-table counterpart `campaigns`
-- cannot provide. campaigns.spend/results.{conversions,roas} are cumulative for a campaign's
-- whole run (see reportingEngine.ts's aggregateMediaBuyingMetrics comment), so "in period X"
-- today only ever means "was running during period X", reusing the same lifetime total for every
-- period a long-running campaign overlaps. This table gives each week its own real numbers,
-- exactly the problem social_insights' week_start_date already solved for social media
-- (20261025000000_social_insights_weekly_manual_entry.sql) — same pattern, same reasoning,
-- applied to a different service.
--
-- Deliberately a NEW table, not a column added to campaigns: campaigns is an entity record (one
-- row per actual ad campaign, its settings + lifetime totals), this is a period fact (one row per
-- client+platform+week) — different shape, different purpose, not a duplicate.
--
-- `source` is forward-compatible with real ad-platform integration (Meta/Google/TikTok) landing
-- later: a synced row lands in this same table with source = 'platform_api', additively alongside
-- manual rows, with zero schema change and zero change to the aggregation logic that pools rows
-- for a period — it already doesn't care who/what wrote a row.
begin;

create table public.media_buying_insights (
  id text primary key,
  client_id text not null references public.clients (id),
  platform text not null, -- open union, same convention as campaigns.platform (meta/google/tiktok/...)
  week_start_date date not null,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  roas numeric, -- nullable: not always known, same reasoning as aggregateMediaBuyingMetrics's existing roas handling
  source text not null default 'manual' check (source in ('manual', 'platform_api')),
  created_by text references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, platform, week_start_date)
);

create index idx_media_buying_insights_client_id on public.media_buying_insights (client_id);

alter table public.media_buying_insights enable row level security;

-- Mirrors campaigns_select_rls exactly (20261018000000_align_ai_engineer_with_head_of_technical.sql):
-- media_buying_team_lead is unconditional here too, same tier as executive/head_of_technical/
-- ai_engineer/am_team_lead — not scoped by client_has_service, consistent with how campaigns
-- itself is read.
create policy "media_buying_insights_select_rls" on public.media_buying_insights
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
);

-- Insert/update RLS mirrors campaigns_update_rls exactly (media_buying_team_lead any row,
-- media_buying_agent scoped to their assignment, am_agent scoped to their own client) — the same
-- three roles that can already edit campaigns.spend/results for this client, now also able to log
-- a real weekly number instead. No head_of_technical/ai_engineer bridge grant here, unlike
-- social_insights' original write policy: media_buying_team_lead/media_buying_agent are already
-- real, actively-used roles (campaigns CRUD shipped this morning), so there's no "role doesn't
-- exist yet" gap to bridge.
create policy "media_buying_insights_write_rls" on public.media_buying_insights
for insert to authenticated
with check (
  public.app_user_role() = 'media_buying_team_lead'
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

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

commit;
