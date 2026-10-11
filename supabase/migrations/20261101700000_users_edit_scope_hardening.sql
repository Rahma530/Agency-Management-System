-- Narrows a Team Lead's edit/capacity/deactivate rights over OTHER employees to "my own
-- department's team-lead/agent roles only" — today's users_update_profile_rls/
-- users_update_capacity_rls/users_deactivate_rls instead reuse employee_visible(id, role), which
-- is deliberately wider than edit scope (it also covers the shared graphic_designer/video_editor
-- pool, and cross-department AM visibility for clients a department works on) — fine for SELECT
-- visibility, too wide for who may actually change another employee's row.
--
-- Live policy definitions being replaced (confirmed identical across all three: cmd UPDATE, roles
-- {authenticated}, same using/with_check):
--   ((app_user_role() = ANY (ARRAY['executive','head_of_technical','am_team_lead',
--     'media_buying_team_lead','seo_team_lead','social_media_team_lead'])) AND
--     employee_visible(id, role))
-- Policy names: users_deactivate_rls, users_update_capacity_rls, users_update_profile_rls.
--
-- Unchanged by this migration: users_select_rls (still employee_visible(id, role) — SELECT
-- visibility is intentionally broader than edit scope, not touched here), users_insert_admin_rls,
-- and users_update_guard() (the trigger already independently restricts which role VALUE a team
-- lead may set, column-by-column — this migration only narrows which ROW a team lead may reach
-- with an UPDATE at all; the two layers are complementary, not overlapping, and neither needs the
-- other changed).
begin;

-- ----------------------------------------------------------------------------
-- 1. employee_manageable(target_id, target_role) — the new, narrower "may I edit/deactivate/
--    change this row's capacity" check. Mirrors each team lead's own department exactly
--    (seo_team_lead's set additionally matches employee_visible()'s existing SEO branch:
--    seo_agent/programming_agent/seo_content_agent/seo_backlink_agent/store_manager).
--    A custom role is manageable only by executive/head_of_technical, or by itself — no team
--    lead (built-in or, once granted, custom) gets an edit branch over a custom role here; that
--    is a deliberate, separate design decision, not an oversight.
-- ----------------------------------------------------------------------------
create or replace function public.employee_manageable(target_id text, target_role text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select public.app_user_role() in ('executive', 'head_of_technical')
    or target_id = public.app_user_id()
    or (public.app_user_role() = 'am_team_lead' and target_role in ('am_team_lead', 'am_agent'))
    or (public.app_user_role() = 'media_buying_team_lead' and target_role in ('media_buying_team_lead', 'media_buying_agent'))
    or (public.app_user_role() = 'seo_team_lead' and target_role in ('seo_team_lead', 'seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager'))
    or (public.app_user_role() = 'social_media_team_lead' and target_role in ('social_media_team_lead', 'social_media_agent'));
$$;

revoke execute on function public.employee_manageable(text, text) from public;
grant execute on function public.employee_manageable(text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. The three UPDATE policies, same role list and names, employee_visible(id, role) swapped for
--    employee_manageable(id, role). Nothing else about them changes.
-- ----------------------------------------------------------------------------
drop policy if exists "users_deactivate_rls" on public.users;
create policy "users_deactivate_rls" on public.users
for update to authenticated
using (
  public.app_user_role() = any (array['executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'])
  and public.employee_manageable(id, role)
)
with check (
  public.app_user_role() = any (array['executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'])
  and public.employee_manageable(id, role)
);

drop policy if exists "users_update_capacity_rls" on public.users;
create policy "users_update_capacity_rls" on public.users
for update to authenticated
using (
  public.app_user_role() = any (array['executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'])
  and public.employee_manageable(id, role)
)
with check (
  public.app_user_role() = any (array['executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'])
  and public.employee_manageable(id, role)
);

drop policy if exists "users_update_profile_rls" on public.users;
create policy "users_update_profile_rls" on public.users
for update to authenticated
using (
  public.app_user_role() = any (array['executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'])
  and public.employee_manageable(id, role)
)
with check (
  public.app_user_role() = any (array['executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'])
  and public.employee_manageable(id, role)
);

commit;
