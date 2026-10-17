-- Additive RLS policy only: activities_select_task_participants — lets anyone who can see a task
-- (via task_visible_v2, the same door tasks/task_assignees/task_events already use) also see that
-- task's own public.activities rows, so the "Older history" section in Task Details' History tab
-- (TaskHistoryTab.tsx) can show it to every participant, not just executive/head_of_technical.
--
-- Facts below were confirmed live on production before writing this — not assumed, not copied
-- from older migrations in this repo, which have drifted from production before (see
-- 20261115000000_daily_task_target.sql's own header for that precedent):
--   - public.activities has exactly two existing policies: activities_select_rls (select,
--     executive/head_of_technical only) and activities_insert_rls (insert, with check
--     user_id = app_user_id()).
--   - activities columns: id, user_id, action_type, target_type, target_id (text), target_name,
--     details, created_at.
--   - task_visible_v2(p_task_id text) is the live visibility function.
--
-- This is a SECOND, additional permissive policy for the same command (select) — Postgres RLS
-- ORs every permissive policy for a given command together, so activities_select_rls keeps
-- working completely unchanged (an admin still sees every activity row, task or not, through
-- that policy on its own) and this one only ever widens access for a non-admin, never narrows
-- anything. Neither existing policy, nor any grant, nor any column is touched.
begin;

create policy "activities_select_task_participants" on public.activities
for select to authenticated
using (
  target_type = 'task'
  and public.task_visible_v2(target_id)
);

commit;
