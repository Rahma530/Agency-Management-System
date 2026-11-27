-- Emergency production fix applied directly in the Supabase SQL Editor on 2026-11-26 during the
-- "Tasks disappeared for everyone + Inhouse tab disappeared for ai_engineer" incident. This file
-- records that live change in the repo for tracking -- it does not need to be re-run if it was
-- already applied in SQL Editor that day, but running it again is harmless (CREATE OR REPLACE,
-- same signatures, idempotent).
--
-- Root cause (confirmed, not guessed): 20270122000000_optimize_task_visibility_functions.sql
-- (2026-11-21, PR #335) reduced redundant identity lookups INSIDE task_visible_v2, but left the
-- function's structure recursive -- its last branch calls itself
-- (`... public.task_visible_v2(t.parent_task_id)`) to walk up to a visible ancestor task.
--
-- Postgres cannot inline a SQL-language function that references itself. A recursive function is
-- therefore always executed as an opaque per-row function call under RLS, never folded into the
-- surrounding query plan -- so none of its branches (not even the simple, cheap ones) could
-- benefit from the planner's normal index/join optimization. That is what the Nov 21 change did
-- NOT fix, and it is what was still producing 2.5-8s mean query times on task list/detail
-- queries, pushing Peak Connections near its cap and exhausting the project's Disk IO Balance
-- during the Nov 26 incident.
--
-- Fix: remove the recursion entirely. `enforce_nesting_depth` (see
-- 20260928100000_canonical_schema_v4.sql) already caps parent_task_id chains at 3 levels, so the
-- recursive "is an ancestor visible?" check can be fully unrolled into self + parent + grandparent
-- -- no deeper lookup is ever possible. The shared per-task-node visibility logic is factored into
-- a new, deliberately non-recursive helper (task_visible_level), which takes the node's own
-- identity columns and the caller's context as plain parameters (no self-reference, no subquery
-- against itself) so Postgres is free to inline it. task_visible_v2 itself becomes a thin,
-- non-recursive wrapper that joins up to the grandparent row once and calls the helper three
-- times (self/parent/grandparent), OR'd together.
--
-- Visibility semantics are unchanged -- this is a pure performance restructuring, not a policy
-- change. Every branch below (executive/head_of_technical see-all, creator, assignee, team-lead
-- team/Programming-for-seo_team_lead carve-out, am_agent's own client, marketing_manager's
-- graphic_designer/video_editor carve-out) is copied verbatim from the live Nov 21 function body,
-- just parameterized instead of re-derived per call.
--
-- Rollback: re-apply 20270122000000_optimize_task_visibility_functions.sql's task_visible_v2 body
-- (the recursive version) -- not recommended, it is the confirmed root cause of the Nov 26
-- incident.
begin;

create or replace function public.task_visible_level(
  p_task_id text,
  p_created_by text,
  p_client_id text,
  p_is_inhouse boolean,
  p_role text,
  p_uid text,
  p_team text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p_role in ('executive', 'head_of_technical')
    or p_created_by = p_uid
    or exists (
      select 1 from public.task_assignees ta
      where ta.task_id = p_task_id and ta.user_id = p_uid
    )
    or (
      p_role in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
      and not p_is_inhouse
      and (
        exists (select 1 from public.users u where u.id = p_created_by and u.team = p_team)
        or exists (
          select 1 from public.task_assignees ta
          join public.users u on u.id = ta.user_id
          where ta.task_id = p_task_id and u.team = p_team
        )
        or (
          p_role = 'seo_team_lead'
          and (
            exists (select 1 from public.users u where u.id = p_created_by and u.team = 'Programming')
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
      p_role = 'am_agent'
      and not p_is_inhouse
      and p_client_id is not null
      and public.client_am_agent_is_caller(p_client_id)
    )
    or (
      p_role = 'marketing_manager'
      and (
        p_is_inhouse
        or exists (select 1 from public.users u where u.id = p_created_by and u.role in ('graphic_designer', 'video_editor'))
        or exists (
          select 1 from public.task_assignees ta
          join public.users u on u.id = ta.user_id
          where ta.task_id = p_task_id and u.role in ('graphic_designer', 'video_editor')
        )
      )
    );
$$;

revoke all on function public.task_visible_level(text, text, text, boolean, text, text, text) from public, anon;
grant execute on function public.task_visible_level(text, text, text, boolean, text, text, text) to authenticated;

-- Same signature as the recursive Nov 21 version (public.task_visible_v2(text)) -- CREATE OR
-- REPLACE in place, no callers (RLS policies on tasks/task_comments/task_attachments/daily_logs)
-- need to change.
create or replace function public.task_visible_v2(p_task_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ctx as (
    select public.app_user_role() as role, public.app_user_id() as uid, public.app_user_team() as team
  ),
  t as (
    select
      tk.id, tk.created_by, tk.client_id,
      coalesce(c.is_inhouse, false) as is_inhouse,
      p.id as p_id, p.created_by as p_created_by, p.client_id as p_client_id,
      coalesce(pc.is_inhouse, false) as p_is_inhouse,
      gp.id as gp_id, gp.created_by as gp_created_by, gp.client_id as gp_client_id,
      coalesce(gpc.is_inhouse, false) as gp_is_inhouse
    from public.tasks tk
    left join public.clients c on c.id = tk.client_id
    left join public.tasks p on p.id = tk.parent_task_id
    left join public.clients pc on pc.id = p.client_id
    left join public.tasks gp on gp.id = p.parent_task_id
    left join public.clients gpc on gpc.id = gp.client_id
    where tk.id = p_task_id
  )
  select
    ctx.role <> 'sales'
    and exists (select 1 from t)
    and (
      exists (
        select 1 from t
        where public.task_visible_level(t.id, t.created_by, t.client_id, t.is_inhouse, ctx.role, ctx.uid, ctx.team)
      )
      or exists (
        select 1 from t
        where t.p_id is not null
          and public.task_visible_level(t.p_id, t.p_created_by, t.p_client_id, t.p_is_inhouse, ctx.role, ctx.uid, ctx.team)
      )
      or exists (
        select 1 from t
        where t.gp_id is not null
          and public.task_visible_level(t.gp_id, t.gp_created_by, t.gp_client_id, t.gp_is_inhouse, ctx.role, ctx.uid, ctx.team)
      )
    )
  from ctx;
$$;

revoke all on function public.task_visible_v2(text) from public, anon;
grant execute on function public.task_visible_v2(text) to authenticated;

commit;
