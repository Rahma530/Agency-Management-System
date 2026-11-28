-- Phase 1 of the Testing Portal work (see the "Cross-Department Testing Portal" doc):
-- lays the schema + guard foundation that lets a synthetic test identity act with a real
-- role's permissions while being physically unable to read or write real production rows.
--
-- Why both a column+restrictive-policy AND a guard inside RPC functions are needed:
-- this schema enforces permission in two different places depending on the code path --
--   1) Direct table reads that go through Postgres row-level security (the various
--      "*_select_rls" / "*_update_*_rls" policies on clients/tasks/users).
--   2) Explicit RPC calls to SECURITY DEFINER functions (get_client_access,
--      update_client_access, update_client_dates, update_client_details, close_client,
--      reopen_client, task_closable, task_visible_v2...). SECURITY DEFINER functions run
--      as the function owner, which bypasses table RLS entirely (confirmed: none of these
--      tables have FORCE ROW LEVEL SECURITY set) -- that's exactly why every one of these
--      functions already does its own manual role/ownership check in code, duplicating
--      what RLS would otherwise do.
-- A single new RESTRICTIVE policy per table only protects path (1). Every function in
-- path (2) needs its own one-line guard too. Both are added here, driven by one shared
-- is_test flag per row and one shared public.app_user_is_test_identity() lookup, so there
-- is exactly one source of truth for "is this caller a test identity" and one convention
-- for "is this row real or synthetic".
--
-- Audited and patched in this pass: clients + tasks, and every RPC function that reads or
-- writes them (get_client_access, get_client_access_attachments,
-- insert_client_access_attachment, delete_client_access_attachment, update_client_access,
-- update_client_dates, update_client_details, close_client, reopen_client, task_closable,
-- task_visible_v2/task_visible_level).
--
-- NOT yet covered (flagged for a follow-up migration, same pattern): briefs (incl.
-- mark_brief_viewed), daily_logs, reports, client_portal_* tables, and any other RPC that
-- mutates client/task-adjacent data (e.g. record_client_renewal_payment, confirm_client_renewal,
-- set_task_assignees). Scoped to clients + tasks first because that's where the Account
-- Managers test case (and most department UIs) actually read/write.
begin;

-- 1. Schema: one flag per table that can hold synthetic rows, plus the identity flag itself.
alter table public.users   add column if not exists is_test_identity boolean not null default false;
alter table public.clients add column if not exists is_test          boolean not null default false;
alter table public.tasks   add column if not exists is_test          boolean not null default false;

comment on column public.users.is_test_identity   is 'true for a synthetic Testing Portal identity -- never a real employee.';
comment on column public.clients.is_test           is 'true for synthetic data created for a Testing Portal session -- never a real client.';
comment on column public.tasks.is_test             is 'true for synthetic data created for a Testing Portal session -- never a real task.';

-- 2. Audit table: one row per test session. Simplified (2026-11-28, same day as the first
-- version below in git history) from an earlier draft that had a multi-stage approval workflow
-- (testing/approved/rejected/changes_requested/promoted) -- that workflow belonged to the full
-- Testing Portal UI, which was dropped in favor of a single "send a direct link, test it, close
-- it" flow (see the architecture doc). All that flow actually needs to track is: who asked for
-- it, what synthetic rows it created (so closing it can delete exactly those rows, nothing
-- inferred by scanning for is_test=true elsewhere), and whether it's still open. Row is never
-- deleted on close -- closed_at is set instead -- so this table doubles as the audit trail.
create table if not exists public.test_sessions (
  id                  text primary key default ('ts-' || replace(gen_random_uuid()::text, '-', '')),
  requested_by        text not null references public.users(id),
  synthetic_user_id    text references public.users(id),
  synthetic_client_id  text references public.clients(id),
  synthetic_task_id    text references public.tasks(id),
  target_role          text not null,
  description          text not null,
  created_at           timestamptz not null default now(),
  -- Safety net only, not the normal close path: normal close is manual, immediate, and happens
  -- the moment the requester clicks "close" (see the test-identity-service Edge Function) -- no
  -- scheduled/cron job runs to enforce this. This is just how long a forgotten, never-closed
  -- session is allowed to linger before a once-daily sweep (same Edge Function, a 'sweep' action)
  -- deletes it anyway.
  expires_at           timestamptz not null default (now() + interval '24 hours'),
  closed_at            timestamptz
);

alter table public.test_sessions enable row level security;

create policy "test_sessions_select_rls" on public.test_sessions for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
  or requested_by = public.app_user_id()
);

