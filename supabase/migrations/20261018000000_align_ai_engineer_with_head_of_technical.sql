-- Align AI Engineer with Head of Technical at every active application authorization boundary.
-- This intentionally preserves all existing ownership, assignment, and row-scope constraints;
-- it only adds ai_engineer wherever head_of_technical is already authorized.

begin;

create or replace function public.employee_visible(target_id text, target_role text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
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
    or (public.app_user_role() = 'sales' and target_role = 'sales')
    or (
      target_role in ('am_agent', 'am_team_lead') and exists (
        select 1 from public.clients c
        where (c.am_agent_id = target_id or c.am_team_lead_id = target_id) and (
          public.app_user_role() in ('media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
          or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(c.id, 'media_buying'))
          or (public.app_user_role() = 'seo_agent' and public.agent_assigned(c.id, 'seo'))
          or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(c.id, 'social_media'))
          or exists (select 1 from public.tasks t where t.client_id = c.id and t.assigned_to = public.app_user_id())
        )
      )
    );
$$;

create or replace function public.task_visible(p_assigned_to text, p_parent_task_id text default null, p_client_id text default null)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.app_user_role() <> 'sales' and (
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and p_assigned_to = public.app_user_id())
    or (public.app_user_role() not in ('graphic_designer', 'video_editor') and (
      p_assigned_to = public.app_user_id()
      or exists (select 1 from public.users u where u.id = p_assigned_to and u.team = public.app_user_team())
    ))
    or (public.app_user_role() = 'am_agent' and p_client_id is not null and public.client_am_agent_is_caller(p_client_id))
    or (public.app_user_role() = 'marketing_manager' and exists (
      select 1 from public.users u where u.id = p_assigned_to and u.role in ('graphic_designer', 'video_editor')
    ))
    or (p_parent_task_id is not null and exists (
      select 1 from public.tasks pt where pt.id = p_parent_task_id
        and public.task_visible(pt.assigned_to, pt.parent_task_id, pt.client_id)
    ))
  );
$$;

create or replace function public.direct_report_visible(target_id text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
    or exists (
      select 1 from public.users u where u.id = target_id and (
        (public.app_user_role() = 'am_team_lead' and u.role = 'am_agent')
        or (public.app_user_role() = 'media_buying_team_lead' and u.role = 'media_buying_agent')
        or (public.app_user_role() = 'seo_team_lead' and u.role in ('seo_agent', 'programming_agent'))
        or (public.app_user_role() = 'social_media_team_lead' and u.role = 'social_media_agent')
      )
    );
$$;

create or replace function public.report_scope_accessible(p_client_id text, p_agent_id text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_client_id is not null then (
      public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
      or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(p_client_id))
      or (public.app_user_role() = 'media_buying_team_lead' and public.client_has_service(p_client_id, 'media_buying'))
      or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(p_client_id, 'media_buying'))
      or (public.app_user_role() = 'seo_team_lead' and public.client_has_service(p_client_id, 'seo'))
      or (public.app_user_role() = 'seo_agent' and public.agent_assigned(p_client_id, 'seo'))
      or (public.app_user_role() = 'social_media_team_lead' and public.client_has_service(p_client_id, 'social_media'))
      or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(p_client_id, 'social_media'))
    )
    when p_agent_id is not null then public.direct_report_visible(p_agent_id)
    else false
  end;
$$;

drop policy if exists "users_update_capacity_rls" on public.users;
create policy "users_update_capacity_rls" on public.users for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
  and public.employee_visible(id, role)
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
  and public.employee_visible(id, role)
);
drop policy if exists "users_update_profile_rls" on public.users;
create policy "users_update_profile_rls" on public.users for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
  and public.employee_visible(id, role)
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
  and public.employee_visible(id, role)
);
drop policy if exists "users_deactivate_rls" on public.users;
create policy "users_deactivate_rls" on public.users for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
  and public.employee_visible(id, role)
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
  and public.employee_visible(id, role)
);
drop policy if exists "users_insert_admin_rls" on public.users;
create policy "users_insert_admin_rls" on public.users for insert to authenticated with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer') and auth_id is null
);

