-- PR 2 of the task-assignees project, step 2 — THE CUTOVER. Rewrites every policy/function that
-- read tasks.assigned_to for an access decision to use task_visible_v2()/task_closable() (added in
-- 20261104000000_task_visibility_functions.sql) instead, swaps the 3 task-derived-client fragments
-- in clients_select_rls and the 1 in employee_visible() from "assigned_to = caller" to a
-- task_assignees membership check, and fixes the pre-existing tasks_insert_rls subtask-check bug
-- along the way. Every grant on every table is left completely untouched — only functions and
-- policies are replaced here. task_visible(text, text, text) itself is deliberately left in place,
-- unused, per the note at the bottom of this file.
--
-- tasks_select_rls/tasks_update_rls additionally keep an inline, column-only creator carve-out
-- (created_by = app_user_id() and role <> 'sales') OR'd ahead of task_visible_v2(id) — see the
-- comment at that section. task_closable() already covers "creator may close"; the update policy's
-- closing gate also ORs in the same plain column check directly, for the same reason.
--
-- Idempotent: every change here is `create or replace function` or `drop policy if exists` +
-- `create policy`, so re-running this file is safe.
begin;

-- ----------------------------------------------------------------------------
-- 1. employee_visible() — byte-identical to the latest definition
--    (20261101600000_custom_roles_employee_visibility.sql) except the one task-derived-client
--    fragment (originally at its line ~61), swapped from "assigned_to = caller" to a
--    task_assignees membership check.
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
          or exists (
            select 1 from public.tasks t
            where t.client_id = c.id
              and exists (select 1 from public.task_assignees ta where ta.task_id = t.id and ta.user_id = public.app_user_id())
          )
        )
      )
    )
    -- Additive arm (a): a custom role in a shared-resource department (e.g. Creative & Design) is
    -- visible to every non-sales employee, exactly like graphic_designer/video_editor above.
    or (
      public.app_user_role() <> 'sales'
      and exists (
        select 1 from public.custom_roles cr
        join public.departments d on d.id = cr.department_id
        where cr.id = target_role and cr.is_active and d.is_shared_resource
      )
    )
    -- Additive arm (b): a custom role sees its own department's peers only when explicitly
    -- granted employees.view_department_peers (department default or per-role override).
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
-- 2. tasks_select_rls / tasks_update_rls / tasks_insert_rls
-- ----------------------------------------------------------------------------
-- Both policies below OR in an inline, column-only creator carve-out ahead of task_visible_v2(id)
-- — the same shape the live policies already use today (created_by = caller, not sales). This
-- isn't a second grant: task_visible_v2() already includes a creator branch. It's here because
-- task_visible_v2(id) re-SELECTs the row from public.tasks by id, and for a row this same command
-- just inserted, that re-SELECT's visibility depends on timing a SECURITY DEFINER function doing a
-- fresh scan shouldn't be relied on for — a plain `created_by = app_user_id()` compares the row's
-- own column directly, with no re-SELECT involved, so the creator's view of their own row (via
-- INSERT ... RETURNING, or any later SELECT) never depends on that timing at all.
drop policy if exists tasks_select_rls on public.tasks;
create policy tasks_select_rls on public.tasks for select to authenticated
using (
  (created_by = public.app_user_id() and public.app_user_role() <> 'sales')
  or public.task_visible_v2(id)
);

drop policy if exists tasks_update_rls on public.tasks;
create policy tasks_update_rls on public.tasks for update to authenticated
using (
  (created_by = public.app_user_id() and public.app_user_role() <> 'sales')
  or public.task_visible_v2(id)
)
with check (
  ((created_by = public.app_user_id() and public.app_user_role() <> 'sales') or public.task_visible_v2(id))
  and (
    status <> 'closed'
    or public.task_closable(id)
    or created_by = public.app_user_id()
  )
);