create policy "test_sessions_insert_rls" on public.test_sessions for insert to authenticated with check (
  public.app_user_role() in ('ai_engineer', 'head_of_technical')
  and requested_by = public.app_user_id()
);

create policy "test_sessions_update_rls" on public.test_sessions for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
  or requested_by = public.app_user_id()
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
  or requested_by = public.app_user_id()
);

-- 3. The one shared lookup every guard below (and every future one) calls.
create or replace function public.app_user_is_test_identity()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(is_test_identity, false) from public.users where auth_id = auth.uid();
$$;

-- 4. Path (1): restrictive policies on the tables themselves. "as restrictive" means Postgres
-- ANDs this with every existing permissive policy on the table -- it can only take access away,
-- never grant it, so nothing above (clients_select_rls, tasks RLS, etc.) needs to change.
drop policy if exists "deny_test_identity_cross_contamination_users" on public.users;
create policy "deny_test_identity_cross_contamination_users" on public.users
as restrictive for all to authenticated
using (not public.app_user_is_test_identity() or is_test_identity)
with check (not public.app_user_is_test_identity() or is_test_identity);

drop policy if exists "deny_test_identity_cross_contamination_clients" on public.clients;
create policy "deny_test_identity_cross_contamination_clients" on public.clients
as restrictive for all to authenticated
using (not public.app_user_is_test_identity() or is_test)
with check (not public.app_user_is_test_identity() or is_test);

drop policy if exists "deny_test_identity_cross_contamination_tasks" on public.tasks;
create policy "deny_test_identity_cross_contamination_tasks" on public.tasks
as restrictive for all to authenticated
using (not public.app_user_is_test_identity() or is_test)
with check (not public.app_user_is_test_identity() or is_test);

-- 5. Path (2): the guard inside every SECURITY DEFINER function that reads/writes clients or
-- tasks directly (these bypass RLS, see the header note). Same signature as the current
-- definition in each case -- CREATE OR REPLACE preserves existing grants -- and the only change
-- from the live body is the one guard block added right after the row is fetched. Everything
-- else is copied verbatim, zero logic change.

create or replace function public.get_client_access(p_client_id text)
returns table (
  general_email text,
  general_email_password text,
  store_platform_username text,
  store_platform_password text,
  social_media_username text,
  social_media_password text,
  ad_account_username text,
  ad_account_password text,
  ad_account_setup_type text,
  payment_card_details text
)
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

  if public.app_user_is_test_identity() and not v_client.is_test then
    raise exception 'A test identity may only access test clients.';
  end if;

  if not (
    v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = v_cached_uid)
  ) then
    raise exception 'You do not have permission to view this client''s access details.';
  end if;

  insert into public.client_access_log (client_id, accessed_by)
  values (p_client_id, v_cached_uid);

  return query select
    v_client.general_email,
    v_client.general_email_password,
    v_client.store_platform_username,
    v_client.store_platform_password,
    v_client.social_media_username,
    v_client.social_media_password,
    v_client.ad_account_username,
    v_client.ad_account_password,
    v_client.ad_account_setup_type,
    v_client.payment_card_details;
end;
$$;

create or replace function public.get_client_access_attachments(p_client_id text)
returns table (
  id text,
  storage_path text,
  filename text,
  file_size bigint,
  mime_type text,
  label text,
  uploaded_by text,
  uploaded_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients; v_cached_role text; v_cached_uid text;
begin
  v_cached_role:=public.app_user_role();
  v_cached_uid:=public.app_user_id();

  select * into v_client from public.clients c where c.id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if public.app_user_is_test_identity() and not v_client.is_test then
    raise exception 'A test identity may only access test clients.';
  end if;

  if not (
    v_cached_role = 'ai_engineer'
    or v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = v_cached_uid)
  ) then
    raise exception 'You do not have permission to view this client''s access attachments.';
  end if;

  insert into public.client_access_log (client_id, accessed_by)
  values (p_client_id, v_cached_uid);

  return query
    select caa.id, caa.storage_path, caa.filename, caa.file_size, caa.mime_type, caa.label,
           caa.uploaded_by, caa.uploaded_at
    from public.client_access_attachments caa
    where caa.client_id = p_client_id
    order by caa.uploaded_at desc;
end;
$$;

