-- Lets a Graphic Designer be assigned to a client the exact same way any other service
-- specialist is (shows up in the client's team, reassignable, one at a time) — tied to the
-- social_media service, per the explicit product decision: graphic designers prepare the
-- content plan's visuals, so they ride the same subscription as the Social Media specialist
-- rather than a new service_type. This does NOT touch the existing social_media_agent slot:
-- a client with service_type='social_media' can now hold up to two assignments rows at once —
-- one for the social_media_agent/social_media_team_lead (unchanged), one for the
-- graphic_designer (new) — distinguished purely by the assignee's role, since assignments has
-- no unique(client_id, service_type) constraint to begin with (only a plain, non-unique index).
--
-- Who may perform this specific assignment (per explicit instruction): am_team_lead, executive,
-- head_of_technical, and am_agent (scoped to their own client) — deliberately NOT
-- social_media_team_lead, who keeps managing only their own social_media_agent slot as before.
--
-- Baseline being modified is the latest live state from 20261124000000_ai_engineer_deprivilege.sql
-- (ai_engineer already removed there) — not any earlier copy of these three policies.
begin;

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
          -- graphic_designer added here: executive/head_of_technical could already assign the
          -- social_media_agent slot, now they can also assign the separate designer slot.
          or (service_type = 'social_media' and assignee.role in (
            'social_media_team_lead',
            'social_media_agent',
            'graphic_designer'
          ))
        )
    )
  )
  -- New: am_team_lead may assign a graphic designer to any client subscribed to social_media.
  or (
    public.app_user_role() = 'am_team_lead'
    and service_type = 'social_media'
    and public.client_has_service(client_id, 'social_media')
    and exists (
      select 1 from public.users assignee
      where assignee.id = agent_id
        and assignee.role = 'graphic_designer'
        and assignee.auth_id is not null
        and assignee.deactivated_at is null
    )
  )
  -- New: am_agent may do the same, but only for the client they are themselves the AM agent for.
  or (
    public.app_user_role() = 'am_agent'
    and public.client_am_agent_is_caller(client_id)
    and service_type = 'social_media'
    and public.client_has_service(client_id, 'social_media')
    and exists (
      select 1 from public.users assignee
      where assignee.id = agent_id
        and assignee.role = 'graphic_designer'
        and assignee.auth_id is not null
        and assignee.deactivated_at is null
    )
  )
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
  -- New: am_team_lead/am_agent may reassign a designer-track row (i.e. one currently held by a
  -- graphic_designer) only — this intentionally cannot reach the social_media_agent's own row,
  -- which stays governed solely by social_media_team_lead/executive/head_of_technical as before.
  or (
    public.app_user_role() = 'am_team_lead'
    and service_type = 'social_media'
    and exists (select 1 from public.users a where a.id = agent_id and a.role = 'graphic_designer')
  )
  or (
    public.app_user_role() = 'am_agent'
    and public.client_am_agent_is_caller(client_id)
    and service_type = 'social_media'
    and exists (select 1 from public.users a where a.id = agent_id and a.role = 'graphic_designer')
  )
)
with check (
  public.app_user_role() in ('executive', 'head_of_technical')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (
    public.app_user_role() = 'am_team_lead'
    and service_type = 'social_media'
    and exists (
      select 1 from public.users a
      where a.id = agent_id and a.role = 'graphic_designer' and a.auth_id is not null and a.deactivated_at is null
    )
  )
  or (
    public.app_user_role() = 'am_agent'
    and public.client_am_agent_is_caller(client_id)
    and service_type = 'social_media'
    and exists (
      select 1 from public.users a
      where a.id = agent_id and a.role = 'graphic_designer' and a.auth_id is not null and a.deactivated_at is null
    )
  )
);

commit;
