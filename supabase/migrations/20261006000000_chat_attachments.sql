-- ============================================================================
-- Chat attachments support: add attachment & reply columns to chat_messages,
-- create the chat-attachments storage bucket, and update the enforcement
-- trigger to allow the new columns.
-- ============================================================================

begin;

-- 1. Add missing columns to chat_messages
-- reply_to_id: allows replying to a specific message
-- attachment_url/name/type: for file/image attachments
alter table public.chat_messages
  add column if not exists reply_to_id text references public.chat_messages (id) on delete set null,
  add column if not exists attachment_url text,
  add column if not exists attachment_name text,
  add column if not exists attachment_type text;

-- Allow content to be empty when there's an attachment
alter table public.chat_messages
  alter column content drop not null;

-- Default content to empty string for attachment-only messages
alter table public.chat_messages
  alter column content set default '';

-- 2. Create the chat-attachments storage bucket (public, so URLs work directly)
insert into storage.buckets (id, name, public, file_size_limit)
values (
  'chat-attachments',
  'chat-attachments',
  true,
  10485760  -- 10MB
)
on conflict (id) do nothing;

-- 3. Storage RLS policies for chat-attachments bucket
-- Any authenticated user can view chat attachments (public bucket, but belt-and-suspenders)
create policy "chat_attachments_objects_select_rls" on storage.objects
for select to authenticated
using (bucket_id = 'chat-attachments');

-- Any authenticated user can upload to chat-attachments
create policy "chat_attachments_objects_insert_rls" on storage.objects
for insert to authenticated
with check (bucket_id = 'chat-attachments');

-- Only the uploader can delete their own files (path starts with their user id)
create policy "chat_attachments_objects_delete_rls" on storage.objects
for delete to authenticated
using (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = public.app_user_id()
);

-- 4. Update the enforcement trigger to allow attachment columns through
-- The existing trigger blocks changes to identity fields. We need to also
-- protect the new attachment fields from being changed after creation (only
-- content should be editable by the sender).
create or replace function public.enforce_chat_message_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id text;
begin
  caller_id := public.app_user_id();

  if caller_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Identity fields are immutable
  if new.id is distinct from old.id
    or new.sender_id is distinct from old.sender_id
    or new.receiver_id is distinct from old.receiver_id
    or new.created_at is distinct from old.created_at then
    raise exception 'Chat message identity fields cannot be changed';
  end if;

  -- Attachment fields are immutable after creation
  if new.attachment_url is distinct from old.attachment_url
    or new.attachment_name is distinct from old.attachment_name
    or new.attachment_type is distinct from old.attachment_type
    or new.reply_to_id is distinct from old.reply_to_id then
    raise exception 'Chat message attachment/reply fields cannot be changed';
  end if;

  -- Sender may only edit content
  if old.sender_id = caller_id then
    if new.is_read is distinct from old.is_read then
      raise exception 'Senders may only edit message content';
    end if;
    return new;
  end if;

  -- Receiver may only mark as read
  if old.receiver_id = caller_id then
    if new.content is distinct from old.content or new.is_read is not true then
      raise exception 'Receivers may only mark messages as read';
    end if;
    return new;
  end if;

  raise exception 'Not permitted to update this chat message';
end;
$$;

commit;
