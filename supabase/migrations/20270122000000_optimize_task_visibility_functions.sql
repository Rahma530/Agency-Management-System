-- Performance fix only — no behavior change, no new grants, no new tables/columns.
--
-- Context (2026-11-21): Supabase's own AI Assistant, run against the live project's
-- pg_stat_statements after a CPU-saturation incident, flagged the PostgREST list queries against
-- tasks/task_assignees/task_platform_links (each averaging 2.6-4.2s per call, near-zero I/O wait —
-- i.e. CPU-bound, not disk-bound) and pointed at task_visible_v2's RLS cost as the likely cause,
-- specifically: "simply wrapping task_visible_v2(id) in a SELECT won't make that row-dependent
-- call run once per query... consider refactoring repeated row-invariant lookups."
--
-- Reading task_visible_v2's actual definition (20270108000000_ai_engineer_task_visibility_
-- restriction.sql) confirms exactly that: public.app_user_role() is called 6 separate times,
-- public.app_user_id() twice, and public.app_user_team() twice, ALL WITHIN ONE INVOCATION of the
-- function for a single task row. Each of those three helpers (see 20260928100000_canonical_
-- schema_v4.sql) is itself `select ... from public.users where auth_id = auth.uid()` — a real
-- table lookup, not a cheap JWT-claim read. None of the three ever changes within one invocation
-- (they only depend on the calling user, who can't change mid-statement) — so every call past the
-- first is pure, avoidable repeated work. Since task_visible_v2 already runs once PER CANDIDATE
-- ROW under RLS (that part is inherent and untouched here), and is itself called recursively for
-- parent-task inheritance, this 10x-per-row redundancy compounds into real, previously-unexplained
-- CPU cost across the whole task-related surface (tasks, task_assignees, task_platform_links,
-- task_comments, task_attachments — everything that calls task_visible_v2).
-- direct_report_visible (daily_logs' own visibility helper) has the identical pattern: six calls
-- to app_user_role(), one to app_user_id(), in one invocation.
--
-- Fix: compute app_user_role()/app_user_id()/app_user_team() exactly ONCE per invocation, via a
-- leading CTE, and reference that CTE's columns everywhere the function body used to call the
-- helper directly. This is a pure mechanical substitution — every comparison, branch and condition
-- below is byte-for-byte the same logic as the version it replaces, just reading a cached value
-- instead of re-deriving it. It does not change who can see which tasks or users; it only removes
-- redundant lookups of the SAME caller-scoped values within one check.
begin;

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
    ctx.role <> 'sales'
    and exists (select 1 from t)
    and (
      ctx.role in ('executive', 'head_of_technical')
      or exists (select 1 from t where t.created_by = ctx.uid)
      or exists (
        select 1 from public.task_assignees ta
        where ta.task_id = p_task_id and ta.user_id = ctx.uid
      )
      or (
        ctx.role in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
        and not exists (select 1 from t where t.is_inhouse)
        and (
          exists (select 1 from t join public.users u on u.id = t.created_by where u.team = ctx.team)
          or exists (
            select 1 from public.task_assignees ta
            join public.users u on u.id = ta.user_id
            where ta.task_id = p_task_id and u.team = ctx.team
          )
          or (
            ctx.role = 'seo_team_lead'
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
        ctx.role = 'am_agent'
        and not exists (select 1 from t where t.is_inhouse)
        and exists (select 1 from t where t.client_id is not null and public.client_am_agent_is_caller(t.client_id))
      )
      or (
        ctx.role = 'marketing_manager'
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
    )
  from ctx;
$$;

revoke all on function public.task_visible_v2(text) from public, anon;
grant execute on function public.task_visible_v2(text) to authenticated;

create or replace function public.direct_report_visible(target_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ctx as (
    select public.app_user_role() as role, public.app_user_id() as uid
  )
  select
    target_id = ctx.uid
    or ctx.role in ('executive', 'head_of_technical')
    or exists (
      select 1 from public.users u where u.id = target_id and (
        (ctx.role = 'am_team_lead' and u.role = 'am_agent')
        or (ctx.role = 'media_buying_team_lead' and u.role = 'media_buying_agent')
        or (ctx.role = 'seo_team_lead' and u.role in ('seo_agent', 'programming_agent'))
        or (ctx.role = 'social_media_team_lead' and u.role = 'social_media_agent')
      )
    )
  from ctx;
$$;

commit;
