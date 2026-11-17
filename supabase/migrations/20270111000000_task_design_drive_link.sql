-- Owner correction (2026-11-17): the Design Drive link must NOT be resolved live from the client
-- record on every render (that was this feature's first draft, shipped in
-- 20270110000000_client_design_drive_link.sql and PR #322). The owner asked explicitly for a
-- separate, fixed field stored directly on the task itself instead — so a task's Drive link is
-- locked in at the moment the task is created and never silently changes afterward just because
-- someone later edits the client's own link (e.g. the AM fixes a typo, or points the client at a
-- reorganized folder for *future* work only).
--
-- clients.design_drive_link (added in 20270110000000) is kept as-is and remains the SOURCE value
-- the AM edits on the client record — this migration just stops tasks from reading it live and
-- instead snapshots it once, into this new column, at task-creation time (create_task_copy below).
-- Deliberately still not a reuse of the separately-deprecated tasks.drive_link (task-scoped manual
-- link field, phased out in favor of done_link — unrelated concept).
begin;

alter table public.tasks add column if not exists design_drive_link text;

comment on column public.tasks.design_drive_link is
  'Snapshot of the client''s design_drive_link (clients.design_drive_link) taken once, at task-creation time, by create_task_copy(). Fixed on this task from then on — editing the client''s link afterward does not change already-created tasks.';

comment on column public.clients.design_drive_link is
  'Google Drive (or similar) folder link for this client''s design/creative assets, set by the AM. Copied onto each new task for this client at creation time (see tasks.design_drive_link) — editing it here only affects tasks created afterward, not existing ones.';

-- create_task_copy(): same 13-parameter signature as 20270103000000_retire_in_review_add_edit_status.sql
-- (CREATE OR REPLACE, no new parameter — this is purely an internal behavior change), now also
-- snapshotting the client's current design_drive_link into the new task row's own column.
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
  p_status text default 'todo'
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
    task_type, task_type_other, batch_id, design_drive_link
  ) values (
    v_id, p_client_id, p_title, p_description, null, public.app_user_id(), p_team, p_status,
    p_due_date, p_priority, p_estimated_hours, 0, p_parent_task_id,
    p_task_type, p_task_type_other, p_batch_id, v_design_drive_link
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

revoke all on function public.create_task_copy(text, text, text, text, date, text, numeric, text, text, text, text, text[], text) from public, anon;
grant execute on function public.create_task_copy(text, text, text, text, date, text, numeric, text, text, text, text, text[], text) to authenticated, service_role;

commit;
