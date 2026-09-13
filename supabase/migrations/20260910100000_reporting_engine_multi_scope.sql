-- ============================================================================
-- Reporting Engine: expand from AM-only, single-client reports/comparisons to
-- every team lead and agent role, with two new scopes — "all of my clients
-- pooled together" and "a specific direct report's clients pooled together"
-- — alongside the original single-client case.
-- ============================================================================
--
-- SCHEMA CHANGES
-- --------------
-- client_comparisons gains:
--   - agent_id (nullable, references users) — set instead of client_id for a
--     pooled/aggregate row. Exactly one of client_id / agent_id is ever set,
--     enforced by client_comparisons_scope_check below. agent_id is always
--     the id of whichever agent's resolved client set got pooled: either
--     that agent generating their own "all my clients" report, or their
--     team lead generating one for them specifically (see
--     resolveClientsForSubject() in src/lib/reportingEngine.ts).
--   - covered_client_ids (nullable text[]) — which clients actually got
--     pooled at generation time, for audit/drill-down display only. RLS
--     cannot re-verify this against current assignments (they may have
--     changed since generation), so it is NOT part of the access-control
--     model below — purely informational.
--   - client_id becomes nullable to allow the agent-scoped case.
--
-- reports.client_id becomes nullable too (an aggregate report has no single
-- client), but reports gets no new columns: a report's actual scope always
-- lives on the client_comparisons row it points to via comparison_id, which
-- stays the single source of truth. comparison_id itself remains an
-- ordinary nullable column at the DB level, but every insert under the new
-- policy below must supply one — the app never generates a report without
-- backing analytical content.
--
-- The original unique(client_id, period_current, period_previous)
-- constraint from 20260909100000 is left untouched: it still correctly
-- enforces one row per client per period pair, since every row it applies
-- to still has a non-null client_id. It just doesn't reach the new
-- agent-scoped rows (all of which have client_id = NULL, and Postgres
-- treats every NULL as distinct under a plain unique constraint) — hence
-- the separate partial unique index below for that case.
--
-- RLS CHANGES
-- -----------
-- Both tables' insert/update/select policies from 20260909100000 only ever
-- recognized executive, head_of_technical, am_team_lead, and am_agent (for
-- their own client). The other six roles (media_buying/seo/social_media x
-- team_lead/agent) could not write — or read anything but their own
-- generated_by rows on reports — regardless of any UI wiring. This migration
-- replaces those policies with two new SECURITY DEFINER helpers used by
-- both select and insert/update alike (this app's existing convention: see
-- reports_select_rls's original design, where read and write were already
-- symmetric for the AM-only case):
--
--   public.report_scope_accessible(p_client_id, p_agent_id) — the full
--   8-role dispatch for a client_comparisons row's scope: team leads via
--   client_has_service(), agents via agent_assigned() (both already used
--   elsewhere in this schema), AM via the existing am_agent/am_team_lead
--   rules, and the new agent-scoped case via direct_report_visible()
--   (already used by kpi_scores/performance_reviews for exactly this
--   "self, or my direct report" shape) — which also naturally covers an
--   agent generating their own aggregate, since direct_report_visible()
--   already treats target = caller as visible.
--
--   public.comparison_scope_accessible(p_comparison_id) — joins into
--   client_comparisons and applies the helper above, for reports (which
--   carries no client_id/agent_id of its own worth trusting for RLS — see
--   schema notes above).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Schema
-- ----------------------------------------------------------------------------
alter table public.client_comparisons
  add column if not exists agent_id text references public.users (id),
  add column if not exists covered_client_ids text[];

alter table public.client_comparisons alter column client_id drop not null;
alter table public.reports alter column client_id drop not null;

alter table public.client_comparisons
  add constraint client_comparisons_scope_check
  check (
    (client_id is not null and agent_id is null)
    or (client_id is null and agent_id is not null)
  );

create unique index if not exists client_comparisons_agent_period_unique
  on public.client_comparisons (agent_id, period_current, period_previous)
  where agent_id is not null;

create index if not exists idx_client_comparisons_agent_id on public.client_comparisons (agent_id);

-- ----------------------------------------------------------------------------
-- 2. Helper functions
-- ----------------------------------------------------------------------------
create or replace function public.report_scope_accessible(p_client_id text, p_agent_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    case
      when p_client_id is not null then (
        public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
        or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(p_client_id))
        or (public.app_user_role() = 'media_buying_team_lead' and public.client_has_service(p_client_id, 'media_buying'))
        or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(p_client_id, 'media_buying'))
        or (public.app_user_role() = 'seo_team_lead' and public.client_has_service(p_client_id, 'seo'))
        or (public.app_user_role() = 'seo_agent' and public.agent_assigned(p_client_id, 'seo'))
        or (public.app_user_role() = 'social_media_team_lead' and public.client_has_service(p_client_id, 'social_media'))
        or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(p_client_id, 'social_media'))
      )
      when p_agent_id is not null then public.direct_report_visible(p_agent_id)
      else false
    end;
$$;

create or replace function public.comparison_scope_accessible(p_comparison_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.report_scope_accessible(cc.client_id, cc.agent_id)
  from public.client_comparisons cc
  where cc.id = p_comparison_id;
$$;

-- ----------------------------------------------------------------------------
-- 3. client_comparisons policies (replaces all three from 20260909100000)
-- ----------------------------------------------------------------------------
drop policy if exists "client_comparisons_select_rls" on public.client_comparisons;
create policy "client_comparisons_select_rls" on public.client_comparisons
for select
to authenticated
using (public.report_scope_accessible(client_id, agent_id));

drop policy if exists "client_comparisons_insert_rls" on public.client_comparisons;
create policy "client_comparisons_insert_rls" on public.client_comparisons
for insert
to authenticated
with check (public.report_scope_accessible(client_id, agent_id));

drop policy if exists "client_comparisons_update_rls" on public.client_comparisons;
create policy "client_comparisons_update_rls" on public.client_comparisons
for update
to authenticated
using (public.report_scope_accessible(client_id, agent_id))
with check (public.report_scope_accessible(client_id, agent_id));

-- ----------------------------------------------------------------------------
-- 4. reports policies (replaces select from 20260906120000, insert from
--    20260909100000)
-- ----------------------------------------------------------------------------
drop policy if exists "reports_select_rls" on public.reports;
create policy "reports_select_rls" on public.reports
for select
to authenticated
using (
  generated_by = public.app_user_id()
  or (comparison_id is not null and public.comparison_scope_accessible(comparison_id))
);

drop policy if exists "reports_insert_rls" on public.reports;
create policy "reports_insert_rls" on public.reports
for insert
to authenticated
with check (
  generated_by = public.app_user_id()
  and type = 'internal'
  and comparison_id is not null
  and public.comparison_scope_accessible(comparison_id)
);

commit;
