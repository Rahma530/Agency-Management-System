-- Fixes update_client_details() (20261030900000_update_client_details_rpc.sql, already applied):
-- contract_value, due_value, remaining_value, and contract_duration_months were cast directly as
-- (p_patch ->> 'key')::numeric / ::integer, which raises Postgres's own "invalid input syntax for
-- type numeric: \"\"" (or integer) the moment EditClientModal.tsx's patch carries an empty string
-- for one of these — e.g. a user clearing a previously-set due_value field back to blank. Every
-- other nullable text-ish field in this function already goes through nullif(p_patch ->> 'key',
-- '') first so a blank string lands as null; these four numeric/integer fields were the one place
-- that convention was missed. Fixed here by wrapping each in nullif(..., '')::numeric/::integer
-- before the cast, exactly like start_date/renewal_date already do for ::date. Nothing else in
-- the function changes: same role gate, same allow-list, same validations (including the >= 0
-- checks on these same four fields, still skipped when the resolved value is null), same
-- security definer/search_path, same grants.
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
  v_allowed_keys text[] := array[
    'name', 'client_contact_name', 'phone_number', 'website_or_social_link', 'sector', 'industry',
    'services', 'other_services', 'sales_brief', 'contract_value', 'due_value', 'remaining_value',
    'contract_duration_months', 'start_date', 'renewal_date'
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
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
    or (public.app_user_role() = 'sales' and v_client.sales_owner_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to edit this client.';
  end if;

  -- Reject any key outside the allow-list up front, before touching any field — a patch is either
  -- entirely inspected or entirely rejected, never partially applied around a bad key.
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

  -- Overlap check needs both arrays resolved — whichever of the two isn't part of this patch
  -- falls back to the client's existing value for that column.
  if p_patch ? 'services' or p_patch ? 'other_services' then
    if coalesce(v_services, v_client.services) && coalesce(v_other_services, v_client.other_services) then
      raise exception 'services and other_services must not overlap';
    end if;
  end if;

  -- Blank string -> null (same convention as start_date/renewal_date's ::date cast below) — an
  -- actually malformed (non-blank, non-numeric) value still fails the cast itself with Postgres's
  -- own "invalid input syntax for type numeric/integer" error.
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

  -- Blank string -> null; an actually malformed (non-blank, non-date) value fails the ::date cast
  -- itself with Postgres's own "invalid input syntax for type date" error.
  if p_patch ? 'start_date' then
    v_start_date := nullif(p_patch ->> 'start_date', '')::date;
  end if;

  if p_patch ? 'renewal_date' then
    v_renewal_date := nullif(p_patch ->> 'renewal_date', '')::date;
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
    renewal_date = case when p_patch ? 'renewal_date' then v_renewal_date else renewal_date end
  where id = p_client_id;
end;
$$;

revoke execute on function public.update_client_details(text, jsonb) from public, anon;
grant execute on function public.update_client_details(text, jsonb) to authenticated, service_role;

commit;
