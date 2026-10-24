-- Rollback for 20261201000000_client_access_attachments.sql.
-- Drops the storage policies, bucket, RPCs, and table, in reverse order. The bucket is removed
-- only if empty — any objects still in 'client-access-attachments' must be deleted first via the
-- Storage UI, or this delete is skipped and must be cleared manually before re-running.
begin;

drop policy if exists "client_access_attachments_objects_delete_rls" on storage.objects;
drop policy if exists "client_access_attachments_objects_insert_rls" on storage.objects;
drop policy if exists "client_access_attachments_objects_select_rls" on storage.objects;

delete from storage.buckets where id = 'client-access-attachments';

drop function if exists public.delete_client_access_attachment(text);
drop function if exists public.insert_client_access_attachment(text, text, text, bigint, text, text);
drop function if exists public.get_client_access_attachments(text);

drop table if exists public.client_access_attachments;

commit;
