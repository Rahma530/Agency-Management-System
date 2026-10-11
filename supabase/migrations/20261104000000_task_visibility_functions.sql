-- PR 2 of the task-assignees project, step 1 — PURELY ADDITIVE. No existing function, policy,
-- trigger, or grant is touched. The old task_visible(text, text, text) is left completely alone
-- and nothing yet calls the two new functions below, so applying this migration changes nothing
-- any caller can observe. The actual cutover (rewriting every policy to call these instead of the
-- old function) is a separate migration, 20261104100000_task_visibility_cutover.sql, so that this
-- step can be applied and inspected in isolation first.
--
-- Rules implemented by task_visible_v2 (final, as agreed):
--   - sales: never visible, no exceptions.
--   - executive / head_of_technical / ai_engineer (admin): always visible.
--   - creator (tasks.created_by = caller): visible.
--   - any assignee (a row in task_assignees for this task + caller): visible.
--   - the 4 built-in *_team_lead roles: visible if the task's creator OR any assignee is in the
--     caller's own team (users.team = app_user_team()), PLUS a dedicated seo_team_lead carve-out
--     also matching team = 'Programming' — mirroring the existing seo_team_lead/programming_agent
--     direct-report relationship already encoded in employee_visible()/direct_report_visible(), not
--     a new relationship invented here.
--   - am_agent: visible on any task whose client is one they manage (client_am_agent_is_caller),
--     independent of assignee/creator — this door is intentionally assignee-agnostic (AM oversight
--     of a whole client, not just their own tasks on it).
--   - marketing_manager: visible if the task's creator OR any assignee holds role
--     graphic_designer or video_editor.
--   - parent-task inheritance: a task is visible if its parent_task_id task is visible (recursive;
--     terminates via the existing 3-level nesting-depth trigger, same bound as the old function).
--
-- A task with zero assignees falls out of the above with no special-casing needed: it's visible to
-- its creator, to admins, and to a team lead whose team matches the CREATOR's team (the
-- assignee-side OR branch is simply vacuously false with no task_assignees rows) — never to an
-- ordinary agent who is neither. The am_agent and marketing_manager doors are independent of
-- assignee count by design, so they apply the same way regardless.
--
-- task_closable implements "who may close a task": the creator, any assignee, or an admin role.
begin;

-- ----------------------------------------------------------------------------
-- 1. task_visible_v2(p_task_id) — single-argument replacement for task_visible(text,text,text).
--    Takes the task id and resolves created_by/client_id/parent_task_id itself via a CTE (one
--    lookup of the row, reused by every branch below) rather than requiring the caller to pass
--    three positional columns.
-- ----------------------------------------------------------------------------
create or replace function public.task_visible_v2(p_task_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (
    select id, created_by, client_id, parent_task_id
    from public.tasks
    where id = p_task_id
  )
  select
    public.app_user_role() <> 'sales'
    and exists (select 1 from t)
    and (
      public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
      or exists (select 1 from t where t.created_by = public.app_user_id())
      or exists (
        select 1 from public.task_assignees ta
        where ta.task_id = p_task_id and ta.user_id = public.app_user_id()
      )
      or (
        public.app_user_role() in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
        and (
          exists (select 1 from t join public.users u on u.id = t.created_by where u.team = public.app_user_team())
          or exists (
            select 1 from public.task_assignees ta
            join public.users u on u.id = ta.user_id
            where ta.task_id = p_task_id and u.team = public.app_user_team()
          )
          or (
            public.app_user_role() = 'seo_team_lead'
            and (
              exists (select 1 from t join public.users u on u.id = t.created_by where u.team = 'Programming')
              or exists (
                select 1 from public.task_assignees ta
                join public.users u on u.id = ta.user_id
                where ta.task_id = p_task_id and u.team = 'Programming'
              )
            )
          )
        )
      )
      or (
        public.app_user_role() = 'am_agent'
        and exists (select 1 from t where t.client_id is not null and public.client_am_agent_is_caller(t.client_id))
      )
      or (
        public.app_user_role() = 'marketing_manager'
        and (
          exists (select 1 from t join public.users u on u.id = t.created_by where u.role in ('graphic_designer', 'video_editor'))
          or exists (
            select 1 from public.task_assignees ta
            join public.users u on u.id = ta.user_id
            where ta.task_id = p_task_id and u.role in ('graphic_designer', 'video_editor')
          )
        )
      )
      or exists (
        select 1 from t where t.parent_task_id is not null and public.task_visible_v2(t.parent_task_id)
      )
    );
$$;

-- ----------------------------------------------------------------------------
-- 2. task_closable(p_task_id) — the creator, any assignee, or an admin role may close a task.
-- ----------------------------------------------------------------------------
create or replace function public.task_closable(p_task_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
    or exists (select 1 from public.tasks t where t.id = p_task_id and t.created_by = public.app_user_id())
    or exists (
      select 1 from public.task_assignees ta
      where ta.task_id = p_task_id and ta.user_id = public.app_user_id()
    );
$$;

-- ----------------------------------------------------------------------------
-- 3. Indexes — tasks.created_by and tasks.client_id are read by name (not just assigned_to) by
--    both functions above and by clients_select_rls/employee_visible()'s task-derived branches,
--    and neither had an index before this (only assigned_to, parent_task_id, batch_id did).
-- ----------------------------------------------------------------------------
create index if not exists idx_tasks_created_by on public.tasks (created_by);
create index if not exists idx_tasks_client_id on public.tasks (client_id);

-- ----------------------------------------------------------------------------
-- 4. Grants — default privileges are revoked in this project, so these must be explicit. No other
--    grant anywhere is touched.
-- ----------------------------------------------------------------------------
revoke all on function public.task_visible_v2(text) from public, anon;
grant execute on function public.task_visible_v2(text) to authenticated;

revoke all on function public.task_closable(text) from public, anon;
grant execute on function public.task_closable(text) to authenticated;

commit;
