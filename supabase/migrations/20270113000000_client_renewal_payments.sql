-- Client Renewals: a dedicated per-cycle payment ledger for renewal collections.
--
-- Separate from clients.due_value/remaining_value/contract_duration_months (Module 12 Phase 7 —
-- AM Team Lead's ORIGINAL signed-contract payment schedule, set once at registration and never
-- auto-recomputed). This table tracks collections against the CURRENT renewal cycle instead:
-- clients.renewal_value is the agreed value for the upcoming renewal (set when that cycle's
-- first payment is logged), and "paid"/"remaining" for that cycle are always derived by summing
-- this table's rows for the client's current renewal_sequence — never stored as a separately
-- editable number, so they can't drift out of sync with the payments that were actually logged.
--
-- renewal_sequence mirrors client_renewal_events.renewal_sequence (the "which renewal round is
-- this" counter already established by confirm_client_renewal, 20270109000000): a payment logged
-- before the current cycle is confirmed carries clients.renewal_history_count + 1, so payments
-- collected toward an in-progress renewal stay attributed to that specific cycle even after it's
-- confirmed and the counter advances for the next one.
--
-- Storage/upload pattern copied from client_contracts (20260922100000_client_contracts.sql):
-- metadata table + a matching private bucket, folder-per-client. transfer_screenshot_path is
-- required (every payment must have proof); new_contract_path is optional (only when the client
-- signed a new contract for this renewal, otherwise null).

begin;

create table public.client_renewal_payments (
  id text primary key,
  client_id text not null references public.clients (id),
  renewal_sequence integer not null,
  renewal_value numeric not null,
  amount_paid numeric not null,
  payment_channel text not null check (payment_channel in ('mahdy', 'masry', 'tabby', 'tamara', 'kesra')),
  -- Payment date is never hand-entered (owner decision): it is always the moment this row was
  -- recorded, i.e. "the day the renewal was uploaded to the system". Kept as its own date column
  -- (rather than casting created_at at query time) so it reads directly like every other date
  -- column in this schema and stays stable even if created_at's time-of-day component is ever
  -- needed for something else later.
  payment_date date not null default current_date,
  renewal_duration_months integer not null check (renewal_duration_months in (1, 3, 6, 12)),
  transfer_screenshot_path text not null,
  new_contract_path text,
  recorded_by text not null references public.users (id),
  created_at timestamptz not null default now()
);

create index idx_client_renewal_payments_client_id on public.client_renewal_payments (client_id);
create index idx_client_renewal_payments_recorded_by on public.client_renewal_payments (recorded_by);

alter table public.client_renewal_payments enable row level security;

-- Same role set as Payment Tracking / contract_value (canAccessClientSensitiveInfo in
-- permissions.ts): executive, head_of_technical, am_team_lead, and the client's own am_agent.
-- Deliberately excludes Sales/head_of_sales and department team leads — this is collections data,
-- not the contract-signing record Sales already owns via client_contracts.
create policy "client_renewal_payments_select_rls" on public.client_renewal_payments
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

create policy "client_renewal_payments_insert_rls" on public.client_renewal_payments
for insert to authenticated
with check (
  recorded_by = public.app_user_id()
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  )
);

grant select, insert on public.client_renewal_payments to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-renewal-payments',
  'client-renewal-payments',
  false,
  20971520,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg', 'image/png', 'image/webp'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "client_renewal_payments_objects_select_rls" on storage.objects
for select to authenticated
using (
  bucket_id = 'client-renewal-payments'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
  )
);

create policy "client_renewal_payments_objects_insert_rls" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'client-renewal-payments'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
  )
);

-- clients.renewal_value: the agreed value for the CURRENT/upcoming renewal cycle. Set (or
-- overwritten) by record_client_renewal_payment on every payment logged for that cycle — kept on
-- clients rather than only ever read off the payments table so the Renewals page can show/filter
-- on it even before any payment has been made yet.
alter table public.clients add column renewal_value numeric;

-- clients has a column-level SELECT allowlist for `authenticated` (see
-- 20261030500000_protect_client_access_columns.sql) instead of a blanket grant — any new column
-- is unreadable until explicitly added here. Missing this exact step for design_drive_link broke
-- task creation for some employees (20270112000000_fix_design_drive_link_select_grant.sql);
-- granting it in the same migration that adds the column avoids repeating that gap.
grant select (renewal_value) on public.clients to authenticated;

commit;
