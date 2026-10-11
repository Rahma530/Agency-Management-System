-- ============================================================================
-- Emergency rollback for 20261104100000_task_visibility_cutover.sql ONLY.
-- NOT a migration — lives outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Restores employee_visible(), tasks_select_rls, tasks_update_rls, tasks_insert_rls,
-- task_comments_select/insert_rls, task_attachments_select/insert_rls, the two storage.objects
-- policies, and clients_select_rls EXACTLY as they were defined by the latest repo migrations
-- before the cutover (20261101600000_custom_roles_employee_visibility.sql,
-- 20261101100000_task_cross_team_visibility.sql, 20260908180000_task_attachments.sql,
-- 20261031700000_restore_ai_engineer_client_select_rls.sql).
--
-- Does NOT touch 20261104000000_task_visibility_functions.sql's additions — task_visible_v2(),
-- task_closable(), and the two new indexes are left in place, unused and harmless, exactly as
-- they were immediately after Migration A and before Migration B. Run
-- 20261104000000's own rollback separately if you need to remove those too.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. employee_visible() — byte-identical to 20261101600000_custom_roles_employee_visibility.sql.
-- ----------------------------------------------------------------------------
create or replace function public.employee_visible(target_id text, target_role text)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select public.app_user_role() = 'ai_engineer'
    or target_id = public.app_user_id()
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
    or (
      target_role in ('am_agent', 'am_team_lead') and exists (
        select 1 from public.clients c
        where (c.am_agent_id = target_id or c.am_team_lead_id = target_id) and (
          public.app_user_role() in ('media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
          or (public.app_user_role() = 'media_buying_agent' and public.agent_assigned(c.id, 'media_buying'))
          or (public.app_user_role() = 'seo_agent' and public.agent_assigned(c.id, 'seo'))
          or (public.app_user_role() = 'store_manager' and public.agent_assigned(c.id, 'seo'))
          or (public.app_user_role() = 'social_media_agent' and public.agent_assigned(c.id, 'social_media'))
          or exists (select 1 from public.tasks t where t.client_id = c.id and t.assigned_to = public.app_user_id())
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

-- ----------------------------------------------------------------------------
-- 2. tasks_select_rls / tasks_update_rls / tasks_insert_rls — byte-identical to
--    20261101100000_task_cross_team_visibility.sql (bug included — this is a rollback, not a
--    partial fix).
-- ----------------------------------------------------------------------------
drop policy if exists tasks_select_rls on public.tasks;
create policy tasks_select_rls on public.tasks for select to authenticated
using (
  public.task_visible(assigned_to, parent_task_id, client_id)
  or (created_by = public.app_user_id() and public.app_user_role() <> 'sales')
);

drop policy if exists tasks_update_rls on public.tasks;
create policy tasks_update_rls on public.tasks for update to authenticated
using (
  public.task_visible(assigned_to, parent_task_id, client_id)
  or (created_by = public.app_user_id() and public.app_user_role() <> 'sales')
)
with check (
  (
    public.task_visible(assigned_to, parent_task_id, client_id)
    or (created_by = public.app_user_id() and public.app_user_role() <> 'sales')
  )
  and (
    status <> 'closed'
    or created_by = public.app_user_id()
    or assigned_to = public.app_user_id()
    or public.app_user_role() = any (array['head_of_technical', 'ai_engineer'])
  )
);

drop policy if exists tasks_insert_rls on public.tasks;
create policy tasks_insert_rls on public.tasks for insert to authenticated
with check (
  public.app_user_role() <> 'sales'
  and created_by = public.app_user_id()
  and (
    parent_task_id is null
    or exists (
      select 1 from public.tasks pt
      where pt.id = pt.parent_task_id
        and public.task_visible(pt.assigned_to, pt.parent_task_id, pt.client_id)
    )
  )
  and (
    assigned_to is null
    or assigned_to = public.app_user_id()
    or public.user_role_by_id(assigned_to) is null
    or public.user_role_by_id(assigned_to) not in ('executive', 'head_of_technical')
    or (public.app_user_role() = 'executive' and public.user_role_by_id(assigned_to) = 'head_of_technical')
  )
);

-- ----------------------------------------------------------------------------
-- 3. task_comments_select/insert_rls, task_attachments_select/insert_rls (table) — byte-identical
--    to 20261101100000_task_cross_team_visibility.sql. task_attachments_delete_rls was never
--    touched by the cutover, so nothing to restore for it.
-- ----------------------------------------------------------------------------
drop policy if exists task_comments_select_rls on public.task_comments;
create policy task_comments_select_rls on public.task_comments for select to authenticated
using (exists (
  select 1 from public.tasks t
  where t.id = task_comments.task_id
    and (public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
         or (t.created_by = public.app_user_id() and public.app_user_role() <> 'sales'))
));

drop policy if exists task_comments_insert_rls on public.task_comments;
create policy task_comments_insert_rls on public.task_comments for insert to authenticated
with check (
  author_id = public.app_user_id()
  and exists (
    select 1 from public.tasks t
    where t.id = task_comments.task_id
      and (public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
           or (t.created_by = public.app_user_id() and public.app_user_role() <> 'sales'))
  )
);

drop policy if exists task_attachments_select_rls on public.task_attachments;
create policy task_attachments_select_rls on public.task_attachments for select to authenticated
using (exists (
  select 1 from public.tasks t
  where t.id = task_attachments.task_id
    and (public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
         or (t.created_by = public.app_user_id() and public.app_user_role() <> 'sales'))
));

drop policy if exists task_attachments_insert_rls on public.task_attachments;
create policy task_attachments_insert_rls on public.task_attachments for insert to authenticated
with check (
  uploaded_by = public.app_user_id()
  and exists (
    select 1 from public.tasks t
    where t.id = task_attachments.task_id
      and (public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
           or (t.created_by = public.app_user_id() and public.app_user_role() <> 'sales'))
  )
);

-- ----------------------------------------------------------------------------
-- 4. storage.objects select/insert policies for the task-attachments bucket — restored to the
--    LIVE definition (confirmed against production pg_policies, which has drifted from
--    20260908180000_task_attachments.sql's original text): the 3-argument
--    task_visible(t.assigned_to, t.parent_task_id, t.client_id), with NO creator carve-out. This
--    is deliberately NOT what the repo's own original migration file shows — restoring the actual
--    live pre-cutover behavior is the whole point of a rollback. The storage delete policy was
--    never touched by the cutover.
-- ----------------------------------------------------------------------------
drop policy if exists "task_attachments_objects_select_rls" on storage.objects;
create policy "task_attachments_objects_select_rls" on storage.objects
for select
to authenticated
using (
  bucket_id = 'task-attachments'
  and exists (
    select 1 from public.tasks t
    where t.id = (storage.foldername(objects.name))[1]
      and public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
  )
);

drop policy if exists "task_attachments_objects_insert_rls" on storage.objects;
create policy "task_attachments_objects_insert_rls" on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'task-attachments'
  and exists (
    select 1 from public.tasks t
    where t.id = (storage.foldername(objects.name))[1]
      and public.task_visible(t.assigned_to, t.parent_task_id, t.client_id)
  )
);

-- ----------------------------------------------------------------------------
-- 5. clients_select_rls — byte-identical to 20261031700000_restore_ai_engineer_client_select_rls.sql.
-- ----------------------------------------------------------------------------
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
    when 'ai_engineer' then true
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
          and t.assigned_to = public.app_user_id()
      )
    )
    when 'social_media_agent' then (
      public.agent_assigned(id, 'social_media')
      or exists (
        select 1
        from public.tasks t
        where t.client_id = clients.id
          and t.assigned_to = public.app_user_id()
      )
    )
    else exists (
      select 1
      from public.tasks t
      where t.client_id = clients.id
        and t.assigned_to = public.app_user_id()
    )
  end
);

commit;
