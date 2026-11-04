-- Owner's request (2026-11-04): marketing_manager must be able to treat Kesraa/Fast Growth
-- (is_inhouse clients) like a full Client — not just raise/see Tasks for them (already covered by
-- 20261228000000_task_visibility_inhouse_restriction.sql + 20261230000000's clients_select_rls
-- fix), but also assign a responsible specialist per service (SEO/Media Buying/Social
-- Media/Graphic Design), exactly like executive/head_of_technical already can for every client.
--
-- Root cause checked directly against the live policies (20261217300000_graphic_design_service.sql,
-- the latest redefinition of all three): assignments_select_rls/assignments_insert_rls/
-- assignments_update_rls have no branch for marketing_manager at all, so every one of those three
-- operations on public.assignments silently fails for them today (RLS denies it before
-- handleAssignServiceAgent's own insert/update ever reaches a row) — regardless of what the
-- frontend now offers.
--
-- Fix: each policy is CREATE OR REPLACE'd verbatim (identical to 20261217300000's bodies) plus one
-- new marketing_manager branch, scoped to is_inhouse clients only — this intentionally does NOT
-- give marketing_manager any assignment access to a normal (non-inhouse) client, only closes the
-- gap for Kesraa/Fast Growth. The INSERT branch mirrors the existing executive/head_of_technical
-- branch's service_type allow-list (seo/media_buying/social_media/graphic_design — 'interface' has
-- no insert path for anyone yet, pre-existing and unrelated to this fix) and its same
-- assignee-role-matches-service_type check.
begin;

-- 1. SELECT — add marketing_manager, is_inhouse clients only.
drop policy if exists "assignments_select_rls" on public.assignments;
create policy "assignments_select_rls" on public.assignments for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'graphic_designer' and service_type = 'graphic_design' and agent_id = public.app_user_id())
  or (
    public.app_user_role() = 'marketing_manager'
    and exists (select 1 from public.clients c where c.id = client_id and c.is_inhouse)
  )
);

-- 2. INSERT — add marketing_manager, is_inhouse clients only, same service_type/assignee-role
-- allow-list as the existing executive/head_of_technical branch.
drop policy if exists "assignments_insert_rls" on public.assignments;
create policy "assignments_insert_rls" on public.assignments
for insert to authenticated
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (
    public.app_user_role() in ('executive', 'head_of_technical')
    and service_type in ('seo', 'media_buying', 'social_media', 'graphic_design')
    and public.client_has_service(client_id, service_type)
    and exists (
      select 1
      from public.users assignee
      where assignee.id = agent_id
        and assignee.auth_id is not null
        and assignee.deactivated_at is null
        and (
          (service_type = 'seo' and assignee.role in (
            'seo_team_lead',
            'seo_agent',
            'seo_content_agent',
            'seo_backlink_agent'
          ))
          or (service_type = 'media_buying' and assignee.role in (
            'media_buying_team_lead',
            'media_buying_agent'
          ))
          or (service_type = 'social_media' and assignee.role in (
            'social_media_team_lead',
            'social_media_agent'
          ))
          or (service_type = 'graphic_design' and assignee.role = 'graphic_designer')
        )
    )
  )
  or (
    public.app_user_role() = 'am_team_lead'
    and service_type = 'graphic_design'
    and public.client_has_service(client_id, 'graphic_design')
    and exists (
      select 1 from public.users assignee
      where assignee.id = agent_id
        and assignee.role = 'graphic_designer'
        and assignee.auth_id is not null
        and assignee.deactivated_at is null
    )
  )
  or (
    public.app_user_role() = 'am_agent'
    and public.client_am_agent_is_caller(client_id)
    and service_type = 'graphic_design'
    and public.client_has_service(client_id, 'graphic_design')
    and exists (
      select 1 from public.users assignee
      where assignee.id = agent_id
        and assignee.role = 'graphic_designer'
        and assignee.auth_id is not null
        and assignee.deactivated_at is null
    )
  )
  or (
    public.app_user_role() = 'marketing_manager'
    and service_type in ('seo', 'media_buying', 'social_media', 'graphic_design')
    and exists (select 1 from public.clients c where c.id = client_id and c.is_inhouse)
    and public.client_has_service(client_id, service_type)
    and exists (
      select 1
      from public.users assignee
      where assignee.id = agent_id
        and assignee.auth_id is not null
        and assignee.deactivated_at is null
        and (
          (service_type = 'seo' and assignee.role in (
            'seo_team_lead',
            'seo_agent',
            'seo_content_agent',
            'seo_backlink_agent'
          ))
          or (service_type = 'media_buying' and assignee.role in (
            'media_buying_team_lead',
            'media_buying_agent'
          ))
          or (service_type = 'social_media' and assignee.role in (
            'social_media_team_lead',
            'social_media_agent'
          ))
          or (service_type = 'graphic_design' and assignee.role = 'graphic_designer')
        )
    )
  )
);

