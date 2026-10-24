-- Rollback for 20261203000000_brief_attachments_expand_mime_types.sql — restores the
-- brief-attachments bucket's allowed_mime_types to its original, narrower set.
begin;

update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png', 'image/webp'
]
where id = 'brief-attachments';

commit;
