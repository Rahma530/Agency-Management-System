-- Supersedes 20261217200000_graphic_designer_social_assignment.sql (never applied to any real
-- database — that PR was never merged), per a follow-up product decision: Graphic Design is now
-- its own standalone, subscribable service_type (clients.services/other_services), not something
-- that rides the social_media subscription. A client can need design work without being
-- subscribed to Social Media at all.
--
-- No change was needed for the "client subscribes to Graphic Design" part: `other_services` (see
-- 20261030700000_client_other_services_sales_brief.sql) is a free-text column with no check
-- constraint on its values, and client_has_service() already matches `services` OR
-- `other_services` — so 'graphic_design' just works there once the frontend
-- (src/lib/clientServices.ts) recognizes the value. This migration only touches
-- public.assignments, which DOES have a real service_type check constraint and its own RLS.
--
-- Being its own service_type also means the normal one-row-per-(client, service_type) assignment
-- model just works unmodified — no more of the "two rows, same service_type, disambiguated by the
-- assignee's role" workaround the superseded design needed.
--
-- Who may assign: am_team_lead, executive, head_of_technical, and am_agent (scoped to their own
-- client) — same as the superseded design — deliberately NOT social_media_team_lead or any other
-- department team lead, since Graphic Design has no department of its own (graphic_designer is a
-- shared-resource-pool role, same as 'interface'/ui_ux_designer).
--
-- Baseline being modified is the latest live state from 20261124000000_ai_engineer_deprivilege.sql.
begin;

-- 1. Allow 'graphic_design' as a real assignments.service_type value.
alter table public.assignments drop constraint if exists assignments_service_type_check;
alter table public.assignments add constraint assignments_service_type_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'interface', 'graphic_design'));

-- 2. SELECT: executive/head_of_technical/am_team_lead already see every assignments row
-- unconditionally, and am_agent already sees every row for their own clients unconditionally —
-- neither needs a change for a new service_type. Only a graphic_designer's own self-view of their
-- own 'graphic_design' row is new (mirrors the existing 'creative' self-view branch, which stays
-- untouched for historical data).
drop policy if exists "assignments_select_rls" on public.assignments;
create policy "assignments_select_rls" on public.assignments for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'graphic_designer' and service_type = 'graphic_design' and agent_id = public.app_user_id())
);

-- 3. INSERT: add am_team_lead (unconditional) / am_agent (scoped) branches for the new service,
-- and extend the existing executive/head_of_technical leadership branch to also cover it.
drop policy if exists "assignments_insert_rls" on public.assignments;
create policy "assignments_insert_rls" on public.assignments
for insert to authenticated
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (
    public.app_user_role() in ('executive', 'head_of_technical')
    and service_type in ('seo', 'media_buying', 'social_media', 'graphic_design')
    and public.client_has_service(client_id, service_type)
    and exists (
      select 1
      from public.users assignee
      where assignee.id = agent_id
        and assignee.auth_id is not null
        and assignee.deactivated_at is null
        and (
          (service_type = 'seo' and assignee.role in (
            'seo_team_lead',
            'seo_agent',
            'seo_content_agent',
            'seo_backlink_agent'
          ))
          or (service_type = 'media_buying' and assignee.role in (
            'media_buying_team_lead',
            'media_buying_agent'
          ))
          or (service_type = 'social_media' and assignee.role in (
            'social_media_team_lead',
            'social_media_agent'
          ))
          or (service_type = 'graphic_design' and assignee.role = 'graphic_designer')
        )
    )
  )
  or (
    public.app_user_role() = 'am_team_lead'
    and service_type = 'graphic_design'
    and public.client_has_service(client_id, 'graphic_design')
    and exists (
      select 1 from public.users assignee
      where assignee.id = agent_id
        and assignee.role = 'graphic_designer'
        and assignee.auth_id is not null
        and assignee.deactivated_at is null
    )
  )
  or (
    public.app_user_role() = 'am_agent'
    and public.client_am_agent_is_caller(client_id)
    and service_type = 'graphic_design'
    and public.client_has_service(client_id, 'graphic_design')
    and exists (
      select 1 from public.users assignee
      where assignee.id = agent_id
        and assignee.role = 'graphic_designer'
        and assignee.auth_id is not null
        and assignee.deactivated_at is null
    )
  )
);

-- 4. UPDATE: add am_team_lead (unconditional) / am_agent (scoped) branches for the new service.
-- executive/head_of_technical already have an unconditional bypass — no change needed for them.
drop policy if exists "assignments_update_rls" on public.assignments;
create policy "assignments_update_rls" on public.assignments
for update to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'am_team_lead' and service_type = 'graphic_design')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id) and service_type = 'graphic_design')
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'am_team_lead' and service_type = 'graphic_design')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id) and service_type = 'graphic_design')
);

commit;
