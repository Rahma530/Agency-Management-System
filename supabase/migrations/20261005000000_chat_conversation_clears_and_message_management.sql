-- ============================================================================
-- Per-user chat conversation clearing and sender-owned message management.
-- ============================================================================

begin;

-- A clear is directional: user_id clears only their view of messages with
-- other_user_id. Shared chat_messages rows are never removed.
create table public.chat_conversation_clears (
  user_id text not null references public.users (id),
  other_user_id text not null references public.users (id),
  cleared_at timestamptz not null default now(),
  primary key (user_id, other_user_id),
  check (user_id <> other_user_id)
);

alter table public.chat_conversation_clears enable row level security;

create policy "chat_conversation_clears_select_rls"
on public.chat_conversation_clears
for select to authenticated
using (user_id = public.app_user_id());

create policy "chat_conversation_clears_insert_rls"
on public.chat_conversation_clears
for insert to authenticated
with check (user_id = public.app_user_id());

create policy "chat_conversation_clears_update_rls"
on public.chat_conversation_clears
for update to authenticated
using (user_id = public.app_user_id())
with check (user_id = public.app_user_id());

grant select, insert, update on public.chat_conversation_clears to authenticated;

-- Allow a sender to update their own row. The trigger below limits a sender
-- to content-only edits and preserves receiver-only read-state changes.
create policy "chat_messages_sender_update_rls"
on public.chat_messages
for update to authenticated
using (sender_id = public.app_user_id())
with check (sender_id = public.app_user_id());

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

  if new.id is distinct from old.id
    or new.sender_id is distinct from old.sender_id
    or new.receiver_id is distinct from old.receiver_id
    or new.created_at is distinct from old.created_at then
    raise exception 'Chat message identity fields cannot be changed';
  end if;

  if old.sender_id = caller_id then
    if new.is_read is distinct from old.is_read then
      raise exception 'Senders may only edit message content';
    end if;
    return new;
  end if;

  if old.receiver_id = caller_id then
    if new.content is distinct from old.content or new.is_read is not true then
      raise exception 'Receivers may only mark messages as read';
    end if;
    return new;
  end if;

  raise exception 'Not permitted to update this chat message';
end;
$$;

create trigger chat_messages_enforce_update
before update on public.chat_messages
for each row
execute function public.enforce_chat_message_update();

-- A sender may delete only messages they authored.
create policy "chat_messages_sender_delete_rls"
on public.chat_messages
for delete to authenticated
using (sender_id = public.app_user_id());

grant delete on public.chat_messages to authenticated;

commit;
