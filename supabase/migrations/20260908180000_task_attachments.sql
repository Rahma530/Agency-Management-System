-- ============================================================================
-- Task Board Phase 6 (final): file attachments on a task.
-- ============================================================================
--
-- 1. storage.buckets — NEW private bucket 'task-attachments'. public=false
--    is the whole point: task content follows the same task_visible() rules
--    as everything else in this app, and a public bucket would bypass that
--    entirely for anyone holding a link. allowed_mime_types and
--    file_size_limit are enforced by Storage itself server-side (not just a
--    client-side check that a crafted request could skip) — images, common
--    office/document formats, and video (mp4/mov/webm/m4v, for creative
--    team review) per sign-off; 52428800 bytes = 50MB per file.
--
-- 2. public.task_attachments — NEW metadata table (the bytes live in
--    Storage, this just indexes them). Visibility/insert mirror
--    task_comments exactly: joined live to public.tasks by task_id (never
--    denormalized — a task's assigned_to can change after an attachment
--    already exists, and a denormalized copy would silently go stale).
--    Delete is uploader-only, NOT task_visible()-wide — a deleted file is
--    often unrecoverable (unlike a status change), so this is deliberately
--    stricter than view/upload, same reasoning already applied to comment
--    edit/delete. Unlike task_comments, there's nothing that references an
--    attachment as a parent, so this is a real DELETE, not a soft-delete.
--
-- 3. storage.objects RLS, scoped to the task-attachments bucket only. The
--    object path convention is "{task_id}/{attachment_id}-{sanitized
--    filename}" (enforced app-side — see src/lib/supabase.ts's
--    sanitizeAttachmentFilename), so storage.foldername(name) reliably
--    yields the task_id as the first path segment; policies join that to
--    public.tasks the same way task_attachments' own policies do.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Bucket
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'task-attachments',
  'task-attachments',
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

-- ----------------------------------------------------------------------------
-- 2. task_attachments
-- ----------------------------------------------------------------------------
create table if not exists public.task_attachments (
  id text primary key,
  task_id text not null references public.tasks(id),
  storage_path text not null,
  filename text not null,
  file_size bigint not null,
  mime_type text not null,
  uploaded_by text not null,
  uploaded_at timestamptz not null default now()
);

grant select, insert, delete on public.task_attachments to authenticated;

alter table public.task_attachments enable row level security;

create policy "task_attachments_select_rls" on public.task_attachments
for select
to authenticated
using (
  exists (
    select 1 from public.tasks t
    where t.id = task_attachments.task_id
      and public.task_visible(t.assigned_to, t.parent_task_id)
  )
);

create policy "task_attachments_insert_rls" on public.task_attachments
for insert
to authenticated
with check (
  uploaded_by = public.app_user_id()
  and exists (
    select 1 from public.tasks t
    where t.id = task_id
      and public.task_visible(t.assigned_to, t.parent_task_id)
  )
);

create policy "task_attachments_delete_rls" on public.task_attachments
for delete
to authenticated
using (uploaded_by = public.app_user_id());

create index if not exists idx_task_attachments_task_id on public.task_attachments (task_id);

-- ----------------------------------------------------------------------------
-- 3. storage.objects RLS for this bucket
-- ----------------------------------------------------------------------------
create policy "task_attachments_objects_select_rls" on storage.objects
for select
to authenticated
using (
  bucket_id = 'task-attachments'
  and exists (
    select 1 from public.tasks t
    where t.id = (storage.foldername(name))[1]
      and public.task_visible(t.assigned_to, t.parent_task_id)
  )
);

create policy "task_attachments_objects_insert_rls" on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'task-attachments'
  and exists (
    select 1 from public.tasks t
    where t.id = (storage.foldername(name))[1]
      and public.task_visible(t.assigned_to, t.parent_task_id)
  )
);

-- Uploader-only, mirroring task_attachments_delete_rls — checked against the
-- metadata row (which already enforces uploaded_by = caller) rather than
-- anything derivable from the object path alone.
create policy "task_attachments_objects_delete_rls" on storage.objects
for delete
to authenticated
using (
  bucket_id = 'task-attachments'
  and exists (
    select 1 from public.task_attachments a
    where a.storage_path = storage.objects.name
      and a.uploaded_by = public.app_user_id()
  )
);

commit;
