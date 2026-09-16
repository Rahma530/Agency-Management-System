-- ============================================================================
-- notify_new_chat_message(): auto-create a notification for every chat message.
-- ============================================================================
--
-- A database trigger rather than a second client-side insert after
-- chat_messages — deliberately so this fires for ANY insert into
-- chat_messages regardless of which code path performs it (today's
-- MiniChat send handler, or any future feature/script), and so the message
-- insert and its notification are atomic (same transaction — either both
-- happen or neither does), rather than two separate round-trips that could
-- partially fail.
--
-- link_url uses a simple 'chat:<sender_id>' scheme (not a real app route —
-- MiniChat isn't hash-routed) that the frontend parses on notification click
-- to open that specific conversation.
-- ============================================================================

begin;

create or replace function public.notify_new_chat_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sender_name text;
begin
  select name into sender_name from public.users where id = new.sender_id;

  insert into public.notifications (id, user_id, title, message, sender_id, is_read, type, link_url, created_at)
  values (
    'notif-chat-' || new.id,
    new.receiver_id,
    'New message from ' || coalesce(sender_name, 'a colleague'),
    left(new.content, 140),
    new.sender_id,
    false,
    'general',
    'chat:' || new.sender_id,
    new.created_at
  );

  return new;
end;
$$;

create trigger chat_message_notify
after insert on public.chat_messages
for each row
execute function public.notify_new_chat_message();

commit;
