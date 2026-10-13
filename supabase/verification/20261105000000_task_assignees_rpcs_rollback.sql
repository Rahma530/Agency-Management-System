-- ============================================================================
-- Emergency rollback for 20261105000000_task_assignees_rpcs.sql ONLY (review round 1 version).
-- NOT a migration — lives outside supabase/migrations/ so nothing ever applies it automatically.
--
-- Two different kinds of undo, reversed in dependency order (drop callers before the things they
-- depend on; restore shared objects last so nothing references a half-restored definition):
--   (a) Objects this migration added outright — dropped completely: set_task_assignees,
--       create_task_copy, mark_task_viewed, get_capacity_snapshot, add_task_attachments_for_copies,
--       delete_task_attachment, the reverse-sync trigger + its function, the
--       (batch_id, client_id) partial unique index, the task_attachments(storage_path) index, and
--       the new owner-based storage.objects DELETE policy.
--   (b) Objects this migration only MODIFIED the body/definition of — restored to their
--       pre-migration definition, not dropped, since other things still reference them:
--       sync_legacy_assigned_to_to_task_assignees() (drops the pg_trigger_depth() guard — byte-
--       identical to 20261103000000_task_assignees_foundation.sql) and
--       task_attachments_objects_select_rls on storage.objects (byte-identical to
--       20261104100000_task_visibility_cutover.sql's folder-name -> task_visible_v2 version — the
--       ONLY version, not the OR-of-two-rules version this migration introduced).
--
-- IMPORTANT: section (b)'s restores are the repo's own migration history, NOT necessarily the
-- live database's current definition — this project has a confirmed history of production
-- drifting from what the migration files show (see 20261104100000_task_visibility_cutover_rollback.sql's
-- own note about the storage SELECT policy). Run this migration's own "VERIFY LIVE" queries
-- again, against the database you're about to roll back, before trusting section (b) verbatim;
-- if live drifted, substitute the live-confirmed text for those two definitions before running
-- this file.
--
-- Does NOT touch tasks.assigned_to, tasks.assignee_viewed_at, task_assignees, task_assignee_log,
-- the pre-existing task_attachments_objects_delete_rls policy, or anything from PR 1/PR 2 beyond
-- the two definitions named above — none of the rest was changed by
-- 20261105000000_task_assignees_rpcs.sql.
-- ============================================================================

begin;

-- (a) New objects — dropped outright, in dependency order.
drop policy if exists "task_attachments_objects_delete_own_rls" on storage.objects;

drop function if exists public.delete_task_attachment(text);
drop function if exists public.add_task_attachments_for_copies(text[], text, text, bigint, text);
drop function if exists public.get_capacity_snapshot(text[]);
drop function if exists public.mark_task_viewed(text);
drop function if exists public.create_task_copy(text, text, text, text, date, text, numeric, text, text, text, text, text[]);
drop function if exists public.set_task_assignees(text, text[]);

drop trigger if exists sync_task_assignees_to_legacy_assigned_to_trigger on public.task_assignees;
drop function if exists public.sync_task_assignees_to_legacy_assigned_to();

drop index if exists public.idx_task_attachments_storage_path;
drop index if exists public.idx_tasks_batch_client_unique;

-- (b) Restore sync_legacy_assigned_to_to_task_assignees() to its pre-migration body (no
--     pg_trigger_depth() guard) — byte-identical to 20261103000000_task_assignees_foundation.sql.
--     The trigger attachment itself was never changed by either migration, so it's left alone.
create or replace function public.sync_legacy_assigned_to_to_task_assignees()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    if new.assigned_to is not null then
      insert into public.task_assignees (task_id, user_id, added_by, viewed_at)
      values (new.id, new.assigned_to, new.created_by, new.assignee_viewed_at)
      on conflict (task_id, user_id) do update set viewed_at = excluded.viewed_at;

      insert into public.task_assignee_log (task_id, user_id, action, actor_id)
      values (new.id, new.assigned_to, 'added', new.created_by);
    end if;
    return new;
  end if;

  -- TG_OP = 'UPDATE'
  if new.assigned_to is distinct from old.assigned_to then
    if old.assigned_to is not null then
      delete from public.task_assignees where task_id = old.id and user_id = old.assigned_to;

      insert into public.task_assignee_log (task_id, user_id, action, actor_id)
      values (old.id, old.assigned_to, 'removed', new.created_by);
    end if;

    if new.assigned_to is not null then
      insert into public.task_assignees (task_id, user_id, added_by, viewed_at)
      values (new.id, new.assigned_to, new.created_by, new.assignee_viewed_at)
      on conflict (task_id, user_id) do update set viewed_at = excluded.viewed_at;

      insert into public.task_assignee_log (task_id, user_id, action, actor_id)
      values (new.id, new.assigned_to, 'added', new.created_by);
    end if;

  elsif new.assignee_viewed_at is distinct from old.assignee_viewed_at and new.assigned_to is not null then
    update public.task_assignees
    set viewed_at = new.assignee_viewed_at
    where task_id = new.id and user_id = new.assigned_to;
  end if;

  return new;
end;
$$;

revoke all on function public.sync_legacy_assigned_to_to_task_assignees() from public, anon, authenticated;

-- (b) Restore the storage.objects SELECT policy to its pre-migration (folder-name -> task id ->
--     task_visible_v2 ONLY, no OR'd path-based rule) definition — byte-identical to
--     20261104100000_task_visibility_cutover.sql.
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

commit;
