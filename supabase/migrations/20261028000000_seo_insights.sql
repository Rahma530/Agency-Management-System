-- Weekly manual-entry periodic metrics for SEO — additive alongside the existing task-derived
-- proxy (aggregateSeoMetrics' completed_tasks/on_time_rate), not a replacement. completed_tasks/
-- on_time_rate answer "did we deliver the work on time" (an operational delivery signal from
-- `tasks`); this table answers "did it produce results" (organic_traffic/keywords_top10_count/
-- backlinks_acquired) — a real performance signal this schema has never had anywhere (no
-- analytics/keyword-ranking table exists). Same pattern as media_buying_insights
-- (20261027000000_media_buying_insights.sql) and social_insights before it, applied to a third
-- service.
--
-- No platform dimension (unlike media_buying_insights/social_insights): SEO isn't multi-platform
-- the way paid media/social are, so one row per client+week is enough.
--
-- `source` is forward-compatible with a real SEO analytics/rank-tracking integration landing
-- later: a synced row lands in this same table with source = 'platform_api', additively alongside
-- manual rows, with zero schema change and zero change to the aggregation logic that pools rows
-- for a period — it already doesn't care who/what wrote a row.
begin;

create table public.seo_insights (
  id text primary key,
  client_id text not null references public.clients (id),
  week_start_date date not null,
  organic_traffic integer,
  keywords_top10_count integer,
  backlinks_acquired integer,
  source text not null default 'manual' check (source in ('manual', 'platform_api')),
  created_by text references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, week_start_date)
);

create index idx_seo_insights_client_id on public.seo_insights (client_id);

alter table public.seo_insights enable row level security;

-- Mirrors campaigns_select_rls's shape (20261018000000_align_ai_engineer_with_head_of_technical.sql),
-- substituting seo_team_lead for media_buying_team_lead: seo_team_lead is unconditional here too,
-- same tier as executive/head_of_technical/ai_engineer/am_team_lead — not scoped by
-- client_has_service, consistent with how campaigns itself is read.
create policy "seo_insights_select_rls" on public.seo_insights
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'seo_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_agent' and public.agent_assigned(client_id, 'seo'))
);

-- Insert/update RLS mirrors campaigns_update_rls's shape exactly (seo_team_lead any row, seo_agent
-- scoped to their assignment, am_agent scoped to their own client) — same three-role capability
-- tier as media_buying_insights_write_rls/update_rls, applied to SEO. No head_of_technical/
-- ai_engineer bridge grant here, unlike social_insights' original write policy: seo_team_lead/
-- seo_agent are already real, actively-used roles with no "role doesn't exist yet" gap to bridge.
create policy "seo_insights_write_rls" on public.seo_insights
for insert to authenticated
with check (
  public.app_user_role() = 'seo_team_lead'
  or (public.app_user_role() = 'seo_agent' and public.agent_assigned(client_id, 'seo'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

create policy "seo_insights_update_rls" on public.seo_insights
for update to authenticated
using (
  public.app_user_role() = 'seo_team_lead'
  or (public.app_user_role() = 'seo_agent' and public.agent_assigned(client_id, 'seo'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
)
with check (
  public.app_user_role() = 'seo_team_lead'
  or (public.app_user_role() = 'seo_agent' and public.agent_assigned(client_id, 'seo'))
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

grant select, insert, update on public.seo_insights to authenticated;

commit;
