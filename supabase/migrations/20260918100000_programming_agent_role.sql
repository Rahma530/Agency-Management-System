-- ============================================================================
-- Module 12, Phase 1: new role `programming_agent`.
-- ============================================================================
--
-- Structurally like graphic_designer/video_editor: no dedicated team lead of
-- its own, task-based work with no service_type/assignments relationship to
-- clients (confirmed: not a new department buildout, no client-service
-- subscription model needed). The one real difference from graphic_designer/
-- video_editor: this role is exclusively owned by seo_team_lead's oversight,
-- not shared across every team lead the way the creative pool is — so it
-- gets its own branch in seo_team_lead's managed-roles logic rather than
-- joining the unconditional graphic_designer/video_editor branches.
--
-- 1. users_role_check — widened to admit the 15th role value. Same pattern
--    as 20260904000000_fix_users_role_constraint.sql: drop and recreate
--    with the complete list (constraints can't be CREATE OR REPLACE'd).
--
-- 2. employee_visible() — seo_team_lead's existing branch
--    (target_role in ('seo_team_lead','seo_agent')) widened to include
--    'programming_agent', plus a new reciprocal branch so a
--    programming_agent can see their own peers and seo_team_lead, mirroring
--    every other agent role's reciprocal branch in this function.
--
-- 3. direct_report_visible() — seo_team_lead's existing branch
--    (u.role = 'seo_agent') widened with an additional OR for
--    'programming_agent'. This is what actually drives capacity_logs
--    visibility (via employee_visible_by_id, itself built on
--    employee_visible — see point 2) and kpi_scores/performance_reviews/
--    daily_logs/extra_notes visibility for seo_team_lead over their
--    programming_agent reports.
--
-- NOT changed, and confirmed why:
--   - task_visible(): already role-agnostic for any role outside the fixed
--     team-lead/creative-pool lists — programming_agent automatically gets
--     assigned-to-them-or-same-team visibility with no change needed.
--   - client_has_service()/agent_assigned(): programming_agent has no
--     service_type or assignments row at all (task-based only), so neither
--     function is ever called with this role.
--   - capacity_logs_insert_rls: already admits seo_team_lead for the
--     INSERT-a-reading-for-a-visible-agent check (via employee_visible_by_id
--     from point 3), so seo_team_lead can already log capacity for
--     programming_agent once point 2/3 land — no separate policy change.
-- ============================================================================

begin;

alter table public.users drop constraint if exists users_role_check;

alter table public.users add constraint users_role_check check (
  role in (
    'executive',
    'head_of_technical',
    'sales',
    'am_team_lead',
    'am_agent',
    'media_buying_team_lead',
    'media_buying_agent',
    'seo_team_lead',
    'seo_agent',
    'programming_agent',
    'social_media_team_lead',
    'social_media_agent',
    'graphic_designer',
    'video_editor',
    'ai_engineer'
  )
);

create or replace function public.employee_visible(target_id text, target_role text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
    or (target_role in ('graphic_designer', 'video_editor') and public.app_user_role() <> 'sales')
    or (public.app_user_role() = 'am_team_lead' and target_role in ('am_team_lead', 'am_agent'))
    or (public.app_user_role() = 'media_buying_team_lead' and target_role in ('media_buying_team_lead', 'media_buying_agent'))
    or (public.app_user_role() = 'seo_team_lead' and target_role in ('seo_team_lead', 'seo_agent', 'programming_agent'))
    or (public.app_user_role() = 'social_media_team_lead' and target_role in ('social_media_team_lead', 'social_media_agent'))
    or (public.app_user_role() = 'am_agent' and target_role in ('am_agent', 'am_team_lead'))
    or (public.app_user_role() = 'media_buying_agent' and target_role in ('media_buying_agent', 'media_buying_team_lead'))
    or (public.app_user_role() = 'seo_agent' and target_role in ('seo_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'programming_agent' and target_role in ('programming_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'social_media_agent' and target_role in ('social_media_agent', 'social_media_team_lead'))
    or (public.app_user_role() = 'sales' and target_role = 'sales');
$$;

create or replace function public.direct_report_visible(target_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
    or exists (
      select 1 from public.users u
      where u.id = target_id
        and (
          (public.app_user_role() = 'am_team_lead' and u.role = 'am_agent')
          or (public.app_user_role() = 'media_buying_team_lead' and u.role = 'media_buying_agent')
          or (public.app_user_role() = 'seo_team_lead' and u.role in ('seo_agent', 'programming_agent'))
          or (public.app_user_role() = 'social_media_team_lead' and u.role = 'social_media_agent')
        )
    );
$$;

commit;
