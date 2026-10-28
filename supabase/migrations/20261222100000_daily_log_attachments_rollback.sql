begin;

drop policy if exists "daily_log_attachments_objects_delete_rls" on storage.objects;
drop policy if exists "daily_log_attachments_objects_insert_rls" on storage.objects;
drop policy if exists "daily_log_attachments_objects_select_rls" on storage.objects;

delete from storage.buckets where id = 'daily-log-attachments';

drop table if exists public.daily_log_attachments;

commit;
