-- HOTFIX (2026-11-17): create_task_copy() (20270111000000_task_design_drive_link.sql) started
-- failing for any task linked to a real client with "permission denied for column
-- design_drive_link of relation clients" — because 20261030500000_protect_client_access_columns.sql
-- replaced the old blanket `grant select on public.clients to authenticated` with an explicit,
-- named column-level grant, and clients.design_drive_link (added later, by
-- 20270110000000_client_design_drive_link.sql) was never added to that list. That migration's own
-- closing comment says exactly this: "any new column added to public.clients in the future must be
-- added to the grant ... forgetting to do so means the new column is simply unreadable by
-- `authenticated` at all" — missed here. create_task_copy() is `security invoker`, so it runs with
-- the calling (authenticated) user's own column privileges, not elevated ones, and hit this
-- immediately for every client-linked task creation.
--
-- design_drive_link is not one of the 10 sensitive "Client Access" columns that migration was
-- protecting (those stay exactly as restricted as before) — it's an ordinary, non-sensitive field
-- (same category as the 24 already-granted columns), so this simply adds it to that same grant.
begin;

grant select (design_drive_link) on public.clients to authenticated;

commit;
