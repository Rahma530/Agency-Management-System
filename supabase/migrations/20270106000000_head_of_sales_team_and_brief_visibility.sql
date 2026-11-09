-- Fix: head_of_sales's Assigned Team tab and Service Briefs tab were rendering empty/"Unassigned"
-- even after PR #313/#314 (hasBriefViewAccess, ClientDashboard.tsx) shipped. Root cause: those two
-- PRs only ever touched FRONTEND gates (which tabs/sections render) — they never touched the
-- actual RLS that governs which ROWS a head_of_sales session can read from public.users,
-- public.assignments, and public.briefs. So the tabs rendered, but every underlying query returned
-- zero/near-zero rows under RLS:
--   - public.users (users_select_rls -> employee_visible()): head_of_sales had no branch at all,
--     so target_id = app_user_id() was the only thing that matched — their OWN row only. Every
--     users.find(...)/users.filter(...) lookup in ClientDashboard.tsx's Team tab (assignedAM,
--     amLead, amAgents, amTeamLeaders, assignedMediaBuyer/SEOSpecialist/SocialSpecialist/
--     GraphicDesigner) resolved to undefined/empty, rendering as "Unassigned" regardless of the
--     client's actual am_agent_id/am_team_lead_id or assignments rows.
--   - public.assignments (assignments_select_rls): head_of_sales had no branch either, so the
--     Media Buying/SEO/Social Media/Graphic Design assignment cards saw an empty assignments list
--     for every client, same "Unassigned" symptom.
--   - public.briefs (briefs_select_rls): head_of_sales had no branch, so the Service Briefs tab's
--     query returned zero rows regardless of hasBriefViewAccess already letting the tab render.
--
-- Fix is additive only, read-only (no insert/update/delete grant) for all three, agency-wide (no
-- owner-scoping, matching head_of_sales's own clients_select_rls branch which is already
-- unrestricted):
--   1. employee_visible(): head_of_sales can see the same operational/assignable roles the Team
--      tab actually displays (AM Team Lead, AM Agent, and the per-service specialists) — not
--      Sales, not Executive/other leadership peers, since those were never part of the "show me
--      the Team" request.
--   2. assignments_select_rls: head_of_sales added to the unrestricted (no service_type
--      narrowing) branch, same as executive/head_of_technical/am_team_lead.
--   3. briefs_select_rls: head_of_sales added with the same "view-only, submitted_at is not null"
--      condition every other non-AM department role already has — never able to see an AM's
--      still-in-progress draft, same as everyone else in that tier. Write access
--      (briefs_write_rls/briefs_update_rls) and canEditServiceBrief are both untouched.
begin;

-- 1. employee_visible() — body copied from 20261124000000_ai_engineer_deprivilege.sql, adding one
-- new disjunct for head_of_sales scoped to the Team tab's own roles.
create or replace function public.employee_visible(target_id text, target_role text)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
    or (target_role in ('graphic_designer', 'video_editor') and public.app_user_role() <> 'sales')
    or (public.app_user_role() = 'am_team_lead' and target_role in ('am_team_lead', 'am_agent'))
    or (public.app_user_role() = 'media_buying_team_lead' and target_role in ('media_buying_team_lead', 'media_buying_agent'))
    or (public.app_user_role() = 'seo_team_lead' and target_role in ('seo_team_lead', 'seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager'))
    or (public.app_user_role() = 'social_media_team_lead' and target_role in ('social_media_team_lead', 'social_media_agent'))
    or (public.app_user_role() = 'am_agent' and target_role in ('am_agent', 'am_team_lead'))
    or (public.app_user_role() = 'media_buying_agent' and target_role in ('media_buying_agent', 'media_buying_team_lead'))
    or (public.app_user_role() = 'seo_agent' and target_role in ('seo_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'programming_agent' and target_role in ('programming_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'seo_content_agent' and target_role in ('seo_content_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'seo_backlink_agent' and target_role in ('seo_backlink_agent', 'seo_team_lead'))
    or (public.app_user_role() = 'store_manager' and target_role in ('store_manager', 'seo_team_lead'))
    or (public.app_user_role() = 'social_media_agent' and target_role in ('social_media_agent', 'social_media_team_lead'))
    or (public.app_user_role() = 'sales' and target_role = 'sales')
    -- Added 2026-11-09 (owner's explicit "show the Team normally" request, head_of_sales only):
    -- every role the Assigned Team tab can actually display a card for — AM Team Lead/AM Agent and
    -- the per-service specialists. Not 'sales' (head_of_sales never saw Sales reps, and this
    -- mirrors that role's own narrow 'sales' = 'sales' branch above), not other leadership roles.
    or (
      public.app_user_role() = 'head_of_sales'
      and target_role in (
        'am_team_lead', 'am_agent',
        'media_buying_team_lead', 'media_buying_agent',
        'seo_team_lead', 'seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager',
        'social_media_team_lead', 'social_media_agent',
        'graphic_designer', 'video_editor'
      )
    )
    or (
      target_role in ('am_agent', 'am_team_lead') and exists (
        select 1 from public.clients c
        where (c.am_agent_id = target_id or c.am_team_lead_id = target_id) and (
          public.app_user_role() in ('media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
          or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(c.id, 'media_buying'))
          or (public.app_user_role() = 'seo_agent' and public.agent_assigned(c.id, 'seo'))
          or (public.app_user_role() = 'store_manager' and public.agent_assigned(c.id, 'seo'))
          or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(c.id, 'social_media'))
          or exists (
            select 1 from public.tasks t
            where t.client_id = c.id
              and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
          )
        )
      )
    )
    or (
      public.app_user_role() <> 'sales'
      and exists (
        select 1 from public.custom_roles cr
        join public.departments d on d.id = cr.department_id
        where cr.id = target_role and cr.is_active and d.is_shared_resource
      )
    )
    or (
      public.app_has_permission('employees.view_department_peers')
      and exists (
        select 1 from public.custom_roles me
        join public.custom_roles other on other.department_id = me.department_id
        where me.id = public.app_user_role() and other.id = target_role
          and other.is_active and me.is_active
      )
    );
$function$;

-- 2. assignments_select_rls — add head_of_sales to the unrestricted branch (same as
-- executive/head_of_technical/am_team_lead: no service_type narrowing, agency-wide, read-only).
drop policy if exists "assignments_select_rls" on public.assignments;
create policy "assignments_select_rls" on public.assignments for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'head_of_sales')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and agent_id = public.app_user_id())
);

-- 3. briefs_select_rls — add head_of_sales, view-only (submitted_at is not null), same pattern as
-- the department team-lead/agent branches already have.
drop policy if exists "briefs_select_rls" on public.briefs;
create policy "briefs_select_rls" on public.briefs
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() in ('seo_team_lead', 'media_buying_team_lead', 'social_media_team_lead') and submitted_at is not null)
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id) and submitted_at is not null)
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
  or (public.app_user_role() = 'head_of_sales' and submitted_at is not null)
);

commit;
