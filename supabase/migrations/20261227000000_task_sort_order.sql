-- Manual drag-and-drop reorder for the Task Kanban board (CrossTeamTaskBoard.tsx, 2026-11-02),
-- same feature already shipped for the Client Portfolio board (PR #267/#268) — dragging a task
-- onto another task in the SAME status column reorders them; dragging onto a different column
-- still just changes status, as it already did.
--
-- Unlike clients.is_inhouse/sort_order (20261226000000_client_inhouse_and_sort_order.sql),
-- public.tasks has a blanket (not column-level) SELECT grant — 20260907090000_table_grants.sql's
-- `grant select, insert, update on public.tasks to authenticated` — so no separate grant
-- statement is needed here; the new column is readable the moment it exists.

begin;

alter table public.tasks
  add column sort_order integer;

commit;
