-- Rollback for 20261217300000_graphic_design_service.sql — restores the exact
-- assignments_select_rls / assignments_insert_rls / assignments_update_rls and
-- assignments_service_type_check from 20261124000000_ai_engineer_deprivilege.sql.
begin;

alter table public.assignments drop constraint if exists assignments_service_type_check;
alter table public.assignments add constraint assignments_service_type_check
  check (service_type in ('seo', 'social_media', 'media_buying', 'interface'));

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
);

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
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
);

drop policy if exists "assignments_insert_rls" on public.assignments;
create policy "assignments_insert_rls" on public.assignments
for insert to authenticated
with check (
  (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (
    public.app_user_role() in ('executive', 'head_of_technical')
    and service_type in ('seo', 'media_buying', 'social_media')
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
        )
    )
  )
);

commit;
