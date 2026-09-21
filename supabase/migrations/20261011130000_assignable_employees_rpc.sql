-- Department-scoped staffing pickers (CrossTeamTaskBoard's New/Edit Task Assignee dropdown,
-- CampaignManagementModule's Responsible Employee dropdown) need to list employees OUTSIDE the
-- caller's own department — e.g. an AM Agent creating a task for the Media Buying team. Under the
-- existing employee_visible()/users_select_rls, an AM Agent's visible `users` rows are limited to
-- themselves, other am_agent/am_team_lead, and the shared graphic_designer/video_editor pool —
-- every other department (SEO, Media Buying, Social Media, Programming) is invisible to them, so
-- those dropdowns silently show an empty list for those departments (confirmed: not a frontend
-- filter bug, a genuine RLS visibility gap).
--
-- Why a dedicated RPC instead of widening employee_visible(): RLS is row-level, not column-level,
-- and every fetch of `users` in this app is an unfiltered select('*') — public.users has a real
-- `email` column AND a real plaintext `password` column (a separate, already-flagged security
-- debt item on its own, not addressed here). Widening row visibility would hand every column,
-- including that plaintext password, to anyone who gains it. This SECURITY DEFINER function
-- bypasses users_select_rls entirely and returns only the five columns these pickers actually use
-- (id, name, role, team, capacity_limit) — never email, password, manager_id, auth_id, or
-- deactivated_at. It filters to active employees and excludes executive/head_of_technical
-- server-side, mirroring isOperationalAssignee, so the frontend never needs to re-derive that
-- exclusion from more sensitive fields. No caller-role restriction: this is the same
-- low-sensitivity staff-directory data (name/role/team) employee_visible() already exposes
-- unconditionally between peers elsewhere.
create or replace function public.assignable_employees(p_department text)
returns table (
  id text,
  name text,
  role text,
  team text,
  capacity_limit integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.name, u.role, u.team, u.capacity_limit
  from public.users u
  where u.auth_id is not null
    and u.deactivated_at is null
    and u.role not in ('executive', 'head_of_technical')
    and u.team = any(
      case p_department
        when 'Creative & Design' then array['Creative & Design', 'Video Production']
        else array[p_department]
      end
    );
$$;

grant execute on function public.assignable_employees(text) to authenticated;
