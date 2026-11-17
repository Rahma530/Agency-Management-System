-- Owner request (2026-11-17): every client that gets creative/design work needs one Drive folder
-- that every designer uploads their work into, set once by the AM on the client's own record, and
-- shown automatically on every task for that client (so a reassigned designer always has the
-- right folder, with no risk of a stale copy on an individual task going out of sync).
--
-- Deliberately a NEW column on clients, not a reuse of the already-deprecated tasks.drive_link
-- (see 20261023000000_task_done_link_and_closed_status.sql / 20261109000000_task_done_link_backfill.sql
-- — that column was task-scoped and is already being phased out in favor of done_link). This is a
-- different concept: one Drive folder per CLIENT, resolved live by client_id wherever a creative
-- task needs it (same "resolve live, never copy" pattern already used for the Creative Brief
-- preview), not copied onto individual task rows.
begin;

alter table public.clients add column if not exists design_drive_link text;

comment on column public.clients.design_drive_link is
  'Google Drive (or similar) folder link for this client''s design/creative assets, set by the AM. Resolved live wherever a creative task needs it — never copied onto individual tasks.';

commit;
