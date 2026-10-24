-- Adds file attachments (PDFs, images, docs) to service briefs (public.briefs).
--
-- Reuses the established metadata-table + private-Storage-bucket shape (task_attachments,
-- client_contracts) at brief grain. No new role-gate concept is introduced: both the metadata
-- table's RLS and the Storage bucket's RLS mirror the CURRENT briefs_select_rls/briefs_update_rls
-- predicates (as last redefined by 20261128000000_team_lead_cross_service_brief_visibility.sql and
-- 20261124000000_ai_engineer_deprivilege.sql respectively) — read access to a brief's attachments
-- matches read access to the brief itself, and who may add/remove an attachment matches who may
-- edit the brief (briefs_update_rls / canEditServiceBrief in lib/permissions.ts).
--
-- storage.objects.name is qualified explicitly throughout (never bare `name`) — see
-- 20261106000000_storage_lockdown.sql's header for the real name-shadowing bug this schema already
-- hit once from an unqualified reference inside a storage policy's own subquery; qualifying from
-- the start here avoids repeating it.
--
-- Delete ordering: mirrors client_contracts, not task_attachments — the storage.objects delete
-- policy below is keyed off the still-existing brief_attachments metadata row (via storage_path),
-- so the frontend must call Storage .remove() BEFORE deleting the brief_attachments row (the
-- reverse order breaks this policy, exactly as task_attachments' own header documents for its own
-- owner-based delete policy).
begin;

create table public.brief_attachments (
  id text primary key,
  brief_id text not null references public.briefs (id) on delete cascade,
  storage_path text not null,
  filename text not null,
  file_size bigint not null,
  mime_type text not null,
  uploaded_by text not null references public.users (id),
  uploaded_at timestamptz not null default now()
);

create index idx_brief_attachments_brief_id on public.brief_attachments (brief_id);

alter table public.brief_attachments enable row level security;

-- SELECT — mirrors briefs_select_rls exactly (public.briefs, 20261128000000), joined via brief_id.
create policy "brief_attachments_select_rls" on public.brief_attachments
for select to authenticated
using (
  exists (
    select 1 from public.briefs b
    where b.id = brief_attachments.brief_id
      and (
        public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
        or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(b.client_id))
        or (
          public.app_user_role() in ('seo_team_lead', 'media_buying_team_lead', 'social_media_team_lead')
          and b.submitted_at is not null
        )
        or (
          public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent')
          and public.agent_assigned_any_service(b.client_id)
          and b.submitted_at is not null
        )
        or (
          public.app_user_role() in ('graphic_designer', 'video_editor')
          and b.service_type = 'creative'
          and b.submitted_by = public.app_user_id()
        )
      )
  )
);

-- INSERT/DELETE — mirrors briefs_update_rls exactly (public.briefs, 20261124000000): who may edit
-- a brief may add/remove its attachments. Narrower than the SELECT policy above on purpose (a
-- department Team Lead/agent can read a submitted brief's attachments but not add new ones).
create policy "brief_attachments_insert_rls" on public.brief_attachments
for insert to authenticated
with check (
  uploaded_by = public.app_user_id()
  and exists (
    select 1 from public.briefs b
    where b.id = brief_attachments.brief_id
      and (
        public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
        or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(b.client_id))
        or (
          public.app_user_role() in ('graphic_designer', 'video_editor')
          and b.service_type = 'creative'
          and b.submitted_by = public.app_user_id()
        )
      )
  )
);

create policy "brief_attachments_delete_rls" on public.brief_attachments
for delete to authenticated
using (
  exists (
    select 1 from public.briefs b
    where b.id = brief_attachments.brief_id
      and (
        public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
        or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(b.client_id))
        or (
          public.app_user_role() in ('graphic_designer', 'video_editor')
          and b.service_type = 'creative'
          and b.submitted_by = public.app_user_id()
        )
      )
  )
);

grant select, insert, delete on public.brief_attachments to authenticated;

-- Private bucket, folder-per-brief (first path segment is brief_id, matched by the storage
-- policies below). 20MB cap, same allowed types as client_contracts.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'brief-attachments',
  'brief-attachments',
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

create policy "brief_attachments_objects_select_rls" on storage.objects
for select to authenticated
using (
  bucket_id = 'brief-attachments'
  and exists (
    select 1 from public.briefs b
    where b.id = (storage.foldername(storage.objects.name))[1]
      and (
        public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
        or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(b.client_id))
        or (
          public.app_user_role() in ('seo_team_lead', 'media_buying_team_lead', 'social_media_team_lead')
          and b.submitted_at is not null
        )
        or (
          public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent')
          and public.agent_assigned_any_service(b.client_id)
          and b.submitted_at is not null
        )
        or (
          public.app_user_role() in ('graphic_designer', 'video_editor')
          and b.service_type = 'creative'
          and b.submitted_by = public.app_user_id()
        )
      )
  )
);

create policy "brief_attachments_objects_insert_rls" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'brief-attachments'
  and exists (
    select 1 from public.briefs b
    where b.id = (storage.foldername(storage.objects.name))[1]
      and (
        public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
        or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(b.client_id))
        or (
          public.app_user_role() in ('graphic_designer', 'video_editor')
          and b.service_type = 'creative'
          and b.submitted_by = public.app_user_id()
        )
      )
  )
);

-- DELETE — keyed off the still-existing brief_attachments metadata row (storage_path), same
-- pattern as client_contracts_objects_delete_rls. See header: Storage .remove() must run BEFORE
-- the brief_attachments row is deleted.
create policy "brief_attachments_objects_delete_rls" on storage.objects
for delete to authenticated
using (
  bucket_id = 'brief-attachments'
  and exists (
    select 1 from public.brief_attachments ba
    join public.briefs b on b.id = ba.brief_id
    where ba.storage_path = storage.objects.name
      and (
        ba.uploaded_by = public.app_user_id()
        or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
        or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(b.client_id))
      )
  )
);

commit;
