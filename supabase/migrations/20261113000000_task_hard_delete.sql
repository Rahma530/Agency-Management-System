-- Task hard delete — executive/head_of_technical/ai_engineer only.
--
-- Additive only. Tasks has never had a DELETE policy or a `grant delete` (confirmed by audit: no
-- `tasks_delete_rls` anywhere, no `grant delete on public.tasks` anywhere) — this migration does
-- NOT add one. The only way to delete a task stays this one SECURITY DEFINER function, which
-- bypasses RLS/grants entirely by running as the function owner (same posture every other
-- write-restricting RPC in this schema already uses — set_task_assignees, mark_task_viewed,
-- add_task_attachments_for_copies, etc. all write to tables the calling role has no direct grant
-- on). A client-side `tasks.delete()` call still has nothing to succeed against.
--
-- FK audit this migration relies on (public.tasks and everything that references it):
--   task_assignees.task_id        -> ON DELETE CASCADE (20261103000000_task_assignees_foundation.sql)
--   task_platform_links.task_id   -> ON DELETE CASCADE (20261108000000_task_platforms.sql)
--   task_comments.task_id         -> RESTRICT/NO ACTION (no `on delete` clause, canonical_schema_v4)
--   task_attachments.task_id      -> RESTRICT/NO ACTION (no `on delete` clause, canonical_schema_v4)
--   tasks.parent_task_id (self)   -> RESTRICT/NO ACTION (no `on delete` clause, canonical_schema_v4)
--   task_assignee_log.task_id     -> no FK constraint at all (plain text column)
-- task_assignees/task_platform_links need no handling below — Postgres cascades them on its own.
-- task_comments/task_attachments/task_assignee_log are deleted explicitly below, in their own
-- DELETE statements, BEFORE the tasks DELETE — required, since their RESTRICT FK would otherwise
-- reject deleting a task they still point to.
--
-- parent_task_id (self-referential, RESTRICT) needs no such care: the whole subtree (a task and
-- every descendant found via parent_task_id, any depth) is removed by ONE `delete from
-- public.tasks where id = any(...)` statement below. A NOT DEFERRABLE foreign key's RI check in
-- Postgres still only runs at the END of the statement that fired it (not per row) — so by the
-- time the self-referential check for any deleted row actually runs, every row in the same
-- DELETE's target list (parent and child alike) is already gone, and there is nothing left to
-- violate the constraint.
--
-- Storage: task_attachments.storage_path points at a REAL uploaded object in the 'task-attachments'
-- Storage bucket (not a pasted link). This migration deletes only the task_attachments metadata
-- row, never touches storage.objects — identical posture to the existing delete_task_attachment()
-- (20261105000000_task_assignees_rpcs.sql, section 9b), which was already deliberately scoped to
-- metadata only "because Storage deletion needs the Storage API, not raw SQL on storage.objects"
-- (per its own header comment). A hard-deleted task's uploaded files are therefore left behind as
-- orphaned objects in the bucket — a pre-existing gap this migration does not widen, and does not
-- attempt to close (that needs a Storage-API-capable caller — edge function or client — not SQL).
begin;

-- ----------------------------------------------------------------------------
-- 1. deletion_log — append-only audit trail for hard deletes (tasks today; entity_type also
--    allows 'client' so a future client hard-delete can log through the same table without a
--    new migration).
-- ----------------------------------------------------------------------------
create table public.deletion_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('task', 'client')),
  entity_id text not null,
  entity_name text not null,
  deleted_by text not null,
  deleted_at timestamptz not null default now(),
  snapshot jsonb not null,
  related_counts jsonb not null
);

create index idx_deletion_log_entity on public.deletion_log (entity_type, entity_id);
create index idx_deletion_log_deleted_at on public.deletion_log (deleted_at desc);

alter table public.deletion_log enable row level security;

create policy "deletion_log_select_rls" on public.deletion_log
for select to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer'));

-- No insert/update/delete policy at all — every row is written only by delete_tasks() below
-- (SECURITY DEFINER, runs as the function owner, so it bypasses RLS/grants regardless), never by
-- a client statement directly.

revoke all on public.deletion_log from public, anon;
grant select on public.deletion_log to authenticated;

