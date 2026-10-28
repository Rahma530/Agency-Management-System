-- Adds file attachments (images, PDFs, docs, video) to daily work logs (public.daily_logs), for
-- whoever is submitting the log — same established metadata-table + private-Storage-bucket shape
-- as task_attachments/client_contracts/brief_attachments, at daily_log grain.
--
-- SELECT visibility deliberately does NOT duplicate daily_logs_select_rls's predicate (it's grown
-- a department-by-department branch over several migrations —
-- 20261028100000_daily_logs_report_scope_visibility.sql,
-- 20261123000000_daily_logs_department_team_lead_visibility.sql — and copying it here would drift
-- out of sync the next time it changes). Instead this just re-selects from public.daily_logs
-- inside the policy's own EXISTS subquery: that re-select runs under the SAME calling role, so
-- Postgres applies daily_logs' own current RLS to it automatically — whoever can see a given
-- daily_logs row can see that row's attachments, always in sync with whatever
-- daily_logs_select_rls currently says, with zero duplication.
--
-- INSERT is narrower on purpose: only the log's own author may attach a file to it (matches "the
-- person filling in today's log can attach evidence to their own entry"), not the wider read
-- visibility above. DELETE is uploader-only, same reasoning task_attachments' own header gives: a
-- deleted file is often unrecoverable, so this is stricter than read/upload.
--
-- storage.objects.name is qualified explicitly (never bare `name`) — see
-- 20261106000000_storage_lockdown.sql's header for the name-shadowing bug this schema already hit
-- once from an unqualified reference inside a storage policy's own subquery.
--
-- Delete ordering: same as client_contracts/brief_attachments — the storage.objects delete policy
-- below is keyed off the still-existing daily_log_attachments metadata row (via storage_path), so
-- the frontend must call Storage .remove() BEFORE deleting the daily_log_attachments row.
begin;

create table public.daily_log_attachments (
  id text primary key,
  daily_log_id text not null references public.daily_logs (id) on delete cascade,
  storage_path text not null,
  filename text not null,
  file_size bigint not null,
  mime_type text not null,
  uploaded_by text not null references public.users (id),
  uploaded_at timestamptz not null default now()
);

create index idx_daily_log_attachments_daily_log_id on public.daily_log_attachments (daily_log_id);

alter table public.daily_log_attachments enable row level security;

create policy "daily_log_attachments_select_rls" on public.daily_log_attachments
for select to authenticated
using (
  exists (
    select 1 from public.daily_logs dl
    where dl.id = daily_log_attachments.daily_log_id
  )
);

create policy "daily_log_attachments_insert_rls" on public.daily_log_attachments
for insert to authenticated
with check (
  uploaded_by = public.app_user_id()
  and exists (
    select 1 from public.daily_logs dl
    where dl.id = daily_log_attachments.daily_log_id
      and dl.user_id = public.app_user_id()
  )
);

create policy "daily_log_attachments_delete_rls" on public.daily_log_attachments
for delete to authenticated
using (uploaded_by = public.app_user_id());

grant select, insert, delete on public.daily_log_attachments to authenticated;

-- Private bucket, folder-per-log (first path segment is daily_log_id, matched by the storage
-- policies below). 50MB cap, same allowed types as task_attachments (images/docs/office/video).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'daily-log-attachments',
  'daily-log-attachments',
  false,
  52428800,
  array[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/csv', 'text/plain',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "daily_log_attachments_objects_select_rls" on storage.objects
for select to authenticated
using (
  bucket_id = 'daily-log-attachments'
  and exists (
    select 1 from public.daily_logs dl
    where dl.id = (storage.foldername(storage.objects.name))[1]
  )
);

create policy "daily_log_attachments_objects_insert_rls" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'daily-log-attachments'
  and exists (
    select 1 from public.daily_logs dl
    where dl.id = (storage.foldername(storage.objects.name))[1]
      and dl.user_id = public.app_user_id()
  )
);

-- DELETE — keyed off the still-existing daily_log_attachments metadata row (storage_path), same
-- pattern as client_contracts/brief_attachments. See header: Storage .remove() must run BEFORE
-- the daily_log_attachments row is deleted.
create policy "daily_log_attachments_objects_delete_rls" on storage.objects
for delete to authenticated
using (
  bucket_id = 'daily-log-attachments'
  and exists (
    select 1 from public.daily_log_attachments a
    where a.storage_path = storage.objects.name
      and a.uploaded_by = public.app_user_id()
  )
);

commit;
