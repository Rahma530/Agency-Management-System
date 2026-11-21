-- Same audit, client-management and scheduling/mentorship RPC functions: update_client_details,
-- update_client_dates, get_user_schedule_load, get_mentorship_snapshot. Same fix, same method:
-- cache each repeated identity value once in a local variable, replace every other direct call
-- with it. No logic change. Same signatures, so existing grants are untouched by CREATE OR REPLACE
-- FUNCTION.
begin;

create or replace function public.update_client_details(p_client_id text, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_key text;
  v_patch_keys text[];
  v_margin_only boolean;
  v_allowed_keys text[] := array[
    'name', 'client_contact_name', 'phone_number', 'website_or_social_link', 'sector', 'industry',
    'company', 'services', 'other_services', 'sales_brief', 'contract_value', 'due_value',
    'remaining_value', 'contract_duration_months', 'start_date', 'renewal_date', 'profit_margin_pct',
    'renewal_value'
  ];
  v_name text;
  v_sector text;
  v_company text;
  v_services text[];
  v_other_services text[];
  v_contract_value numeric;
  v_due_value numeric;
  v_remaining_value numeric;
  v_contract_duration_months integer;
  v_start_date date;
  v_renewal_date date;
  v_profit_margin_pct numeric;
  v_renewal_value numeric; v_cached_role text; v_cached_uid text;
begin
  v_cached_role:=public.app_user_role();
  v_cached_uid:=public.app_user_id();

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  select coalesce(array_agg(key), array[]::text[]) into v_patch_keys from jsonb_object_keys(p_patch) as key;
  v_margin_only := v_patch_keys <@ array['profit_margin_pct'];

  if not (
    v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = v_cached_uid)
    or (v_cached_role = 'sales' and v_client.sales_owner_id = v_cached_uid)
    or (v_cached_role = 'media_buying_team_lead' and v_margin_only)
    or (
      v_cached_role = 'media_buying_agent' and v_margin_only
      and exists (
        select 1 from public.assignments a
        where a.client_id = p_client_id
          and a.service_type = 'media_buying'
          and a.agent_id = v_cached_uid
      )
    )
  ) then
    raise exception 'You do not have permission to edit this client.';
  end if;

  for v_key in select jsonb_object_keys(p_patch) loop
    if not (v_key = any(v_allowed_keys)) then
      raise exception 'Unknown or disallowed field: %', v_key;
    end if;
  end loop;

  if p_patch ? 'name' then
    v_name := p_patch ->> 'name';
    if v_name is null or btrim(v_name) = '' then
      raise exception 'name cannot be blank';
    end if;
  end if;

  if p_patch ? 'sector' then
    v_sector := nullif(p_patch ->> 'sector', '');
    if v_sector is not null and v_sector not in ('E-Commerce', 'Service') then
      raise exception 'sector must be E-Commerce, Service, or null';
    end if;
  end if;

  if p_patch ? 'company' then
    v_company := nullif(p_patch ->> 'company', '');
    if v_company is not null and v_company not in ('kesra', 'fast_growth', 'top_rate') then
      raise exception 'company must be kesra, fast_growth, top_rate, or null';
    end if;
  end if;

  if p_patch ? 'services' then
    select coalesce(array_agg(value), array[]::text[]) into v_services
    from jsonb_array_elements_text(p_patch -> 'services');
    if not (v_services <@ array['seo', 'social_media', 'media_buying']) then
      raise exception 'services must only contain seo, social_media, media_buying';
    end if;
  end if;

  if p_patch ? 'other_services' then
    select coalesce(array_agg(value), array[]::text[]) into v_other_services
    from jsonb_array_elements_text(p_patch -> 'other_services');
  end if;

  if p_patch ? 'services' or p_patch ? 'other_services' then
    if coalesce(v_services, v_client.services) && coalesce(v_other_services, v_client.other_services) then
      raise exception 'services and other_services must not overlap';
    end if;
  end if;

  if p_patch ? 'contract_value' then
    v_contract_value := nullif(p_patch ->> 'contract_value', '')::numeric;
    if v_contract_value is not null and v_contract_value < 0 then
      raise exception 'contract_value must be >= 0';
    end if;
  end if;

  if p_patch ? 'due_value' then
    v_due_value := nullif(p_patch ->> 'due_value', '')::numeric;
    if v_due_value is not null and v_due_value < 0 then
      raise exception 'due_value must be >= 0';
    end if;
  end if;

  if p_patch ? 'remaining_value' then
    v_remaining_value := nullif(p_patch ->> 'remaining_value', '')::numeric;
    if v_remaining_value is not null and v_remaining_value < 0 then
      raise exception 'remaining_value must be >= 0';
    end if;
  end if;

  if p_patch ? 'contract_duration_months' then
    v_contract_duration_months := nullif(p_patch ->> 'contract_duration_months', '')::integer;
    if v_contract_duration_months is not null and v_contract_duration_months < 0 then
      raise exception 'contract_duration_months must be >= 0';
    end if;
  end if;

  if p_patch ? 'start_date' then
    v_start_date := nullif(p_patch ->> 'start_date', '')::date;
  end if;

  if p_patch ? 'renewal_date' then
    v_renewal_date := nullif(p_patch ->> 'renewal_date', '')::date;
  end if;

  if p_patch ? 'profit_margin_pct' then
    v_profit_margin_pct := nullif(p_patch ->> 'profit_margin_pct', '')::numeric;
    if v_profit_margin_pct is not null and (v_profit_margin_pct < 0 or v_profit_margin_pct > 1) then
      raise exception 'profit_margin_pct must be between 0 and 1 (a fraction, e.g. 0.3 for 30%%)';
    end if;
  end if;

  if p_patch ? 'renewal_value' then
    v_renewal_value := nullif(p_patch ->> 'renewal_value', '')::numeric;
    if v_renewal_value is not null and v_renewal_value < 0 then
      raise exception 'renewal_value must be >= 0';
    end if;
  end if;

  update public.clients set
    name = case when p_patch ? 'name' then v_name else name end,
    client_contact_name = case when p_patch ? 'client_contact_name' then nullif(p_patch ->> 'client_contact_name', '') else client_contact_name end,
    phone_number = case when p_patch ? 'phone_number' then nullif(p_patch ->> 'phone_number', '') else phone_number end,
    website_or_social_link = case when p_patch ? 'website_or_social_link' then nullif(p_patch ->> 'website_or_social_link', '') else website_or_social_link end,
    sector = case when p_patch ? 'sector' then v_sector else sector end,
    industry = case when p_patch ? 'industry' then nullif(p_patch ->> 'industry', '') else industry end,
    company = case when p_patch ? 'company' then v_company else company end,
    services = case when p_patch ? 'services' then v_services else services end,
    other_services = case when p_patch ? 'other_services' then v_other_services else other_services end,
    sales_brief = case when p_patch ? 'sales_brief' then nullif(p_patch ->> 'sales_brief', '') else sales_brief end,
    contract_value = case when p_patch ? 'contract_value' then v_contract_value else contract_value end,
    due_value = case when p_patch ? 'due_value' then v_due_value else due_value end,
    remaining_value = case when p_patch ? 'remaining_value' then v_remaining_value else remaining_value end,
    contract_duration_months = case when p_patch ? 'contract_duration_months' then v_contract_duration_months else contract_duration_months end,
    start_date = case when p_patch ? 'start_date' then v_start_date else start_date end,
    renewal_date = case when p_patch ? 'renewal_date' then v_renewal_date else renewal_date end,
    profit_margin_pct = case when p_patch ? 'profit_margin_pct' then v_profit_margin_pct else profit_margin_pct end,
    renewal_value = case when p_patch ? 'renewal_value' then v_renewal_value else renewal_value end
  where id = p_client_id;
