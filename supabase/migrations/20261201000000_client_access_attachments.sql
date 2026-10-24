-- Adds file attachments (ID/visa images, PDFs, etc.) to a client's "Client Access" data — the
-- same 10 protected columns on public.clients (general_email, general_email_password,
-- store_platform_username/password, social_media_username/password, ad_account_username/password,
-- ad_account_setup_type, payment_card_details) locked down by
-- 20261030500000_protect_client_access_columns.sql.
--
-- Same lockdown posture, carried over exactly:
-- 1. public.client_access_attachments gets RLS enabled but NO select/insert/delete policy for
--    `authenticated` at all, and NO table-level grant to `authenticated` either — the ONLY path to
--    any row in this table is the 3 SECURITY DEFINER RPCs below, which run as the table owner and
--    so need no grant. This is stricter than client_access_log (which does grant select, scoped by
--    an RLS policy to 3 admin roles) because this table can hold a filename that itself leaks
--    sensitive content (e.g. "دينا - فيزا صاحب حساب الإعلانات.jpg"), not just a boolean "something
--    was accessed".
-- 2. Role gate is copied VERBATIM from get_client_access()/update_client_access()'s current body
--    (20261030500000_protect_client_access_columns.sql, untouched by the later
--    20261124000000_ai_engineer_deprivilege.sql — that migration never touched client access):
--    ai_engineer unconditionally; executive/head_of_technical/am_team_lead unconditionally;
--    am_agent only for a client where they are the assigned am_agent_id.
-- 3. get_client_access_attachments() logs to client_access_log exactly like get_client_access()
--    does — same table, same shape, logged BEFORE returning so a client-side failure after the
--    RPC responds can never suppress the log entry.
-- 4. storage.objects policies for the new 'client-access-attachments' bucket are NOT behind an
--    RPC (Storage policies can't carry a logging side effect) — they re-state the same 4-role
--    predicate directly, mirroring client_contracts_objects_select_rls's shape
--    (20261106000000_storage_lockdown.sql), with storage.objects.name qualified explicitly from
--    the start (that migration's header explains the real bug an unqualified `name` reference
--    caused elsewhere in this schema — never repeat it).
-- 5. Delete ordering: the storage.objects delete policy's predicate depends only on
--    (storage.foldername(name))[1] = client_id + the caller's role, not on the
--    client_access_attachments metadata row — so, unlike brief_attachments/task_attachments, the
--    frontend may delete the Storage object and call delete_client_access_attachment() in either
--    order without breaking RLS. Still: delete the Storage object first, then call the RPC, for
--    consistency with every other attachment feature in this schema and to avoid an orphaned
--    Storage object if the RPC call fails.
begin;

create table public.client_access_attachments (
  id text primary key,
  client_id text not null references public.clients (id),
  storage_path text not null,
  filename text not null,
  file_size bigint not null,
  mime_type text not null,
  label text,
  uploaded_by text not null references public.users (id),
  uploaded_at timestamptz not null default now()
);

create index idx_client_access_attachments_client_id on public.client_access_attachments (client_id);

alter table public.client_access_attachments enable row level security;
-- Deliberately no policy created here, and no table-level grant issued below — see header, point 1.

-- 1. get_client_access_attachments(): the only way the metadata rows (filenames, labels) for a
--    client's Client Access attachments ever reach the browser.
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
  v_client public.clients;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to view this client''s access attachments.';
  end if;

  insert into public.client_access_log (client_id, accessed_by)
  values (p_client_id, public.app_user_id());

  return query
    select caa.id, caa.storage_path, caa.filename, caa.file_size, caa.mime_type, caa.label,
           caa.uploaded_by, caa.uploaded_at
    from public.client_access_attachments caa
    where caa.client_id = p_client_id
    order by caa.uploaded_at desc;
end;
$$;

revoke execute on function public.get_client_access_attachments(text) from public, anon;
grant execute on function public.get_client_access_attachments(text) to authenticated, service_role;

-- 2. insert_client_access_attachment(): the only way a row is ever added. Same gate as
--    update_client_access(). Returns the new row's id.
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
  v_id text;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client not found';
  end if;

  if not (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to upload an access attachment for this client.';
  end if;

  v_id := 'cxa-' || replace(gen_random_uuid()::text, '-', '');

  insert into public.client_access_attachments
    (id, client_id, storage_path, filename, file_size, mime_type, label, uploaded_by)
  values
    (v_id, p_client_id, p_storage_path, p_filename, p_file_size, p_mime_type, p_label, public.app_user_id());

  return v_id;
end;
$$;

revoke execute on function public.insert_client_access_attachment(text, text, text, bigint, text, text) from public, anon;
grant execute on function public.insert_client_access_attachment(text, text, text, bigint, text, text) to authenticated, service_role;

-- 3. delete_client_access_attachment(): resolves client_id from the row itself before gating, so
--    the caller only ever supplies the attachment id. Frontend deletes the Storage object first
--    (see header, point 5), then calls this to remove the metadata row.
create or replace function public.delete_client_access_attachment(p_attachment_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.client_access_attachments;
  v_client public.clients;
begin
  select * into v_row from public.client_access_attachments where id = p_attachment_id;
  if not found then
    raise exception 'Attachment not found';
  end if;

  select * into v_client from public.clients where id = v_row.client_id;

  if not (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
    raise exception 'You do not have permission to delete this client''s access attachment.';
  end if;

  delete from public.client_access_attachments where id = p_attachment_id;
end;
$$;

revoke execute on function public.delete_client_access_attachment(text) from public, anon;
grant execute on function public.delete_client_access_attachment(text) to authenticated, service_role;

-- Private bucket, folder-per-client. 10MB cap (ID/visa photos and short PDFs only).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-access-attachments',
  'client-access-attachments',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "client_access_attachments_objects_select_rls" on storage.objects
for select to authenticated
using (
  bucket_id = 'client-access-attachments'
  and (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(storage.objects.name))[1])
  )
);

create policy "client_access_attachments_objects_insert_rls" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'client-access-attachments'
  and (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(storage.objects.name))[1])
  )
);

create policy "client_access_attachments_objects_delete_rls" on storage.objects
for delete to authenticated
using (
  bucket_id = 'client-access-attachments'
  and (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(storage.objects.name))[1])
  )
);

commit;
