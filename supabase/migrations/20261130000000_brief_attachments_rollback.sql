-- Rollback for 20261130000000_brief_attachments.sql.
-- Drops the storage policies, bucket, table policies, and table, in reverse order. The bucket
-- itself is removed only if empty (storage.buckets has no FK forcing cascade here) — any objects
-- still in 'brief-attachments' must be deleted first, or this migration's bucket delete is skipped
-- by Supabase and must be cleared manually via the Storage UI before re-running.
begin;

drop policy if exists "brief_attachments_objects_delete_rls" on storage.objects;
drop policy if exists "brief_attachments_objects_insert_rls" on storage.objects;
drop policy if exists "brief_attachments_objects_select_rls" on storage.objects;

delete from storage.buckets where id = 'brief-attachments';

drop policy if exists "brief_attachments_delete_rls" on public.brief_attachments;
drop policy if exists "brief_attachments_insert_rls" on public.brief_attachments;
drop policy if exists "brief_attachments_select_rls" on public.brief_attachments;

drop table if exists public.brief_attachments;

commit;