drop policy if exists "clients_select_rls" on public.clients;
create policy "clients_select_rls" on public.clients for select to authenticated using (
  case public.app_user_role()
    when 'sales' then sales_owner_id = public.app_user_id()
    when 'executive' then true when 'head_of_technical' then true when 'ai_engineer' then true
    when 'am_team_lead' then true when 'am_agent' then am_agent_id = public.app_user_id()
    when 'media_buying_team_lead' then true when 'media_buying_agent' then public.agent_assigned(id, 'media_buying')
    when 'seo_team_lead' then true when 'social_media_team_lead' then true
    when 'seo_agent' then public.agent_assigned(id, 'seo') or exists (select 1 from public.tasks t where t.client_id = clients.id and t.assigned_to = public.app_user_id())
    when 'social_media_agent' then public.agent_assigned(id, 'social_media') or exists (select 1 from public.tasks t where t.client_id = clients.id and t.assigned_to = public.app_user_id())
    else exists (select 1 from public.tasks t where t.client_id = clients.id and t.assigned_to = public.app_user_id())
  end
);
drop policy if exists "clients_update_am_assignment_rls" on public.clients;
create policy "clients_update_am_assignment_rls" on public.clients for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'sales' and sales_owner_id = public.app_user_id())
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'sales' and sales_owner_id = public.app_user_id())
);
drop policy if exists "clients_delete_rls" on public.clients;
create policy "clients_delete_rls" on public.clients for delete to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
);
drop policy if exists "clients_insert_leadership_rls" on public.clients;
create policy "clients_insert_leadership_rls" on public.clients for insert to authenticated with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  and public.app_user_id() is not null and sales_owner_id is null
  and (am_team_lead_id is null or exists (select 1 from public.users u where u.id = am_team_lead_id and u.role = 'am_team_lead' and u.auth_id is not null and u.deactivated_at is null))
  and (am_agent_id is null or exists (select 1 from public.users u where u.id = am_agent_id and u.role in ('am_agent', 'am_team_lead') and u.auth_id is not null and u.deactivated_at is null))
);

drop policy if exists "client_portal_users_select_staff_rls" on public.client_portal_users;
create policy "client_portal_users_select_staff_rls" on public.client_portal_users for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);
drop policy if exists "client_portal_users_insert_staff_rls" on public.client_portal_users;
create policy "client_portal_users_insert_staff_rls" on public.client_portal_users for insert to authenticated with check (
  auth_id is null and (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id)))
);

drop policy if exists "briefs_select_rls" on public.briefs;
create policy "briefs_select_rls" on public.briefs for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and submitted_at is not null)
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and submitted_at is not null)
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and submitted_at is not null)
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id) and submitted_at is not null)
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);
drop policy if exists "briefs_write_rls" on public.briefs;
create policy "briefs_write_rls" on public.briefs for insert to authenticated with check (
  submitted_by = public.app_user_id() and (
    public.app_user_role() = 'am_team_lead'
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);
drop policy if exists "briefs_update_rls" on public.briefs;
create policy "briefs_update_rls" on public.briefs for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and submitted_by = public.app_user_id())
);

drop policy if exists "brief_revisions_select_rls" on public.brief_revisions;
create policy "brief_revisions_select_rls" on public.brief_revisions for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
  or (public.app_user_role() in ('seo_agent', 'media_buying_agent', 'social_media_agent') and public.agent_assigned_any_service(client_id))
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and edited_by = public.app_user_id())
);
drop policy if exists "brief_revisions_insert_rls" on public.brief_revisions;
create policy "brief_revisions_insert_rls" on public.brief_revisions for insert to authenticated with check (
  edited_by = public.app_user_id() and (
    public.app_user_role() = 'am_team_lead'
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo' and public.client_has_service(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media'))
    or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and public.client_has_service(client_id, 'seo') and public.agent_assigned(client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and public.client_has_service(client_id, 'media_buying') and public.agent_assigned(client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and public.client_has_service(client_id, 'social_media') and public.agent_assigned(client_id, 'social_media'))
    or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative')
  )
);

