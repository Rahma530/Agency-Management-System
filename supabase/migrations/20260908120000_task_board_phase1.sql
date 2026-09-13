-- ============================================================================
-- Task Board Phase 1: mandatory due_date/description, and scoped visibility
-- for shared creative resources (graphic_designer, video_editor).
-- ============================================================================
--
-- 1. tasks.due_date / tasks.description — NOT NULL. The app layer
--    (CrossTeamTaskBoard.tsx's Create and Edit Task forms) already blocks
--    submission when either is missing; this backs that with a real DB
--    constraint so a task can never end up without them via any other path
--    (direct API calls, future code that skips the form, etc.). Safe to
--    apply immediately — every row in src/data/initialData.ts's seed data
--    already has both fields populated, and there is no production data yet
--    (confirmed empty live database, per the id-column-types migration).
--
-- 2. public.task_visible() — graphic_designer and video_editor are shared
--    creative resources pooled across every requesting team, not a single
--    department's own board, so the existing "same team as the assignee"
--    fallback leaks every other designer's/editor's tasks to them too (their
--    `team` is 'Creative & Design' / 'Video Production', shared by every
--    peer in that role). New branch: for these two roles only, visibility is
--    assigned-to-them-only, skipping the team fallback entirely. Mirrors the
--    same change made to isTaskAccessibleUnderRLS() in src/lib/supabase.ts.
--    Every other role's behavior is unchanged.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Mandatory due_date and description
-- ----------------------------------------------------------------------------
alter table public.tasks alter column due_date set not null;
alter table public.tasks alter column description set not null;

-- ----------------------------------------------------------------------------
-- 2. task_visible() — scope graphic_designer/video_editor to assigned-only
-- ----------------------------------------------------------------------------
create or replace function public.task_visible(p_assigned_to text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.app_user_role() <> 'sales'
    and (
      public.app_user_role() in (
        'executive', 'head_of_technical',
        'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'
      )
      or (
        public.app_user_role() in ('graphic_designer', 'video_editor')
        and p_assigned_to = public.app_user_id()
      )
      or (
        public.app_user_role() not in ('graphic_designer', 'video_editor')
        and (
          p_assigned_to = public.app_user_id()
          or exists (
            select 1 from public.users u
            where u.id = p_assigned_to and u.team = public.app_user_team()
          )
        )
      )
    );
$$;

commit;