-- ----------------------------------------------------------------------------
-- 2. delete_tasks(p_task_ids) — hard-deletes each given task AND its full subtree (every
--    descendant reachable via parent_task_id, any depth), logging one deletion_log row per
--    REQUESTED id (not per descendant) before anything is removed.
-- ----------------------------------------------------------------------------
create or replace function public.delete_tasks(p_task_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text := public.app_user_role();
  v_actor_id text := public.app_user_id();
  v_task_id text;
  v_task public.tasks;
  v_subtree_ids text[];
  v_all_ids text[] := array[]::text[];
  v_subtasks_count integer;
  v_comments_count integer;
  v_attachments_count integer;
  v_deleted_count integer;
begin
  if v_actor_role not in ('executive', 'head_of_technical', 'ai_engineer') then
    raise exception 'Only executive, head_of_technical, or ai_engineer may hard-delete tasks.';
  end if;

  if p_task_ids is null or array_length(p_task_ids, 1) is null then
    raise exception 'p_task_ids must not be empty.';
  end if;

  if array_length(p_task_ids, 1) > 200 then
    raise exception 'Cannot delete more than 200 tasks in a single call (got %).', array_length(p_task_ids, 1);
  end if;

  -- Snapshot + log pass. One row per element of p_task_ids (the ids the caller actually asked
  -- for) — a descendant pulled in only because its ancestor was requested does NOT get its own
  -- deletion_log row; its removal is accounted for in its ancestor's related_counts.subtasks.
  -- An id that no longer exists (already deleted, or never did) is silently skipped — not an
  -- error, since the end state the caller wants ("this id is gone") already holds.
  foreach v_task_id in array p_task_ids loop
    select * into v_task from public.tasks where id = v_task_id;
    if v_task.id is null then
      continue;
    end if;

    with recursive subtree as (
      select t.id from public.tasks t where t.id = v_task_id
      union all
      select c.id from public.tasks c join subtree s on c.parent_task_id = s.id
    )
    select array_agg(id) into v_subtree_ids from subtree;

    v_subtasks_count := array_length(v_subtree_ids, 1) - 1;
    select count(*) into v_comments_count from public.task_comments where task_id = any(v_subtree_ids);
    select count(*) into v_attachments_count from public.task_attachments where task_id = any(v_subtree_ids);

    insert into public.deletion_log (entity_type, entity_id, entity_name, deleted_by, snapshot, related_counts)
    values (
      'task',
      v_task.id,
      v_task.title,
      v_actor_id,
      to_jsonb(v_task),
      jsonb_build_object('subtasks', v_subtasks_count, 'comments', v_comments_count, 'attachments', v_attachments_count)
    );

    v_all_ids := v_all_ids || v_subtree_ids;
  end loop;

  if array_length(v_all_ids, 1) is null then
    return jsonb_build_object(
      'requested_count', array_length(p_task_ids, 1),
      'deleted_task_ids', '[]'::jsonb,
      'total_deleted_count', 0
    );
  end if;

  -- Dedupe: a requested id that is itself a descendant of another requested id (both selected
  -- explicitly by the caller) would otherwise appear twice in v_all_ids — harmless to the deletes
  -- below (ANY() against a list with duplicates is a no-op the second time), but dedupe keeps
  -- the returned total_deleted_count (and GET DIAGNOSTICS row_count below) honest.
  select array_agg(distinct x) into v_all_ids from unnest(v_all_ids) as x;

  -- Order matters: task_comments/task_attachments/task_assignee_log have a RESTRICT FK (or, for
  -- task_assignee_log, no FK but still logically child data) pointing at tasks.id — they must be
  -- cleared in their own statements before the tasks themselves are deleted. task_assignees and
  -- task_platform_links need no statement here — their own ON DELETE CASCADE handles them as part
  -- of the final `delete from public.tasks` below.
  delete from public.task_comments where task_id = any(v_all_ids);
  delete from public.task_attachments where task_id = any(v_all_ids);
  delete from public.task_assignee_log where task_id = any(v_all_ids);

  delete from public.tasks where id = any(v_all_ids);
  get diagnostics v_deleted_count = row_count;

  return jsonb_build_object(
    'requested_count', array_length(p_task_ids, 1),
    'deleted_task_ids', to_jsonb(v_all_ids),
    'total_deleted_count', v_deleted_count
  );
end;
$$;

revoke all on function public.delete_tasks(text[]) from public, anon;
grant execute on function public.delete_tasks(text[]) to authenticated, service_role;

commit;
