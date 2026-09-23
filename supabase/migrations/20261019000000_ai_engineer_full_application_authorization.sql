-- Make AI Engineer authorization explicit at the remaining application-access boundaries.
-- Existing ownership and data-integrity predicates remain unchanged.
begin;

create or replace function public.employee_visible(target_id text, target_role text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.app_user_role() = 'ai_engineer'
    or target_id = public.app_user_id()
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
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
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
  select public.app_user_role() = 'ai_engineer'
    or target_id = public.app_user_id()
    or public.app_user_role() in ('executive', 'head_of_technical')
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
    when public.app_user_role() = 'ai_engineer' then true
    when p_client_id is not null then (
      public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
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

create or replace function public.mark_brief_viewed(p_brief_id text)
returns public.briefs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_brief public.briefs;
begin
  select * into v_brief from public.briefs where id = p_brief_id;
  if not found then
    raise exception 'Brief not found';
  end if;
  if not (
    public.app_user_role() = 'ai_engineer'
    or (public.app_user_role() = 'seo_team_lead' and v_brief.service_type = 'seo' and public.client_has_service(v_brief.client_id, 'seo'))
    or (public.app_user_role() = 'media_buying_team_lead' and v_brief.service_type = 'media_buying' and public.client_has_service(v_brief.client_id, 'media_buying'))
    or (public.app_user_role() = 'social_media_team_lead' and v_brief.service_type = 'social_media' and public.client_has_service(v_brief.client_id, 'social_media'))
  ) then
    raise exception 'You do not have permission to mark this brief as viewed.';
  end if;
  update public.briefs set team_lead_viewed_at = now()
  where id = p_brief_id returning * into v_brief;
  return v_brief;
end;
$$;

create or replace function public.update_client_access(
  p_client_id text, p_general_email text, p_general_email_password text, p_store_platform_username text,
  p_store_platform_password text, p_social_media_username text, p_social_media_password text,
  p_ad_account_username text, p_ad_account_password text, p_ad_account_setup_type text, p_payment_card_details text
) returns public.clients language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client public.clients;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then raise exception 'Client not found'; end if;
  if not (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or (public.app_user_role() = 'am_agent' and v_client.am_agent_id = public.app_user_id())
  ) then
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

alter policy "client_contracts_objects_select_rls" on storage.objects using (
  bucket_id = 'client-contracts' and (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
    or exists (select 1 from public.clients c where c.id = (storage.foldername(name))[1] and c.sales_owner_id = public.app_user_id())
  )
);

alter policy "meeting_recordings_objects_insert_rls" on storage.objects with check (
  bucket_id = 'meeting-recordings' and (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
  )
);

alter policy "meeting_recordings_objects_select_rls" on storage.objects using (
  bucket_id = 'meeting-recordings' and (
    public.app_user_role() = 'ai_engineer'
    or public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
    or public.client_am_agent_is_caller((storage.foldername(name))[1])
  )
);

commit;
