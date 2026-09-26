-- Server-side match for the new "Close Task" UI gate (src/lib/taskLifecycle.ts's canCloseTask):
-- tasks_update_rls otherwise lets anyone with task_visible() update a task to any status,
-- including the new 'closed' value, with no assignee/creator restriction at all — matching this
-- session's own repeated pattern of checking that a UI-level restriction is also enforced at the
-- RLS layer for anything permission-like, rather than trusting the client alone. Every other
-- status transition is completely unaffected: this only narrows the specific case of the new
-- value being 'closed'.
begin;

drop policy if exists "tasks_update_rls" on public.tasks;
create policy "tasks_update_rls" on public.tasks
for update to authenticated
using (public.task_visible(assigned_to, parent_task_id, client_id))
with check (
  public.task_visible(assigned_to, parent_task_id, client_id)
  and (
    status <> 'closed'
    or created_by = public.app_user_id()
    or assigned_to = public.app_user_id()
    or public.app_user_role() = 'head_of_technical'
  )
);

commit;
