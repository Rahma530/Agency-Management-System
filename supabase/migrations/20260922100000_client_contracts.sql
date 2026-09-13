-- ============================================================================
-- Module 12, Phase 6: Sales contract upload.
-- ============================================================================
--
-- Reuses the task_attachments Storage pattern (metadata table + a matching
-- private bucket, folder-per-parent-record) from Module 4, at client grain
-- instead of task grain — the same shape meeting-recordings already uses.
--
-- Visibility mirrors clients.contract_value exactly (canSeeContractValue in
-- lib/permissions.ts): executive/head_of_technical/am_team_lead/am_agent see
-- every contract; sales only their own clients'. Upload is narrower — only
-- the client's own sales_owner_id, since Sales is who actually signs clients.
-- ============================================================================

begin;

create table public.client_contracts (
  id text primary key,
  client_id text not null references public.clients (id),
  storage_path text not null,
  filename text not null,
  file_size bigint not null,
  mime_type text not null,
  uploaded_by text not null references public.users (id),
  uploaded_at timestamptz not null default now()
);

create index idx_client_contracts_client_id on public.client_contracts (client_id);

alter table public.client_contracts enable row level security;

create policy "client_contracts_select_rls" on public.client_contracts
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (
    public.app_user_role() = 'sales'
    and exists (
      select 1 from public.clients c
      where c.id = client_contracts.client_id and c.sales_owner_id = public.app_user_id()
    )
  )
);

create policy "client_contracts_insert_rls" on public.client_contracts
for insert to authenticated
with check (
  uploaded_by = public.app_user_id()
  and public.app_user_role() = 'sales'
  and exists (
    select 1 from public.clients c
    where c.id = client_id and c.sales_owner_id = public.app_user_id()
  )
);

create policy "client_contracts_delete_rls" on public.client_contracts
for delete to authenticated
using (uploaded_by = public.app_user_id());

grant select, insert, delete on public.client_contracts to authenticated;

-- Private bucket, folder-per-client (same convention as meeting-recordings: first path
-- segment is client_id, which the storage.objects policies below join against).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-contracts',
  'client-contracts',
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

create policy "client_contracts_objects_select_rls" on storage.objects
for select to authenticated
using (
  bucket_id = 'client-contracts'
  and (
    public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
    or exists (
      select 1 from public.clients c
      where c.id = (storage.foldername(name))[1] and c.sales_owner_id = public.app_user_id()
    )
  )
);

create policy "client_contracts_objects_insert_rls" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'client-contracts'
  and exists (
    select 1 from public.clients c
    where c.id = (storage.foldername(name))[1] and c.sales_owner_id = public.app_user_id()
  )
);

create policy "client_contracts_objects_delete_rls" on storage.objects
for delete to authenticated
using (
  bucket_id = 'client-contracts'
  and exists (
    select 1 from public.client_contracts cc
    where cc.storage_path = storage.objects.name
      and cc.uploaded_by = public.app_user_id()
  )
);

commit;
