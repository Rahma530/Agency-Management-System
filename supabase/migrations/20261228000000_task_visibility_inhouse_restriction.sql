-- Inhouse module, step 1 of 2 (schema/RLS only — no frontend change in this migration).
--
-- Owner's explicit request (2026-11-02): an Inhouse task (its client is Kesraa or Fast Growth,
-- i.e. public.clients.is_inhouse = true) must NOT be visible to a team lead or AM agent who'd
-- otherwise see it only because of a team/client match — e.g. the am_team_lead branch of
-- task_visible_v2 ("creator or assignee is on my team") or the am_agent branch ("I manage this
-- client"). It should be visible ONLY to: executive / head_of_technical / marketing_manager
-- (unconditionally, same as today), OR the task's own creator/assignee (same as today, so a
-- Creative/Video/Programming employee still sees their own Inhouse tasks normally in their own
-- My Work / Task Board — nothing changes for them).
--
-- ai_engineer is deliberately LEFT ALONE here: today it sits in the same "always visible" admin
-- branch as executive/head_of_technical, and the owner's request named only Team Lead/AM Agent as
-- the doors to close, not a request to touch ai_engineer's existing blanket visibility. If that's
-- wrong, it's a one-line follow-up (move ai_engineer out of the admin branch below), not a design
-- change — flagged in the PR body rather than guessed at here.
--
-- marketing_manager is also left alone: its own door (creator/assignee holds role
-- graphic_designer/video_editor) already matches exactly what the Inhouse module needs it to see
-- (Creative & Video work), and the owner's own list of "who should still see Inhouse tasks in the
-- aggregate view" explicitly includes marketing_manager — so that branch must NOT gain the new
-- guard the team-lead/am_agent branches get below.
--
-- Mechanics: task_visible_v2(p_task_id) is CREATE OR REPLACE'd (same signature, same grants —
-- nothing else about it changes) with one addition: the CTE now also resolves whether the task's
-- own client is_inhouse, and the am_team_lead/media_buying_team_lead/seo_team_lead/
-- social_media_team_lead branch (including its seo_team_lead-specific Programming carve-out) and
-- the am_agent branch are each additionally guarded with "and not t.is_inhouse". Every other
-- branch (admin roles, creator, assignee, marketing_manager, parent-task inheritance) is copied
-- unchanged from 20261104000000_task_visibility_functions.sql.
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
      public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
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

-- Grants are unchanged from the original (CREATE OR REPLACE keeps existing grants in Postgres,
-- but re-stating them is cheap and keeps this migration self-contained/independently readable).
revoke all on function public.task_visible_v2(text) from public, anon;
grant execute on function public.task_visible_v2(text) to authenticated;

commit;
