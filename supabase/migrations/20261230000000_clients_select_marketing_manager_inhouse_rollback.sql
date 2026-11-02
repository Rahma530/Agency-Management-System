-- Rollback for 20261230000000_clients_select_marketing_manager_inhouse.sql — restores
-- clients_select_rls to its exact pre-fix form (20261124000000_ai_engineer_deprivilege.sql),
-- i.e. removes the explicit marketing_manager branch so it falls back into the generic `else`.
begin;

drop policy if exists "clients_select_rls" on public.clients;
create policy "clients_select_rls"
on public.clients
for select
to authenticated
using (
  case public.app_user_role()
    when 'sales' then sales_owner_id = public.app_user_id()
    when 'executive' then true
    when 'head_of_technical' then true
    when 'am_team_lead' then true
    when 'am_agent' then am_agent_id = public.app_user_id()
    when 'media_buying_team_lead' then true
    when 'media_buying_agent' then public.agent_assigned(id, 'media_buying')
    when 'seo_team_lead' then true
    when 'social_media_team_lead' then true
    when 'seo_agent' then (
      public.agent_assigned(id, 'seo')
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
      )
    )
    when 'social_media_agent' then (
      public.agent_assigned(id, 'social_media')
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
      )
    )
    else exists (
      select 1
      from public.tasks t
      where t.client_id = clients.id
        and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
    )
  end
);

commit;
