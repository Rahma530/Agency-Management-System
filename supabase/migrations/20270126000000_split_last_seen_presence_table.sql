-- Root cause of the recurring Thu-Sat CPU incident, part 2: public.users is in the
-- supabase_realtime publication (20261029000000_users_realtime.sql), so Realtime checks every
-- subscribed client's RLS against every row change on that table. touch_last_seen()
-- (20261030200000_touch_last_seen_rpc.sql) writes to users.last_seen_at every 3 minutes from
-- EVERY logged-in employee's browser (App.tsx's heartbeat effect) — each one of those writes
-- triggers every other open browser's useConsolidatedRealtimeSync entry for 'users' to refetch
-- the ENTIRE users table (filtered through employee_visible() per row). With N employees online
-- at once that's N heartbeats/3min x N full-table refetches = cost that grows with N^2, which
-- lines up with the incident being worst during Thu-Sat peak concurrency.
--
-- last_seen_at is also not actually wired to anything that reads it today: chat_directory()
-- (MiniChat's colleague list source) only ever returns id/name/role, so MiniChat's own
-- last-seen/away-dot logic (src/components/MiniChat.tsx) has been silently dead code against
-- real data since it shipped — always falling through to "غير متصل" for anyone offline. This
-- migration both stops the churn AND makes that display logic work for the first time, by moving
-- last_seen_at to its own table (never added to supabase_realtime) and having chat_directory()
-- return it.
--
-- users.last_seen_at itself is left in place (deprecated, unread from here on) rather than
-- dropped, so nothing with a stale cached schema or an in-flight request errors; a later cleanup
-- migration can drop it once confirmed unused in production for a while.
begin;

create table if not exists public.user_presence (
  user_id text primary key references public.users(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);

-- Deliberately NOT added to supabase_realtime — this table exists specifically to keep
-- high-frequency writes out of the replication stream. Direct access is locked down; the only
-- way in or out is through the two SECURITY DEFINER functions below, same pattern as
-- touch_last_seen() always used.
alter table public.user_presence enable row level security;
revoke all on public.user_presence from public, anon, authenticated;

create or replace function public.touch_last_seen()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.user_presence (user_id, last_seen_at)
  values (public.app_user_id(), now())
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at;
$$;

revoke execute on function public.touch_last_seen() from public;
revoke execute on function public.touch_last_seen() from anon;
grant execute on function public.touch_last_seen() to authenticated;
grant execute on function public.touch_last_seen() to service_role;

-- chat_directory(): same id/name/role as before, now also last_seen_at from the new table
-- instead of always-null. Still a narrow SECURITY DEFINER function — the column list is the
-- actual boundary, unchanged reasoning from 20261003100000_chat_directory_rpc.sql.
create or replace function public.chat_directory()
returns table(id text, name text, role text, last_seen_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.name, u.role, p.last_seen_at
  from public.users u
  left join public.user_presence p on p.user_id = u.id;
$$;

grant execute on function public.chat_directory() to authenticated;

commit;