create or replace function public.insert_client_access_attachment(
  p_client_id text,
  p_storage_path text,
  p_filename text,
  p_file_size bigint,
  p_mime_type text,
  p_label text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_id text; v_cached_role text; v_cached_uid text;
begin
  v_cached_role:=public.app_user_role();
  v_cached_uid:=public.app_user_id();

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if public.app_user_is_test_identity() and not v_client.is_test then
    raise exception 'A test identity may only access test clients.';
  end if;

  if not (
    v_cached_role = 'ai_engineer'
    or v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = v_cached_uid)
  ) then
    raise exception 'You do not have permission to upload an access attachment for this client.';
  end if;

  v_id := 'cxa-' || replace(gen_random_uuid()::text, '-', '');

  insert into public.client_access_attachments
    (id, client_id, storage_path, filename, file_size, mime_type, label, uploaded_by)
  values
    (v_id, p_client_id, p_storage_path, p_filename, p_file_size, p_mime_type, p_label, v_cached_uid);

  return v_id;
end;
$$;

create or replace function public.delete_client_access_attachment(p_attachment_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.client_access_attachments;
  v_client public.clients; v_cached_role text;
begin
  v_cached_role:=public.app_user_role();

  select * into v_row from public.client_access_attachments where id = p_attachment_id;
  if not found then
    raise exception 'Attachment not found';
  end if;

  select * into v_client from public.clients where id = v_row.client_id;

  if public.app_user_is_test_identity() and not coalesce(v_client.is_test, false) then
    raise exception 'A test identity may only access test clients.';
  end if;

  if not (
    v_cached_role = 'ai_engineer'
    or v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to delete this client''s access attachment.';
  end if;

  delete from public.client_access_attachments where id = p_attachment_id;
end;
$$;

create or replace function public.update_client_access(
  p_client_id text,
  p_general_email text,
  p_general_email_password text,
  p_store_platform_username text,
  p_store_platform_password text,
  p_social_media_username text,
  p_social_media_password text,
  p_ad_account_username text,
  p_ad_account_password text,
  p_ad_account_setup_type text,
  p_payment_card_details text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients; v_cached_role text;
begin
  v_cached_role:=public.app_user_role();

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if public.app_user_is_test_identity() and not v_client.is_test then
    raise exception 'A test identity may only modify test clients.';
  end if;

  if not (
    v_cached_role in ('executive', 'head_of_technical', 'am_team_lead')
    or (v_cached_role = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to edit this client''s access details.';
  end if;

  update public.clients
  set
    general_email = p_general_email,
    general_email_password = p_general_email_password,
    store_platform_username = p_store_platform_username,
    store_platform_password = p_store_platform_password,
    social_media_username = p_social_media_username,
    social_media_password = p_social_media_password,
    ad_account_username = p_ad_account_username,
    ad_account_password = p_ad_account_password,
    ad_account_setup_type = p_ad_account_setup_type,
    payment_card_details = p_payment_card_details
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

  if public.app_user_is_test_identity() and not v_client.is_test then
    raise exception 'A test identity may only modify test clients.';
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

  if public.app_user_is_test_identity() and not v_client.is_test then
    raise exception 'A test identity may only modify test clients.';
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

create or replace function public.close_client(
  p_client_id text,
  p_stop_date date,
  p_closure_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_caller_id text;
  v_caller_role text;
  v_open_period_id text;
  v_open_period_started_on date;
  v_closure_reason text;
begin
  if auth.role() is distinct from 'service_role' then
    v_caller_id := public.app_user_id();
    v_caller_role := public.app_user_role();

    if auth.uid() is null or v_caller_id is null or v_caller_role is null then
      raise exception 'You must be signed in as a KMS employee to close a client.';
    end if;

    if v_caller_role not in ('executive', 'head_of_technical', 'am_team_lead', 'am_agent') then
      raise exception 'You do not have permission to close this client.';
    end if;
  end if;

  select *
  into v_client
  from public.clients
  where id = p_client_id
  for update;

  if not found then
    raise exception 'Client not found.';
  end if;

  if auth.role() is distinct from 'service_role'
    and public.app_user_is_test_identity() and not v_client.is_test then
    raise exception 'A test identity may only close test clients.';
  end if;

  if auth.role() is distinct from 'service_role'
    and v_caller_role = 'am_agent'
    and v_client.am_agent_id is distinct from v_caller_id then
    raise exception 'You do not have permission to close this client.';
  end if;

  if v_client.status = 'closed' then
    raise exception 'This client is already closed.';
  end if;

  if p_stop_date is null then
    raise exception 'Stop / Loss Date is required.';
  end if;

  if p_stop_date > current_date then
    raise exception 'Stop / Loss Date cannot be in the future.';
  end if;

  if v_client.start_date is not null and p_stop_date < v_client.start_date then
    raise exception 'Stop / Loss Date cannot be earlier than the Start Date.';
  end if;

  v_closure_reason := nullif(btrim(p_closure_reason), '');
  if v_closure_reason is null then
    raise exception 'Closure Reason is required.';
  end if;

  select id, started_on
  into v_open_period_id, v_open_period_started_on
  from public.client_lifecycle_periods
  where client_id = p_client_id
    and ended_on is null
  for update;

  if v_open_period_id is not null then
    if p_stop_date < v_open_period_started_on then
      raise exception 'Stop / Loss Date cannot be earlier than the current lifecycle period start date.';
    end if;

    update public.client_lifecycle_periods
    set ended_on = p_stop_date,
        closure_reason = v_closure_reason,
        updated_at = now()
    where id = v_open_period_id;
  elsif v_client.start_date is not null then
    insert into public.client_lifecycle_periods (
      id,
      client_id,
      started_on,
      ended_on,
      closure_reason
    ) values (
      gen_random_uuid()::text,
      p_client_id,
      v_client.start_date,
      p_stop_date,
      v_closure_reason
    );
  end if;

  update public.clients
  set status = 'closed',
      churned_at = p_stop_date::timestamp at time zone 'UTC',
      churn_reason = v_closure_reason
  where id = p_client_id;
end;
$$;

create or replace function public.reopen_client(
  p_client_id text,
  p_reopen_date date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.clients;
  v_caller_id text;
  v_caller_role text;
  v_existing_open_period_id text;
  v_has_lifecycle_history boolean;
  v_latest_ended_on date;
  v_legacy_ended_on date;
begin
  if auth.role() is distinct from 'service_role' then
    v_caller_id := public.app_user_id();
    v_caller_role := public.app_user_role();

    if auth.uid() is null or v_caller_id is null or v_caller_role is null then
      raise exception 'You must be signed in as a KMS employee to reopen a client.';
    end if;

    if v_caller_role not in ('executive', 'head_of_technical', 'am_team_lead', 'am_agent') then
      raise exception 'You do not have permission to reopen this client.';
    end if;
  end if;

  select *
  into v_client
  from public.clients
  where id = p_client_id
  for update;

  if not found then
    raise exception 'Client not found.';
  end if;

  if auth.role() is distinct from 'service_role'
    and public.app_user_is_test_identity() and not v_client.is_test then
    raise exception 'A test identity may only reopen test clients.';
  end if;

  if auth.role() is distinct from 'service_role'
    and v_caller_role = 'am_agent'
    and v_client.am_agent_id is distinct from v_caller_id then
    raise exception 'You do not have permission to reopen this client.';
  end if;

  if v_client.status <> 'closed' then
    raise exception 'Only a closed client can be reopened.';
  end if;

  if p_reopen_date is null then
    raise exception 'Reopen Date is required.';
  end if;

  if p_reopen_date > current_date then
    raise exception 'Reopen Date cannot be in the future.';
  end if;

  select id
  into v_existing_open_period_id
  from public.client_lifecycle_periods
  where client_id = p_client_id
    and ended_on is null
  for update;

  if v_existing_open_period_id is not null then
    raise exception 'This client already has an open lifecycle period.';
  end if;

  select exists (
    select 1
    from public.client_lifecycle_periods
    where client_id = p_client_id
  ) into v_has_lifecycle_history;

  select max(ended_on)
  into v_latest_ended_on
  from public.client_lifecycle_periods
  where client_id = p_client_id;

  if not v_has_lifecycle_history
    and v_client.start_date is not null
    and p_reopen_date < v_client.start_date then
    raise exception 'Reopen Date cannot be earlier than the original Start Date.';
  end if;

  if not v_has_lifecycle_history
    and v_client.start_date is not null
    and v_client.churned_at is not null then
    v_legacy_ended_on := (v_client.churned_at at time zone 'UTC')::date;

    if v_legacy_ended_on >= v_client.start_date
      and v_legacy_ended_on <= current_date then
      v_latest_ended_on := v_legacy_ended_on;
    end if;
  end if;

  if v_latest_ended_on is not null and p_reopen_date < v_latest_ended_on then
    raise exception 'Reopen Date cannot be earlier than the latest lifecycle period end date.';
  end if;

  if not v_has_lifecycle_history
    and v_legacy_ended_on is not null
    and v_legacy_ended_on >= v_client.start_date
    and v_legacy_ended_on <= current_date then
    insert into public.client_lifecycle_periods (
      id,
      client_id,
      started_on,
      ended_on,
      closure_reason
    ) values (
      gen_random_uuid()::text,
      p_client_id,
      v_client.start_date,
      v_legacy_ended_on,
      v_client.churn_reason
    );
  end if;

  insert into public.client_lifecycle_periods (
    id,
    client_id,
    started_on,
    ended_on,
    closure_reason
  ) values (
    gen_random_uuid()::text,
    p_client_id,
    p_reopen_date,
    null,
    null
  );

  update public.clients
  set status = 'active',
      churned_at = null,
      churn_reason = null
  where id = p_client_id;
end;
$$;

create or replace function public.task_closable(p_task_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ctx as (select public.app_user_id() as uid)
  select
    (
      public.app_user_role() in ('executive', 'head_of_technical')
      or exists (select 1 from public.tasks t where t.id = p_task_id and t.created_by = ctx.uid)
      or exists (
        select 1 from public.task_assignees ta
        where ta.task_id = p_task_id and ta.user_id = ctx.uid
      )
    )
    and (
      not public.app_user_is_test_identity()
      or exists (select 1 from public.tasks t where t.id = p_task_id and t.is_test)
    )
  from ctx;
$$;

create or replace function public.task_visible_level(
  p_task_id text,
  p_created_by text,
  p_client_id text,
  p_is_inhouse boolean,
  p_role text,
  p_uid text,
  p_team text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p_role in ('executive', 'head_of_technical')
    or p_created_by = p_uid
    or exists (
      select 1 from public.task_assignees ta
      where ta.task_id = p_task_id and ta.user_id = p_uid
    )
    or (
      p_role in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
      and not p_is_inhouse
      and (
        exists (select 1 from public.users u where u.id = p_created_by and u.team = p_team)
        or exists (
          select 1 from public.task_assignees ta
          join public.users u on u.id = ta.user_id
          where ta.task_id = p_task_id and u.team = p_team
        )
        or (
          p_role = 'seo_team_lead'
          and (
            exists (select 1 from public.users u where u.id = p_created_by and u.team = 'Programming')
            or exists (
              select 1 from public.task_assignees ta
              join public.users u on u.id = ta.user_id
              where ta.task_id = p_task_id and u.team = 'Programming'
            )
          )
        )
      )
    )
    or (
      p_role = 'am_agent'
      and not p_is_inhouse
      and p_client_id is not null
      and public.client_am_agent_is_caller(p_client_id)
    )
    or (
      p_role = 'marketing_manager'
      and (
        p_is_inhouse
        or exists (select 1 from public.users u where u.id = p_created_by and u.role in ('graphic_designer', 'video_editor'))
        or exists (
          select 1 from public.task_assignees ta
          join public.users u on u.id = ta.user_id
          where ta.task_id = p_task_id and u.role in ('graphic_designer', 'video_editor')
        )
      )
    );
$$;

revoke all on function public.task_visible_level(text, text, text, boolean, text, text, text) from public, anon;
grant execute on function public.task_visible_level(text, text, text, boolean, text, text, text) to authenticated;

create or replace function public.task_visible_v2(p_task_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ctx as (
    select public.app_user_role() as role, public.app_user_id() as uid, public.app_user_team() as team
  ),
  t as (
    select
      tk.id, tk.created_by, tk.client_id, tk.is_test,
      coalesce(c.is_inhouse, false) as is_inhouse,
      p.id as p_id, p.created_by as p_created_by, p.client_id as p_client_id,
      coalesce(pc.is_inhouse, false) as p_is_inhouse,
      gp.id as gp_id, gp.created_by as gp_created_by, gp.client_id as gp_client_id,
      coalesce(gpc.is_inhouse, false) as gp_is_inhouse
    from public.tasks tk
    left join public.clients c on c.id = tk.client_id
    left join public.tasks p on p.id = tk.parent_task_id
    left join public.clients pc on pc.id = p.client_id
    left join public.tasks gp on gp.id = p.parent_task_id
    left join public.clients gpc on gpc.id = gp.client_id
    where tk.id = p_task_id
  )
  select
    ctx.role <> 'sales'
    and exists (select 1 from t)
    and (not public.app_user_is_test_identity() or exists (select 1 from t where t.is_test))
    and (
      exists (
        select 1 from t
        where public.task_visible_level(t.id, t.created_by, t.client_id, t.is_inhouse, ctx.role, ctx.uid, ctx.team)
      )
      or exists (
        select 1 from t
        where t.p_id is not null
          and public.task_visible_level(t.p_id, t.p_created_by, t.p_client_id, t.p_is_inhouse, ctx.role, ctx.uid, ctx.team)
      )
      or exists (
        select 1 from t
        where t.gp_id is not null
          and public.task_visible_level(t.gp_id, t.gp_created_by, t.gp_client_id, t.gp_is_inhouse, ctx.role, ctx.uid, ctx.team)
      )
    )
  from ctx;
$$;

revoke all on function public.task_visible_v2(text) from public, anon;
grant execute on function public.task_visible_v2(text) to authenticated;

commit;
