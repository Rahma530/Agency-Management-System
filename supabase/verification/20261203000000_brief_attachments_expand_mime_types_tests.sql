-- Verifies 20261203000000_brief_attachments_expand_mime_types.sql applied correctly. Read-only
-- (a plain SELECT against storage.buckets, no fabricated rows), so there is nothing to roll back —
-- unlike this project's other verification scripts, which wrap real inserts/updates in a
-- transaction specifically so they can be discarded. The "TEST_OK" exception at the end is still
-- the success signal to look for, same convention as every other verification script here.
do $$
declare
  v_types text[];
  v_expected_new text[] := array[
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/heic',
    'image/heif'
  ];
  v_expected_original text[] := array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg', 'image/png', 'image/webp'
  ];
begin
  select allowed_mime_types into v_types from storage.buckets where id = 'brief-attachments';

  if v_types is null then
    raise exception 'brief-attachments bucket does not exist.';
  end if;

  if not (v_types @> v_expected_new) then
    raise exception 'brief-attachments bucket is missing one or more of the new mime types. Current: %', v_types;
  end if;

  if not (v_types @> v_expected_original) then
    raise exception 'brief-attachments bucket lost one or more of its original mime types. Current: %', v_types;
  end if;

  raise exception 'TEST_OK: brief-attachments bucket now allows Excel/PowerPoint/HEIC-HEIF alongside the original PDF/Word/jpg/png/webp types. Current allowed_mime_types: %', v_types;
end $$;