-- Escalation guard (who assigned_to may name) is untouched, byte-identical logic to the latest
-- definition. Only the subtask-parent check changes: it now calls task_visible_v2(parent_task_id)
-- — the NEW row's own parent_task_id value — instead of the old buggy subquery, which compared a
-- candidate ancestor row's id to ITS OWN parent_task_id column (always false except for a
-- self-parented row, which the nesting-depth trigger already forbids). Calling
-- task_visible_v2(parent_task_id) directly avoids that scoping trap entirely: there is no
-- correlated subquery here for an unqualified column name to accidentally resolve against.
drop policy if exists tasks_insert_rls on public.tasks;
create policy tasks_insert_rls on public.tasks for insert to authenticated
with check (
  public.app_user_role() <> 'sales'
  and created_by = public.app_user_id()
  and (
    parent_task_id is null
    or public.task_visible_v2(parent_task_id)
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
-- 3. task_comments_select_rls / task_comments_insert_rls, task_attachments_select_rls /
--    task_attachments_insert_rls (table). task_attachments_delete_rls is untouched (stays
--    uploader-only — it never called task_visible() in the first place).
-- ----------------------------------------------------------------------------
drop policy if exists task_comments_select_rls on public.task_comments;
create policy task_comments_select_rls on public.task_comments for select to authenticated
using (exists (
  select 1 from public.tasks t
  where t.id = task_comments.task_id
    and public.task_visible_v2(t.id)
));

drop policy if exists task_comments_insert_rls on public.task_comments;
create policy task_comments_insert_rls on public.task_comments for insert to authenticated
with check (
  author_id = public.app_user_id()
  and exists (
    select 1 from public.tasks t
    where t.id = task_comments.task_id
      and public.task_visible_v2(t.id)
  )
);

drop policy if exists task_attachments_select_rls on public.task_attachments;
create policy task_attachments_select_rls on public.task_attachments for select to authenticated
using (exists (
  select 1 from public.tasks t
  where t.id = task_attachments.task_id
    and public.task_visible_v2(t.id)
));

drop policy if exists task_attachments_insert_rls on public.task_attachments;
create policy task_attachments_insert_rls on public.task_attachments for insert to authenticated
with check (
  uploaded_by = public.app_user_id()
  and exists (
    select 1 from public.tasks t
    where t.id = task_attachments.task_id
      and public.task_visible_v2(t.id)
  )
);

-- ----------------------------------------------------------------------------
-- 4. storage.objects policies for the task-attachments bucket — select/insert only. Same path ->
--    task id mapping as before ((storage.foldername(name))[1]), only the visibility function
--    changes. This also fixes a standing gap: these two never had the creator carve-out the
--    table-level policies already had, so a task's creator who wasn't its assignee could see/add
--    the task_attachments metadata row but could be blocked from the underlying file itself.
--    task_visible_v2() includes the creator branch, so that gap closes here too. The storage
--    delete policy is untouched (uploader-only against the task_attachments metadata row, never
--    called task_visible() either).
-- ----------------------------------------------------------------------------
drop policy if exists "task_attachments_objects_select_rls" on storage.objects;
create policy "task_attachments_objects_select_rls" on storage.objects
for select
to authenticated
using (
  bucket_id = 'task-attachments'
  and exists (
    select 1 from public.tasks t
    where t.id = (storage.foldername(name))[1]
      and public.task_visible_v2(t.id)
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
    where t.id = (storage.foldername(name))[1]
      and public.task_visible_v2(t.id)
  )
);

-- ----------------------------------------------------------------------------
-- 5. clients_select_rls — byte-identical to the latest definition
--    (20261031700000_restore_ai_engineer_client_select_rls.sql) except the 3 task-derived
--    fragments (seo_agent, social_media_agent, else), each swapped from "assigned_to = caller" to
--    a task_assignees membership check.
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

-- ----------------------------------------------------------------------------
-- 6. task_visible(text, text, text) — deliberately NOT dropped. It is now unreferenced by any
--    policy (every caller above was rewritten to task_visible_v2), but left in place as-is so this
--    migration carries zero risk of a "cannot drop function, other objects depend on it" failure
--    if something outside this repo's own migrations still calls it. DEPRECATED — scheduled for
--    removal in a later cleanup PR, once it's confirmed nothing else references it.
-- ----------------------------------------------------------------------------

commit;
