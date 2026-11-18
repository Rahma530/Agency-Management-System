-- Fix: a newly created task could permanently sort BELOW every task in its destination status
-- column, however recently it was created — reported as "the newest task always shows at the
-- bottom of To Do" on the Team Task Board (2026-11-18).
--
-- Root cause (confirmed by reading the code, not guessed): CrossTeamTaskBoard.tsx's sortedTasks
-- treats ANY task with a non-null sort_order as sorting strictly before ANY task with a null one
-- (manual drag position always wins over the newest/oldest date toggle). reorderTaskList (the
-- drag handler) reindexes the WHOLE status column it's called on, not just the two tasks being
-- swapped — so dragging even ONE task once assigns a concrete sort_order to every other task
-- already visible in that column at that moment. From then on, every brand-new task in that same
-- column starts with sort_order = null and is permanently stuck below all of them, no matter how
-- new it is.
--
-- Fix: create_task_copy accepts a new, optional trailing p_sort_order parameter. The frontend
-- (createTaskCopies in taskOperations.ts, called from handleCreateTask/handleDuplicateTask in
-- App.tsx) computes this as (the lowest existing sort_order among tasks already in the
-- destination status) - 1 whenever that status already has any manually-ordered tasks, so the new
-- task is pinned above all of them; when no task in that status has been manually ordered yet, it
-- passes nothing and sort_order stays null, same as before (the ordinary date-sort path already
-- puts newest first with no extra data needed).
--
-- CREATE OR REPLACE with a new trailing parameter that has a DEFAULT is backward compatible — it
-- does not change the function's existing 13-parameter call signature's behavior for any caller
-- that omits it, so no `drop function` is needed here (unlike 20261030500000_protect_client_
-- access_columns.sql's update_client_access, which had to drop first because it changed the
-- RETURN type, not just the parameter list).
begin;

create or replace function public.create_task_copy(
  p_client_id text,
  p_title text,
  p_description text,
  p_team text,
  p_due_date date,
  p_priority text,
  p_estimated_hours numeric default null,
  p_task_type text default null,
  p_task_type_other text default null,
  p_parent_task_id text default null,
  p_batch_id text default null,
  p_assignee_ids text[] default null,
  p_status text default 'todo',
  p_sort_order integer default null
)
returns public.tasks
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_task public.tasks;
  v_id text := 'tsk-' || gen_random_uuid()::text;
  v_design_drive_link text;
begin
  if p_status not in ('todo', 'edit') then
    raise exception 'p_status must be todo or edit.';
  end if;

  if p_client_id is not null and not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'Client not found or not accessible.';
  end if;

  if p_client_id is not null then
    select design_drive_link into v_design_drive_link from public.clients where id = p_client_id;
  end if;

  insert into public.tasks (
    id, client_id, title, description, assigned_to, created_by, team, status,
    due_date, priority, estimated_hours, actual_hours, parent_task_id,
    task_type, task_type_other, batch_id, design_drive_link, sort_order
  ) values (
    v_id, p_client_id, p_title, p_description, null, public.app_user_id(), p_team, p_status,
    p_due_date, p_priority, p_estimated_hours, 0, p_parent_task_id,
    p_task_type, p_task_type_other, p_batch_id, v_design_drive_link, p_sort_order
  )
  on conflict (batch_id, client_id) where batch_id is not null do nothing
  returning * into v_task;

  if not found then
    select * into v_task from public.tasks where batch_id = p_batch_id and client_id = p_client_id;
    if not found then
      raise exception 'A task for this batch and client already exists but is not accessible to you.';
    end if;
    return v_task;
  end if;

  if p_assignee_ids is not null and array_length(p_assignee_ids, 1) is not null then
    perform public.set_task_assignees(v_task.id, p_assignee_ids);
  end if;

  select * into v_task from public.tasks where id = v_task.id;

  return v_task;
end;
$$;

revoke all on function public.create_task_copy(text, text, text, text, date, text, numeric, text, text, text, text, text[], text, integer) from public, anon;
grant execute on function public.create_task_copy(text, text, text, text, date, text, numeric, text, text, text, text, text[], text, integer) to authenticated, service_role;

commit;
