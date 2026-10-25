-- Owner-requested flip, after reviewing real numbers in production: "مش عايزة اسجل صرف و ربح
-- المنصات (Meta + Snapchat + Google ADS + Tiktok) لا هكتفي اني اعمل عليهم checkbox على اساس ان دي
-- المنصات اللي انا شغالة عليها بس و هسجل الصرف و العائد ل سلة و زد بس و ده اللي هحسب كل حاجة على
-- اساسه" — the 4 ad platforms (TikTok/Meta/Snapchat/Google) are no longer a place real Sales/Spend
-- numbers get logged at all; they're now a pure active/inactive marker (see the frontend's
-- AD_PLATFORMS split, same migration/PR). Salla and Zid (the client's store platform) are now the
-- ONLY source of real numbers, and what the Mentorship Tracker calculates everything from — this
-- is the exact opposite filter of 20261213000000_mentorship_growth_status_ad_platforms.sql, which
-- had gone the other way (ad platforms only, excluding Salla/Zid).
--
-- Only the `monthly` CTE's platform filter changes (ad platforms -> store platforms). Status logic
-- itself (Setup Needed / No Data / no-baseline fallback / growth-vs-tier) is untouched from
-- 20261213000000 — it already worked purely off whatever current_profit/avg_3m_profit the
-- aggregation produces, with no platform-specific logic of its own.
begin;

create or replace function public.get_mentorship_snapshot(p_reporting_month date)
returns table (
  media_buyer_id text,
  media_buyer_name text,
  client_id text,
  client_name text,
  start_date date,
  profit_margin_pct numeric,
  avg_3m_sales numeric,
  avg_3m_spent numeric,
  avg_3m_roas numeric,
  avg_3m_profit numeric,
  current_sales numeric,
  current_spent numeric,
  current_roas numeric,
  current_profit numeric,
  required_growth_pct numeric,
  profit_growth_pct numeric,
  status text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_reporting_month <> date_trunc('month', p_reporting_month)::date then
    raise exception 'p_reporting_month must be the first day of a month.';
  end if;

  return query
  with monthly as (
    select
      mbi.client_id,
      date_trunc('month', mbi.week_start_date)::date as month,
      sum(mbi.sales_value) as sales,
      sum(mbi.spend) as spend
    from public.media_buying_insights mbi
    where mbi.platform in ('salla', 'zid')
    group by mbi.client_id, date_trunc('month', mbi.week_start_date)
  ),
  visible_buyers as (
    select u.id as v_media_buyer_id, u.name as v_media_buyer_name
    from public.users u
    where u.role = 'media_buying_agent'
      and (
        u.id = public.app_user_id()
        or exists (
          select 1 from public.mentorship_oversight mo
          where mo.media_buyer_id = u.id and mo.overseer_id = public.app_user_id()
        )
      )
  ),
  buyer_clients as (
    select distinct vb.v_media_buyer_id, vb.v_media_buyer_name, a.client_id as v_client_id
    from visible_buyers vb
    join public.assignments a on a.agent_id = vb.v_media_buyer_id and a.service_type = 'media_buying'
  )
  select
    bc.v_media_buyer_id,
    bc.v_media_buyer_name,
    c.id,
    c.name,
    c.start_date,
    c.profit_margin_pct,
    avg3.avg_sales,
    avg3.avg_spend,
    case when coalesce(avg3.avg_spend, 0) > 0 then avg3.avg_sales / avg3.avg_spend else 0 end,
    (coalesce(avg3.avg_sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(avg3.avg_spend, 0)),
    cur.sales,
    cur.spend,
    case when coalesce(cur.spend, 0) > 0 then cur.sales / cur.spend else 0 end,
    (coalesce(cur.sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(cur.spend, 0)),
    tier.required_growth_pct,
    case
      when coalesce(avg3.avg_sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(avg3.avg_spend, 0) <= 0 then null
      else (coalesce(cur.sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(cur.spend, 0))
           / (avg3.avg_sales * c.profit_margin_pct - avg3.avg_spend) - 1
    end,
    case
      when c.profit_margin_pct is null then 'Setup Needed'
      when cur.sales is null then 'No Data'
      when (avg3.avg_sales * coalesce(c.profit_margin_pct, 0) - avg3.avg_spend) is null
        or (avg3.avg_sales * coalesce(c.profit_margin_pct, 0) - avg3.avg_spend) <= 0
        or tier.required_growth_pct is null then
        case when (coalesce(cur.sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(cur.spend, 0)) >= 0
          then 'Successful' else 'Below Target' end
      else
        case when (coalesce(cur.sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(cur.spend, 0))
          >= (avg3.avg_sales * c.profit_margin_pct - avg3.avg_spend) * (1 + tier.required_growth_pct)
          then 'Successful' else 'Below Target' end
    end
  from buyer_clients bc
  join public.clients c on c.id = bc.v_client_id
  left join lateral (
    select avg(m.sales) as avg_sales, avg(m.spend) as avg_spend
    from monthly m
    where m.client_id = c.id
      and m.month >= (p_reporting_month - interval '3 months')::date
      and m.month < p_reporting_month
  ) avg3 on true
  left join monthly cur on cur.client_id = c.id and cur.month = p_reporting_month
  left join lateral (
    select t.required_growth_pct
    from public.mentorship_growth_tiers t
    where t.active
      and coalesce(avg3.avg_spend, 0) >= t.min_spend
      and (t.max_spend is null or coalesce(avg3.avg_spend, 0) <= t.max_spend)
    order by t.min_spend
    limit 1
  ) tier on true;
end;
$$;

revoke all on function public.get_mentorship_snapshot(date) from public, anon;
grant execute on function public.get_mentorship_snapshot(date) to authenticated, service_role;

commit;
