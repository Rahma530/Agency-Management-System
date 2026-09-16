-- ============================================================================
-- Real-time features, Phase 1: notifications, activities, chat_messages.
-- ============================================================================
--
-- Additive only — three brand-new tables, nothing existing touched. NOT a
-- canonical rebuild: real employee/client data already exists in production,
-- so this (like every migration since v4) only adds alongside it.
--
-- Frontend already has NotificationRecord/ActivityRecord/ChatMessageRecord
-- (types/database.ts) and consumers (NotificationBell.tsx, LiveActivityFeed.tsx,
-- MiniChat.tsx) built ahead of the schema, currently running on in-memory demo
-- state only (App.tsx's initial useState seed data) — this migration is what
-- lets them run against real Postgres. Wiring the frontend to actually read/
-- write these tables, and turning on Realtime subscriptions client-side, is a
-- later phase; this migration only adds the publication membership so that
-- subscription work has something to attach to.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. notifications — per-user inbox. sender_id is nullable: null means the
--    notification is system-generated (no human sender to attribute it to).
-- ----------------------------------------------------------------------------
create table public.notifications (
  id text primary key,
  user_id text not null references public.users (id),
  title text not null,
  message text not null,
  sender_id text references public.users (id),
  is_read boolean not null default false,
  type text not null check (type in ('task_assigned', 'task_updated', 'task_overdue', 'general')),
  link_url text,
  created_at timestamptz not null default now()
);

create index idx_notifications_user_id on public.notifications (user_id);

alter table public.notifications enable row level security;

-- Recipient only — a notification is never visible to anyone but the person
-- it was sent to, not even its sender.
create policy "notifications_select_rls" on public.notifications
for select to authenticated
using (user_id = public.app_user_id());

-- Recipient only, same reasoning — this is how a user marks their own
-- notification read.
create policy "notifications_update_rls" on public.notifications
for update to authenticated
using (user_id = public.app_user_id())
with check (user_id = public.app_user_id());

-- Anyone authenticated may create a notification FOR someone else (that's the
-- point — notifying a teammate), but may only attribute it to themselves as
-- sender, or leave it unattributed (system-generated).
create policy "notifications_insert_rls" on public.notifications
for insert to authenticated
with check (sender_id = public.app_user_id() or sender_id is null);

-- No delete policy — notifications are dismissed via is_read, not removed.

grant select, insert, update on public.notifications to authenticated;

-- ----------------------------------------------------------------------------
-- 2. activities — append-only org-wide activity log. Read access is
--    Executive/Head of Technical only (a cross-team feed of everyone's
--    actions is exactly the oversight view those two roles already get
--    everywhere else); everyone may still write their OWN activity entries so
--    the log has something to show once read access is opened up further in
--    a later phase.
-- ----------------------------------------------------------------------------
create table public.activities (
  id text primary key,
  user_id text not null references public.users (id),
  action_type text not null check (action_type in ('create', 'update', 'delete', 'complete', 'status_change')),
  target_type text not null check (target_type in ('task', 'client', 'campaign', 'brief')),
  target_id text not null,
  target_name text not null,
  details text,
  created_at timestamptz not null default now()
);

create index idx_activities_user_id on public.activities (user_id);
create index idx_activities_created_at on public.activities (created_at desc);

alter table public.activities enable row level security;

create policy "activities_select_rls" on public.activities
for select to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical'));

create policy "activities_insert_rls" on public.activities
for insert to authenticated
with check (user_id = public.app_user_id());

-- No update/delete policy — append-only audit trail.

grant select, insert, update on public.activities to authenticated;

-- ----------------------------------------------------------------------------
-- 3. chat_messages — direct messages between two users. Deliberately
--    unscoped by role/team on who can message whom, matching the agreed
--    Phase 1 design; a sender may only post as themselves, and either party
--    to a conversation can see it. update is for the receiver marking a
--    message read.
-- ----------------------------------------------------------------------------
create table public.chat_messages (
  id text primary key,
  sender_id text not null references public.users (id),
  receiver_id text not null references public.users (id),
  content text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_chat_messages_sender_id on public.chat_messages (sender_id);
create index idx_chat_messages_receiver_id on public.chat_messages (receiver_id);

alter table public.chat_messages enable row level security;

create policy "chat_messages_select_rls" on public.chat_messages
for select to authenticated
using (sender_id = public.app_user_id() or receiver_id = public.app_user_id());

create policy "chat_messages_insert_rls" on public.chat_messages
for insert to authenticated
with check (sender_id = public.app_user_id());

create policy "chat_messages_update_rls" on public.chat_messages
for update to authenticated
using (receiver_id = public.app_user_id())
with check (receiver_id = public.app_user_id());

-- No delete policy.

grant select, insert, update on public.chat_messages to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Realtime: add all three to the default publication so a later phase can
--    subscribe to them client-side. RLS above still applies to what a given
--    subscriber actually receives.
-- ----------------------------------------------------------------------------
alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.activities;
alter publication supabase_realtime add table public.chat_messages;

commit;