drop policy if exists "assignments_select_rls" on public.assignments;
create policy "assignments_select_rls" on public.assignments for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
  or (public.app_user_role() = 'seo_agent' and service_type = 'seo' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'media_buying_agent' and service_type = 'media_buying' and agent_id = public.app_user_id())
  or (public.app_user_role() = 'social_media_agent' and service_type = 'social_media' and agent_id = public.app_user_id())
  or (public.app_user_role() in ('graphic_designer', 'video_editor') and service_type = 'creative' and agent_id = public.app_user_id())
);

drop policy if exists "campaigns_select_rls" on public.campaigns;
create policy "campaigns_select_rls" on public.campaigns for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(client_id, 'media_buying'))
);
drop policy if exists "social_insights_select_rls" on public.social_insights;
create policy "social_insights_select_rls" on public.social_insights for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'social_media_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(client_id, 'social_media'))
);
drop policy if exists "analytics_insights_select_rls" on public.analytics_insights;
create policy "analytics_insights_select_rls" on public.analytics_insights for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'seo_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'seo_agent' and public.agent_assigned(client_id, 'seo'))
);

drop policy if exists "platform_connections_select_rls" on public.platform_connections;
create policy "platform_connections_select_rls" on public.platform_connections for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);
drop policy if exists "platform_connections_insert_rls" on public.platform_connections;
create policy "platform_connections_insert_rls" on public.platform_connections for insert to authenticated with check (
  (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id)))
  and (connected_by is null or connected_by = public.app_user_id())
);
drop policy if exists "platform_connections_update_rls" on public.platform_connections;
create policy "platform_connections_update_rls" on public.platform_connections for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
) with check (
  (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id)))
  and (connected_by is null or connected_by = public.app_user_id())
);

drop policy if exists "capacity_logs_insert_rls" on public.capacity_logs;
create policy "capacity_logs_insert_rls" on public.capacity_logs for insert to authenticated with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
  and public.employee_visible_by_id(agent_id)
);

drop policy if exists "meetings_select_rls" on public.meetings;
create policy "meetings_select_rls" on public.meetings for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead') or am_agent_id = public.app_user_id()
);
drop policy if exists "meetings_insert_rls" on public.meetings;
create policy "meetings_insert_rls" on public.meetings for insert to authenticated with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id() and public.client_am_agent_is_caller(client_id))
);
drop policy if exists "meetings_update_rls" on public.meetings;
create policy "meetings_update_rls" on public.meetings for update to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id())
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and am_agent_id = public.app_user_id())
);

drop policy if exists "brief_field_schemas_write_rls" on public.brief_field_schemas;
create policy "brief_field_schemas_write_rls" on public.brief_field_schemas for all to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'am_agent')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
) with check (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead', 'am_agent')
  or (public.app_user_role() = 'seo_team_lead' and service_type = 'seo')
  or (public.app_user_role() = 'media_buying_team_lead' and service_type = 'media_buying')
  or (public.app_user_role() = 'social_media_team_lead' and service_type = 'social_media')
);

drop policy if exists "activities_select_rls" on public.activities;
create policy "activities_select_rls" on public.activities for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer')
);