-- 3. UPDATE (reassignment) — add marketing_manager, is_inhouse clients only. Unconditional on
-- service_type, same shape as executive/head_of_technical's own unconditional bypass, just scoped
-- to is_inhouse — a row for a service marketing_manager couldn't have created in the first place
-- (see INSERT above) simply never exists to reassign.
drop policy if exists "assignments_update_rls" on public.assignments;
create policy "assignments_update_rls" on public.assignments
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'am_team_lead' and service_type = 'graphic_design')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id) and service_type = 'graphic_design')
  or (
    public.app_user_role() = 'marketing_manager'
    and exists (select 1 from public.clients c where c.id = client_id and c.is_inhouse)
  )
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'am_team_lead' and service_type = 'graphic_design')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id) and service_type = 'graphic_design')
  or (
    public.app_user_role() = 'marketing_manager'
    and exists (select 1 from public.clients c where c.id = client_id and c.is_inhouse)
  )
);

-- 4. update_client_details() — marketing_manager may now edit an is_inhouse client's `services`/
-- `other_services` ONLY (reusing v_patch_keys, already computed above for v_margin_only, the same
-- "patch must be a subset of these columns" technique media_buying_team_lead/media_buying_agent's
-- margin-only grant already uses). Everything else about this client (name, contact info,
-- contract/payment fields, etc.) stays off-limits to marketing_manager — this is scoped
-- specifically to closing the "can't give Kesraa/Fast Growth real services" gap, nothing wider.
-- Reproduced verbatim from 20261208000000_update_client_details_mb_agent_margin.sql except for
-- this one added branch in the permission check.
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
    'services', 'other_services', 'sales_brief', 'contract_value', 'due_value', 'remaining_value',
    'contract_duration_months', 'start_date', 'renewal_date', 'profit_margin_pct'
  ];
  v_name text;
  v_sector text;
  v_services text[];
  v_other_services text[];
  v_contract_value numeric;
  v_due_value numeric;
  v_remaining_value numeric;
  v_contract_duration_months integer;
  v_start_date date;
  v_renewal_date date;
  v_profit_margin_pct numeric;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  select coalesce(array_agg(key), array[]::text[]) into v_patch_keys from jsonb_object_keys(p_patch) as key;
  v_margin_only := v_patch_keys <@ array['profit_margin_pct'];

  if not (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
    or (public.app_user_role() = 'sales' and v_client.sales_owner_id = public.app_user_id())
    or (public.app_user_role() = 'media_buying_team_lead' and v_margin_only)
    or (
      public.app_user_role() = 'media_buying_agent' and v_margin_only
      and exists (
        select 1 from public.assignments a
        where a.client_id = p_client_id
          and a.service_type = 'media_buying'
          and a.agent_id = public.app_user_id()
      )
    )
    or (
      public.app_user_role() = 'marketing_manager'
      and v_client.is_inhouse
      and v_patch_keys <@ array['services', 'other_services']
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

  update public.clients set
    name = case when p_patch ? 'name' then v_name else name end,
    client_contact_name = case when p_patch ? 'client_contact_name' then nullif(p_patch ->> 'client_contact_name', '') else client_contact_name end,
    phone_number = case when p_patch ? 'phone_number' then nullif(p_patch ->> 'phone_number', '') else phone_number end,
    website_or_social_link = case when p_patch ? 'website_or_social_link' then nullif(p_patch ->> 'website_or_social_link', '') else website_or_social_link end,
    sector = case when p_patch ? 'sector' then v_sector else sector end,
    industry = case when p_patch ? 'industry' then nullif(p_patch ->> 'industry', '') else industry end,
    services = case when p_patch ? 'services' then v_services else services end,
    other_services = case when p_patch ? 'other_services' then v_other_services else other_services end,
    sales_brief = case when p_patch ? 'sales_brief' then nullif(p_patch ->> 'sales_brief', '') else sales_brief end,
    contract_value = case when p_patch ? 'contract_value' then v_contract_value else contract_value end,
    due_value = case when p_patch ? 'due_value' then v_due_value else due_value end,
    remaining_value = case when p_patch ? 'remaining_value' then v_remaining_value else remaining_value end,
    contract_duration_months = case when p_patch ? 'contract_duration_months' then v_contract_duration_months else contract_duration_months end,
    start_date = case when p_patch ? 'start_date' then v_start_date else start_date end,
    renewal_date = case when p_patch ? 'renewal_date' then v_renewal_date else renewal_date end,
    profit_margin_pct = case when p_patch ? 'profit_margin_pct' then v_profit_margin_pct else profit_margin_pct end
  where id = p_client_id;
end;
$$;

revoke execute on function public.update_client_details(text, jsonb) from public, anon;
grant execute on function public.update_client_details(text, jsonb) to authenticated, service_role;

commit;
