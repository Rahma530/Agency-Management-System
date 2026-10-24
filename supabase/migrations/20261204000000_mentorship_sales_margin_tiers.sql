-- Media Buyers Mentorship Tracker — step 2 of the migration plan (step 1 was
-- 20261203000000_platforms_add_meta_google.sql).
--
-- Decision (owner-confirmed): extend the existing public.media_buying_insights table
-- (documented in 20261030600000_document_media_buying_insights.sql) rather than create a parallel
-- table. That table already carries client_id, platform, week_start_date and spend with the right
-- RLS (media_buying_agent / media_buying_team_lead / am_agent / admins) — it only lacks a revenue
-- figure. Monthly mentorship figures are produced by summing weeks within a calendar month at
-- query time (date_trunc('month', week_start_date)); no new weekly-vs-monthly table is needed.
--
-- public.clients already has start_date (new-client onboarding date) and public.assignments
-- already maps client -> media buyer (service_type = 'media_buying'), so neither is duplicated
-- here. The only genuinely new pieces of state are: (1) a profit-margin percentage per client,
-- which exists nowhere in the schema, and (2) the sales-value figure itself, and (3) the
-- spend-tier -> required-growth lookup from the tracker's Settings sheet.
--
-- All three changes are additive (new nullable/defaulted columns, new table) and do not touch any
-- existing RLS policy, grant, or application code path.
begin;

-- ----------------------------------------------------------------------------
-- 1. clients.profit_margin_pct — optional, never required to save a client record (same posture
--    as every other optional client field per this project's own convention).
-- ----------------------------------------------------------------------------
alter table public.clients
  add column if not exists profit_margin_pct numeric;

comment on column public.clients.profit_margin_pct is
  'Media Buying Mentorship: profit margin % used to turn Sales into Profit (Sales * margin - Spend). Optional; null until set.';

-- ----------------------------------------------------------------------------
-- 2. media_buying_insights.sales_value — revenue figure alongside the existing spend/conversions.
-- ----------------------------------------------------------------------------
alter table public.media_buying_insights
  add column if not exists sales_value numeric not null default 0;

comment on column public.media_buying_insights.sales_value is
  'Media Buying Mentorship: sales/revenue figure for this client+platform+week, used for profit and growth calculations.';

-- ----------------------------------------------------------------------------
-- 3. public.mentorship_growth_tiers — spend-tier -> required profit-growth % lookup.
--    Admin-managed (executive/head_of_technical/ai_engineer), same posture as public.platforms:
--    no delete policy, rows are edited in place or deactivated, never removed, so a tier already
--    referenced by a past calculation always resolves consistently.
-- ----------------------------------------------------------------------------
create table if not exists public.mentorship_growth_tiers (
  id serial primary key,
  min_spend numeric not null,
  max_spend numeric,              -- null = no upper bound (the "100000+" tier)
  required_growth_pct numeric not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mentorship_growth_tiers enable row level security;

create policy "mentorship_growth_tiers_select_rls" on public.mentorship_growth_tiers
for select to authenticated
using (public.app_user_role() <> 'sales');

create policy "mentorship_growth_tiers_write_rls" on public.mentorship_growth_tiers
for insert to authenticated
with check (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer'));

create policy "mentorship_growth_tiers_update_rls" on public.mentorship_growth_tiers
for update to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer'))
with check (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer'));

grant select, insert, update on public.mentorship_growth_tiers to authenticated;
grant all on public.mentorship_growth_tiers to service_role;

-- Seed from the tracker's current Settings sheet.
insert into public.mentorship_growth_tiers (min_spend, max_spend, required_growth_pct)
select 0, 9999.99, 0.30
where not exists (select 1 from public.mentorship_growth_tiers);

insert into public.mentorship_growth_tiers (min_spend, max_spend, required_growth_pct)
select 10000, 49999.99, 0.20
where (select count(*) from public.mentorship_growth_tiers) = 1;

insert into public.mentorship_growth_tiers (min_spend, max_spend, required_growth_pct)
select 50000, 99999.99, 0.15
where (select count(*) from public.mentorship_growth_tiers) = 2;

insert into public.mentorship_growth_tiers (min_spend, max_spend, required_growth_pct)
select 100000, null, 0.10
where (select count(*) from public.mentorship_growth_tiers) = 3;

commit;
