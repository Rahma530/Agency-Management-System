begin;

create or replace function public.user_role_by_id(p_id text)
returns text
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$ select u.role from public.users u where u.id = p_id $$;
revoke all on function public.user_role_by_id(text) from public, anon;
grant execute on function public.user_role_by_id(text) to authenticated, service_role;

create or replace function public.task_directory()
returns table(id text, name text, role text, team text)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select u.id, u.name, u.role, u.team
  from public.users u
  where public.app_user_role() <> 'sales'
$$;
revoke all on function public.task_directory() from public, anon;
grant execute on function public.task_directory() to authenticated, service_role;

create or replace function public.assignable_employees(p_department text)
returns table(id text, name text, role text, team text, capacity_limit integer)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select u.id, u.name, u.role, u.team, u.capacity_limit
  from public.users u
  where u.auth_id is not null
    and u.deactivated_at is null
    and u.role <> 'sales'
    and (
      u.role not in ('executive', 'head_of_technical')
      or (u.role = 'head_of_technical' and public.app_user_role() = 'executive')
    )
    and u.team = any(
      case p_department
        when 'Creative & Design' then array['Creative & Design', 'Video Production']
        else array[p_department]
      end
    );
$$;

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

commit;
