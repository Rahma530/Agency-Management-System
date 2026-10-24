-- Media Buyers Mentorship Tracker — step 4: the calculation itself.
--
-- get_mentorship_snapshot(p_reporting_month) reproduces, row for row, the logic of the
-- "Ibrahim"/"Ahmed Nabil" sheets in the source tracker (Kesraa Media Buyers Mentorship Tracker),
-- against this schema's REAL tables rather than a copy of the data:
--   - "Monthly History" (one row per client per month) does not exist as its own table here;
--     public.media_buying_insights is WEEKLY, so a `monthly` CTE below sums weeks into calendar
--     months first (date_trunc('month', week_start_date)), matching owner-confirmed decision to
--     extend media_buying_insights (20261204000000) rather than build a parallel monthly table.
--   - "Client Name" / "Start Date" = public.clients.name / .start_date (already existed; not
--     duplicated).
--   - which clients belong to which media buyer = public.assignments
--     (service_type = 'media_buying'), already existed; not duplicated.
--   - "Profit Margin %" = public.clients.profit_margin_pct (added in 20261204000000).
--   - "Required Growth" tiers = public.mentorship_growth_tiers (added in 20261204000000).
--   - who may call this for which media buyer = public.mentorship_oversight (added in
--     20261205000000): the function only ever returns a media buyer's own clients to (a) that
--     media buyer, or (b) a caller who currently appears as their overseer. No role gets a
--     blanket "see everyone" bypass here — Executive/HOT/Media Buying Team Leader only see a
--     media buyer once they've explicitly added themselves as that media buyer's overseer,
--     exactly as owner-confirmed ("كل واحد فيهم هيتابع ... حسب الاتفاق بينهم"). If a blanket
--     "admins always see every media buyer" override is wanted later, that is a one-line
--     additive change to visible_buyers below — flagging it here rather than assuming it.
--
-- Column-by-column mapping to the source sheet's formulas (H:R), kept in the same order so the
-- two can be diffed by eye:
--   avg_3m_sales/avg_3m_spent (H/I) = AVG() of the monthly-aggregated sales/spend over the 3
--     calendar months strictly before p_reporting_month, counting only months that actually have
--     a row (matches the sheet's SUMIFS(...)/COUNTIFS(...) pattern, not a fixed "/3").
--   avg_3m_roas (J) = avg_3m_sales / avg_3m_spent, 0 if avg_3m_spent is 0 (sheet's IFERROR(...,0)).
--   avg_3m_profit (K) = avg_3m_sales * profit_margin_pct - avg_3m_spent.
--   current_sales/current_spent (L/M) = the single monthly bucket equal to p_reporting_month.
--   current_roas (N), current_profit (O) = same shape as the Avg 3M pair.
--   required_growth_pct (P) = tier lookup keyed on avg_3m_spent (NOT current_spent — matches the
--     sheet's P11, which reads I11).
--   profit_growth_pct (Q) = current_profit / avg_3m_profit - 1, null when avg_3m_profit <= 0
--     (sheet leaves Q blank in that case; status still gets decided below without it).
--   status (R) = the same 6-branch state machine as the sheet's R11: Setup Needed / Onboarding /
--     No Data / (1st full month: break-even only) / (2nd full month: any positive profit) /
--     (3rd+ month: No Baseline, or profit>0 at-or-above required growth, else Below Target).
--
-- Totals/Success Rate (the sheet's row 5) are intentionally NOT duplicated in SQL — the frontend
-- derives them from the rows this function returns (sum current_sales/current_spent, overall ROAS
-- = their ratio, success_rate = count(status='Successful') / count(status in ('Successful',
-- 'Below Target'))), so there is exactly one place that logic lives.
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
  -- p_reporting_month must be the first day of a month, same discipline the sheet's own
  -- instructions require ("Dates must be first day of month").
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
      when c.start_date is null or c.profit_margin_pct is null then 'Setup Needed'
      when p_reporting_month < first_full.month then 'Onboarding'
      when cur.sales is null then 'No Data'
      when months_since.n = 0 then
        case when (coalesce(cur.sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(cur.spend, 0)) >= 0
          then 'Successful' else 'Below Target' end
      when months_since.n = 1 then
        case when (coalesce(cur.sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(cur.spend, 0)) > 0
          then 'Successful' else 'Below Target' end
      when avg3.avg_sales is null then 'No Baseline'
      when (avg3.avg_sales * coalesce(c.profit_margin_pct, 0) - avg3.avg_spend) <= 0 then
        case when (coalesce(cur.sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(cur.spend, 0)) > 0
          then 'Successful' else 'Below Target' end
      else
        case when (coalesce(cur.sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(cur.spend, 0)) > 0
          and (
            (coalesce(cur.sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(cur.spend, 0))
            / (avg3.avg_sales * c.profit_margin_pct - avg3.avg_spend) - 1
          ) >= coalesce(tier.required_growth_pct, 1e9)
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
  ) tier on true
  left join lateral (
    select case
      when extract(day from c.start_date) = 1 then c.start_date
      else (date_trunc('month', c.start_date) + interval '1 month')::date
    end as month
  ) first_full on true
  left join lateral (
    select
      (extract(year from p_reporting_month) - extract(year from first_full.month)) * 12
      + (extract(month from p_reporting_month) - extract(month from first_full.month)) as n
  ) months_since on true;
end;
$$;

revoke all on function public.get_mentorship_snapshot(date) from public, anon;
grant execute on function public.get_mentorship_snapshot(date) to authenticated, service_role;

commit;
