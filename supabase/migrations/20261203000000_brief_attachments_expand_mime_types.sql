-- Widens the brief-attachments Storage bucket's allowed_mime_types (first set by
-- 20261130000000_brief_attachments.sql) to also accept Excel/PowerPoint files and HEIC/HEIF
-- photos (the default format for an iPhone's own camera) — requested directly after an AM Team
-- Lead's real upload attempt was rejected by the bucket's original, narrower allowlist
-- (PDF/Word/jpg/png/webp only). No RLS or role-gate change here at all — same policies, same
-- roles, just a wider set of file types they may upload. Frontend's own
-- BRIEF_ATTACHMENT_ALLOWED_MIME_TYPES (src/lib/briefAttachments.ts) is updated to match in the
-- same PR, so client-side validation and the bucket's own server-side enforcement stay in sync.
begin;

update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
]
where id = 'brief-attachments';

commit;
