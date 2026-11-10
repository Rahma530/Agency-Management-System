-- Owner's explicit request (2026-11-10): ai_engineer should NOT see every task in the system —
-- only tasks they created themselves, or tasks they were assigned to.
--
-- This is exactly the follow-up 20261228000000_task_visibility_inhouse_restriction.sql's own
-- header flagged as an open question it deliberately did not decide on its own: "ai_engineer is
-- deliberately LEFT ALONE here: today it sits in the same 'always visible' admin branch as
-- executive/head_of_technical ... If that's wrong, it's a one-line follow-up (move ai_engineer
-- out of the admin branch below), not a design change." The owner has now answered it.
--
-- Mechanics: task_visible_v2(p_task_id) is CREATE OR REPLACE'd (same signature, same grants —
-- restated below for a self-contained migration, nothing else changes) with exactly one edit:
-- 'ai_engineer' is removed from the unconditional admin branch's role list (now just
-- 'executive', 'head_of_technical'). ai_engineer still sees its own tasks and tasks it's assigned
-- to via the two branches directly below that one (creator / task_assignees membership — both
-- already present, unconditional, and not role-gated), plus parent-task inheritance when
-- applicable. Nothing else in the function changes; the am_team_lead/am_agent/marketing_manager/
-- is_inhouse logic from 20261228000000 is carried forward unchanged.
--
-- tasks_select_rls itself (20261104100000_task_visibility_cutover.sql: "created_by = caller OR
-- task_visible_v2(id)") is untouched and needs no change — its own inline creator carve-out
-- already matches "tasks they created", and task_visible_v2's own creator/assignee branches cover
-- the rest; removing ai_engineer from the admin branch is sufficient on its own.
begin;

create or replace function public.task_visible_v2(p_task_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (
    select
      tk.id,
      tk.created_by,
      tk.client_id,
      tk.parent_task_id,
      coalesce(c.is_inhouse, false) as is_inhouse
    from public.tasks tk
    left join public.clients c on c.id = tk.client_id
    where tk.id = p_task_id
  )
  select
    public.app_user_role() <> 'sales'
    and exists (select 1 from t)
    and (
      public.app_user_role() in ('executive', 'head_of_technical')
      or exists (select 1 from t where t.created_by = public.app_user_id())
      or exists (
        select 1 from public.task_assignees ta
        where ta.task_id = p_task_id and ta.user_id = public.app_user_id()
      )
      or (
        public.app_user_role() in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
        and not exists (select 1 from t where t.is_inhouse)
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
        and not exists (select 1 from t where t.is_inhouse)
        and exists (select 1 from t where t.client_id is not null and public.client_am_agent_is_caller(t.client_id))
      )
      or (
        public.app_user_role() = 'marketing_manager'
        and (
          exists (select 1 from t where t.is_inhouse)
          or exists (select 1 from t join public.users u on u.id = t.created_by where u.role in ('graphic_designer', 'video_editor'))
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

revoke all on function public.task_visible_v2(text) from public, anon;
grant execute on function public.task_visible_v2(text) to authenticated;

commit;