drop policy if exists "meeting_recordings_objects_select_rls" on storage.objects;
create policy "meeting_recordings_objects_select_rls" on storage.objects for select to authenticated using (
  bucket_id = 'meeting-recordings' and (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead') or public.client_am_agent_is_caller((storage.foldername(name))[1]))
);
drop policy if exists "meeting_recordings_objects_insert_rls" on storage.objects;
create policy "meeting_recordings_objects_insert_rls" on storage.objects for insert to authenticated with check (
  bucket_id = 'meeting-recordings' and (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead') or public.client_am_agent_is_caller((storage.foldername(name))[1]))
);
drop policy if exists "client_contracts_select_rls" on public.client_contracts;
create policy "client_contracts_select_rls" on public.client_contracts for select to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'sales' and exists (select 1 from public.clients c where c.id = client_id and c.sales_owner_id = public.app_user_id()))
);
drop policy if exists "client_contracts_insert_rls" on public.client_contracts;
create policy "client_contracts_insert_rls" on public.client_contracts for insert to authenticated with check (
  uploaded_by = public.app_user_id() and (
    public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
    or (public.app_user_role() = 'sales' and exists (select 1 from public.clients c where c.id = client_id and c.sales_owner_id = public.app_user_id()))
  )
);
drop policy if exists "client_contracts_delete_rls" on public.client_contracts;
create policy "client_contracts_delete_rls" on public.client_contracts for delete to authenticated using (
  public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
  or (public.app_user_role() = 'sales' and exists (select 1 from public.clients c where c.id = client_contracts.client_id and c.sales_owner_id = public.app_user_id()))
);
drop policy if exists "client_contracts_objects_select_rls" on storage.objects;
create policy "client_contracts_objects_select_rls" on storage.objects for select to authenticated using (
  bucket_id = 'client-contracts' and (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead') or public.client_am_agent_is_caller((storage.foldername(name))[1]) or exists (select 1 from public.clients c where c.id = (storage.foldername(name))[1] and c.sales_owner_id = public.app_user_id()))
);
drop policy if exists "client_contracts_objects_insert_rls" on storage.objects;
create policy "client_contracts_objects_insert_rls" on storage.objects for insert to authenticated with check (
  bucket_id = 'client-contracts' and (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead') or public.client_am_agent_is_caller((storage.foldername(name))[1]) or exists (select 1 from public.clients c where c.id = (storage.foldername(name))[1] and c.sales_owner_id = public.app_user_id()))
);
drop policy if exists "client_contracts_objects_delete_rls" on storage.objects;
create policy "client_contracts_objects_delete_rls" on storage.objects for delete to authenticated using (
  bucket_id = 'client-contracts' and (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead') or public.client_am_agent_is_caller((storage.foldername(name))[1]) or exists (select 1 from public.clients c where c.id = (storage.foldername(name))[1] and c.sales_owner_id = public.app_user_id()))
);

create or replace function public.update_client_access(
  p_client_id text, p_general_email text, p_general_email_password text, p_store_platform_username text,
  p_store_platform_password text, p_social_media_username text, p_social_media_password text,
  p_ad_account_username text, p_ad_account_password text, p_ad_account_setup_type text, p_payment_card_details text
) returns public.clients language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client public.clients;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then raise exception 'Client not found'; end if;
  if not (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())) then
    raise exception 'You do not have permission to edit this client''s access details.';
  end if;
  update public.clients set general_email = p_general_email, general_email_password = p_general_email_password,
    store_platform_username = p_store_platform_username, store_platform_password = p_store_platform_password,
    social_media_username = p_social_media_username, social_media_password = p_social_media_password,
    ad_account_username = p_ad_account_username, ad_account_password = p_ad_account_password,
    ad_account_setup_type = p_ad_account_setup_type, payment_card_details = p_payment_card_details
  where id = p_client_id returning * into v_client;
  return v_client;
end;
$$;

create or replace function public.assignable_employees(p_department text)
returns table (id text, name text, role text, team text, capacity_limit integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id, u.name, u.role, u.team, u.capacity_limit from public.users u
  where u.auth_id is not null and u.deactivated_at is null
    and u.role not in ('executive', 'head_of_technical', 'ai_engineer')
    and u.team = any(case p_department when 'Creative & Design' then array['Creative & Design', 'Video Production'] else array[p_department] end);
$$;

commit;
