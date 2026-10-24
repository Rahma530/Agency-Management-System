-- Owner-requested simplification (after several rounds of clarification): Status should depend
-- only on the SELECTED calendar month's own numbers, never on a client's start_date or on how
-- many months have passed since they joined. Real logging only began in October, so the old
-- start_date-driven "Onboarding" / "No Baseline" stages were showing for every long-standing
-- client simply because there is no monthly history before October yet — not because anything
-- was actually wrong. Owner's own words, confirmed: "خلي كل مرة يتحسب على شهر ميلادي واحد و
-- بناءا على ارقامه تظهر حالته" (every time, calculate on one calendar month, and its status comes
-- from that month's own numbers).
--
-- New status rule (replaces the 6-branch Setup Needed/Onboarding/No Data/month-0/month-1/
-- No Baseline/month-3+ state machine with a flat 4-branch one):
--   Setup Needed -> profit_margin_pct is null (start_date is no longer part of this check at all)
--   No Data      -> no sales logged for the selected month
--   Successful   -> current month profit (sales * margin - spend) >= 0
--   Below Target -> current month profit < 0
--
-- avg_3m_sales/avg_3m_spent/avg_3m_profit, required_growth_pct and profit_growth_pct are
-- UNCHANGED (still computed exactly as before, still returned, still shown in the Overview table)
-- — they just no longer feed the status decision. They will naturally start reflecting real
-- numbers once 3 real months of data exist (their CTE already averages only over months that
-- have a row, not a fixed /3), and the owner can decide later whether/how to fold growth-vs-tier
-- back into status once there is enough real history to make that meaningful.
--
-- start_date and first_full/months_since are no longer used by this function at all (start_date
-- is still returned as a plain column — the frontend still displays it — it simply no longer
-- affects status).
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
      when (coalesce(cur.sales, 0) * coalesce(c.profit_margin_pct, 0) - coalesce(cur.spend, 0)) >= 0 then 'Successful'
      else 'Below Target'
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
