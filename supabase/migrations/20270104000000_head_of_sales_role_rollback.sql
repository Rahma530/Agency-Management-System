-- Rollback for 20270104000000_head_of_sales_role.sql — restores users_role_valid_guard() and
-- clients_select_rls to their exact pre-migration form (removes the 'head_of_sales' branch from
-- both). Does NOT delete any existing public.custom_roles rows or revert any user's role value —
-- if any user was already set to 'head_of_sales' before this rollback runs, their next role-change
-- attempt will fail validation (as intended: 'head_of_sales' is no longer a recognized role after
-- this rollback) and, if the earlier migration's RLS branch is gone too, they will fall into the
-- generic `else` clients_select_rls branch (effectively zero client rows) rather than erroring.

begin;

create or replace function public.users_role_valid_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if tg_op = 'UPDATE' and new.role is not distinct from old.role then
    return new;
  end if;

  if new.role = any (array[
    'executive', 'head_of_technical', 'sales', 'am_team_lead', 'am_agent',
    'media_buying_team_lead', 'media_buying_agent', 'seo_team_lead', 'seo_agent',
    'seo_content_agent', 'seo_backlink_agent', 'store_manager', 'programming_agent',
    'social_media_team_lead', 'social_media_agent', 'graphic_designer', 'video_editor',
    'ai_engineer', 'marketing_manager'
  ]) then
    return new;
  end if;

  if exists (select 1 from public.custom_roles cr where cr.id = new.role and cr.is_active) then
    return new;
  end if;

  raise exception 'Role "%" is not a valid role.', new.role;
end;
$$;

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
    when 'marketing_manager' then (
      is_inhouse
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