end;
$$;

create or replace function public.update_client_dates(
  p_client_id text,
  p_start_date date,
  p_renewal_date date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients; v_cached_role text; v_cached_uid text;
begin
  v_cached_role:=public.app_user_role();
  v_cached_uid:=public.app_user_id();

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = v_cached_uid)
    or (v_cached_role = 'sales' and v_client.sales_owner_id = v_cached_uid)
  ) then
    raise exception 'You do not have permission to edit this client''s dates.';
  end if;

  update public.clients
  set start_date = p_start_date, renewal_date = p_renewal_date
  where id = p_client_id;
end;
$$;

create or replace function public.get_user_schedule_load(
  p_user_id text,
  p_from date,
  p_to date,
  p_as_of timestamptz default now()
)
returns table(due_date date, task_count integer, carried_over_count integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_role text;
  v_target_auth_id text;
  v_target_deactivated_at timestamptz;
  v_today date := (p_as_of at time zone 'Africa/Cairo')::date;
  v_carried_over_count integer;
  v_first_working_day date; v_cached_role text;
begin
  v_cached_role:=public.app_user_role();

  if v_cached_role = 'sales' then
    raise exception 'sales may not query schedule load.';
  end if;

  if p_from is null or p_to is null then
    raise exception 'p_from and p_to are required.';
  end if;
  if p_from > p_to then
    raise exception 'p_from must not be after p_to.';
  end if;

  select u.role, u.auth_id, u.deactivated_at
    into v_target_role, v_target_auth_id, v_target_deactivated_at
  from public.users u
  where u.id = p_user_id;

  if v_target_role is null then
    raise exception 'User not found.';
  end if;
  if v_target_auth_id is null or v_target_deactivated_at is not null then
    raise exception 'User is not an active employee.';
  end if;
  if v_target_role = 'sales' then
    raise exception 'sales users are never assignable.';
  end if;
  if v_target_role = 'marketing_manager' then
    raise exception 'marketing_manager is excluded from schedule-load lookups.';
  end if;
  if v_target_role in ('executive', 'head_of_technical')
     and not (v_target_role = 'head_of_technical' and v_cached_role = 'executive') then
    raise exception 'You are not permitted to view this user''s schedule.';
  end if;

  -- All of this assignee's overdue, still-open tasks, system-wide — independent of [p_from, p_to].
  select count(*)
    into v_carried_over_count
  from public.tasks t
  where t.due_date < v_today
    and t.status not in ('completed', 'closed')
    and exists (
      select 1 from public.task_assignees ta
      where ta.task_id = t.id and ta.user_id = p_user_id
    );

  -- The one row carried_over_count attaches to: the first working day (dow <> 5, i.e. not
  -- Friday) in [p_from, p_to]. NULL (and therefore attached to nothing) if the whole window is
  -- non-working days.
  select min(gs.d::date)
    into v_first_working_day
  from generate_series(p_from, p_to, interval '1 day') as gs(d)
  where extract(dow from gs.d::date) <> 5;

  return query
    select
      gs.d::date as due_date,
      count(t.id)::integer as task_count,
      case when gs.d::date = v_first_working_day then v_carried_over_count else 0 end as carried_over_count
    from generate_series(p_from, p_to, interval '1 day') as gs(d)
    left join public.tasks t
      on t.due_date = gs.d::date
      and exists (
        select 1 from public.task_assignees ta
        where ta.task_id = t.id and ta.user_id = p_user_id
      )
      and (
        gs.d::date <= v_today
        or t.status not in ('completed', 'closed')
      )
    group by gs.d
    order by gs.d;
end;
$$;

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
  status text,
  target_roas numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_cached_uid text;
begin
  v_cached_uid:=public.app_user_id();

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
        u.id = v_cached_uid
        or exists (
          select 1 from public.mentorship_oversight mo
          where mo.media_buyer_id = u.id and mo.overseer_id = v_cached_uid
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
    case when avg3.avg_sales is null then null else tier.required_growth_pct end,
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
    end,
    case
      when avg3.avg_sales is null and coalesce(c.profit_margin_pct, 0) > 0 then 0
      else null
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

commit;
