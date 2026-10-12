-- PR 4a of the task-assignees project — DATABASE LAYER for real multi-assignee writes. Builds on
-- PR 1 (task_assignees/task_assignee_log tables + the legacy-forward sync trigger) and PR 2
-- (task_visible_v2()/task_closable(), the cutover). Nothing here is read by the frontend yet — PR
-- 4b wires the Create/Edit Task form to these RPCs. tasks.assigned_to remains the single column
-- every existing screen (MyWorkHub's badge, every capacity/report aggregation) still reads; this
-- migration's reverse-sync trigger is what keeps it correct once an assignee list can have more
-- than one person again.
--
-- Objects added, in dependency order:
--   1. idx_tasks_batch_client_unique — partial unique index, (batch_id, client_id) where
--      batch_id is not null. Stops one "send to multiple clients" batch from producing two copies
--      for the same client (double-submit/retry) — create_task_copy() treats a conflict on it as
--      "already created, return the existing row" rather than an error (see section 5).
--   2. sync_legacy_assigned_to_to_task_assignees() — PR 1's forward trigger function, re-defined
--      with a pg_trigger_depth() guard at the top.
--   3. sync_task_assignees_to_legacy_assigned_to() + its AFTER INSERT OR DELETE trigger on
--      task_assignees — the reverse half of PR 1's one-way sync, promised but deliberately
--      deferred there. Recomputes tasks.assigned_to as the OLDEST remaining assignee
--      (min(created_at)) every time task_assignees' membership changes. ALSO guarded by
--      pg_trigger_depth() > 1, symmetrically with section 2 — see that section's comment for why
--      both sides carry the same guard rather than relying on just one.
--   4. set_task_assignees(p_task_id, p_user_ids) — the only place a task's assignee SET is ever
--      written going forward (besides the legacy forward-sync mirror).
--   5. create_task_copy(...) — SECURITY INVOKER. Inserts one new task (assigned_to left null,
--      status forced to 'todo') under the CALLER's own tasks_insert_rls, then calls
--      set_task_assignees() for the real assignee list. Idempotent per (batch_id, client_id): a
--      retried/duplicate call for a pair that already has a copy returns that existing row
--      instead of raising the unique-index violation.
--   6. mark_task_viewed(p_task_id) — SECURITY DEFINER. First-view-wins: only ever sets a viewed_at
--      that is currently null, both on the caller's own task_assignees row and (backward-compat)
--      on tasks.assignee_viewed_at.
--   7. get_capacity_snapshot(p_user_ids) — SECURITY DEFINER. Counts only, no task or client
--      content. See its own comment for the exact counting rule for each branch.
--   8. task_attachments_objects_select_rls (storage.objects) — widened to the OR of the original
--      folder-name -> task_visible_v2 rule and a new task_attachments.storage_path ->
--      task_visible_v2 rule, so both a legacy single-task file and a just-uploaded object with no
--      task_attachments row yet keep resolving under the old rule, while a file shared across
--      multiple copies (added via section 9a, below) resolves for every copy's own assignees via
--      the new rule.
--   8b. idx_task_attachments_storage_path — index backing that new rule's join.
--   9a. add_task_attachments_for_copies(...) — SECURITY INVOKER, unchanged in shape from the first
--       draft of this migration.
--   9b. delete_task_attachment(p_attachment_id) — SECURITY DEFINER. Deletes the metadata row only
--       and returns the storage_path when no other task_attachments row still references it (null
--       otherwise) — it does NOT delete the storage.objects row itself (confirmed against
--       Supabase's own docs: a SQL DELETE on storage.objects removes only the metadata row and
--       leaves the actual file orphaned in the bucket; only the Storage API's own remove endpoint
--       deletes the underlying object). The caller is responsible for calling
--       `supabase.storage.from('task-attachments').remove([path])` when a non-null path comes
--       back. See section 9c for the policy that lets that follow-up call succeed even though, by
--       then, the task_attachments row the OLD delete policy depended on is already gone.
--   9c. task_attachments_objects_delete_own_rls (storage.objects) — NEW, additive policy: the
--       uploader (owner = auth.uid()) may always delete their own object directly, independent of
--       any task_attachments row's existence. The pre-existing
--       task_attachments_objects_delete_rls policy (keyed on a task_attachments row's
--       uploaded_by) is left in place untouched; the two are simply OR'd together as permissive
--       policies, same as the SELECT policy's OR above.
--
-- Escalation/validity guard (set_task_assignees, applied ONLY to ids newly entering the list —
-- i.e. in the computed to-add set, never to an id that was already an assignee and is simply
-- being re-confirmed by resaving the list):
--   - nobody may name executive except themselves
--   - only executive may name head_of_technical (besides themselves)
--   - sales may never be assigned to a task
--   - ai_engineer is unrestricted
--   - "active, auth_id not null" likewise checked only for these newly-added ids
-- This is byte-identical in shape to tasks_insert_rls's existing assigned_to guard
-- (20261101100000_task_cross_team_visibility.sql / 20261104100000_task_visibility_cutover.sql)
-- plus the sales exclusion that single-assignee guard never had to spell out itself. Checking this
-- only against the to-add set (rather than the whole requested list) matters: a task that already
-- has, say, a head_of_technical assignee must stay editable by a non-executive actor for every
-- OTHER change (add/remove someone else, reorder) as long as that pre-existing assignee isn't
-- being newly added by this same call.
--
-- set_task_assignees additionally never lets the task's own creator be removed from its assignee
-- list (independent of who is calling), and never sends a "you were assigned" notification when
-- the new assignee IS the actor (assigning yourself needs no notification).
--
-- set_task_assignees's permission gate (round 2 revision — narrower than task_visible_v2 on
-- purpose): task_closable(p_task_id) [admin roles / creator / any current assignee] OR an am_agent
-- who manages the task's client OR an am_team_lead whose own team includes the am_agent managing
-- the task's client OR any of the 4 team-lead roles on a task visible to them via the team rule
-- (creator or any assignee on their own team, plus the seo_team_lead/Programming carve-out).
-- sales is explicitly excluded. marketing_manager is deliberately NOT included: task_visible_v2
-- gives marketing_manager visibility into a graphic_designer/video_editor's task purely so they
-- can see creative work in progress, not so they can reassign it — being able to SEE a task is not
-- the same permission as being able to manage who's on it, so this gate only replicates
-- task_visible_v2's admin/creator/assignee/am-agent/team-lead doors, never its marketing_manager
-- door. See set_task_assignees' own body for the exact SQL.
begin;

-- ----------------------------------------------------------------------------
-- 1. (batch_id, client_id) partial unique index.
-- ----------------------------------------------------------------------------
create unique index if not exists idx_tasks_batch_client_unique
  on public.tasks (batch_id, client_id)
  where batch_id is not null;

-- ----------------------------------------------------------------------------
-- 2. Forward trigger function — same body as
--    20261103000000_task_assignees_foundation.sql, with one addition: an early return when
--    pg_trigger_depth() > 1, i.e. this execution is a cascade from inside another trigger (the
--    reverse-sync trigger in section 3) rather than a direct, top-level write to
--    tasks.assigned_to/assignee_viewed_at. The reverse trigger (section 3) carries the identical
--    guard, symmetrically: only ONE side needs it to prevent an infinite loop (whichever fires
--    first stops the other from cascading back), but guarding both means neither side ever does
--    real work beyond the first, top-level trigger invocation on EITHER side of the sync, so a
--    direct write that bounces back and forth once is never mistaken for 2 separate real changes.
-- ----------------------------------------------------------------------------
create or replace function public.sync_legacy_assigned_to_to_task_assignees()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

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

-- Trigger attachment unchanged from PR 1 (same events, same timing, same function name) — not
-- re-created, only the function body above changed.

-- ----------------------------------------------------------------------------
-- 3. Reverse trigger — task_assignees membership change -> recompute tasks.assigned_to as the
--    OLDEST remaining assignee (min(created_at), tie-broken by user_id for determinism). Fires on
--    INSERT/DELETE only: an UPDATE of task_assignees.viewed_at never changes membership or
--    ordering, so it has nothing to recompute. The `is distinct from` guard means this never
--    issues a no-op UPDATE, so it never fires the forward trigger pointlessly. Carries the same
--    pg_trigger_depth() > 1 guard as section 2, for the same symmetric reason explained there.
-- ----------------------------------------------------------------------------
create or replace function public.sync_task_assignees_to_legacy_assigned_to()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task_id text := coalesce(new.task_id, old.task_id);
  v_new_assigned_to text;
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  select user_id into v_new_assigned_to
  from public.task_assignees
  where task_id = v_task_id
  order by created_at asc, user_id asc
  limit 1;

  update public.tasks
  set assigned_to = v_new_assigned_to
  where id = v_task_id
    and assigned_to is distinct from v_new_assigned_to;

  return null;
end;
$$;

revoke all on function public.sync_task_assignees_to_legacy_assigned_to() from public, anon, authenticated;

drop trigger if exists sync_task_assignees_to_legacy_assigned_to_trigger on public.task_assignees;
create trigger sync_task_assignees_to_legacy_assigned_to_trigger
after insert or delete on public.task_assignees
for each row
execute function public.sync_task_assignees_to_legacy_assigned_to();

-- ----------------------------------------------------------------------------
-- 4. set_task_assignees(p_task_id, p_user_ids) — replaces a task's full assignee set with the
--    given ordered list. Locks the task row first so two concurrent calls on the same task can't
--    race on the diff. A no-op diff (same set, any order) does nothing at all — no log row, no
--    notification, not even a touch of task_assignees.
-- ----------------------------------------------------------------------------
create or replace function public.set_task_assignees(p_task_id text, p_user_ids text[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.tasks;
  v_actor_id text := public.app_user_id();
  v_ordered_ids text[] := array[]::text[];
  v_current_ids text[];
  v_to_add text[] := array[]::text[];
  v_to_remove text[] := array[]::text[];
  v_uid text;
  v_target_role text;
  v_auth_id text;
  v_deactivated_at timestamptz;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found';
  end if;

  -- Gate — see this migration's header comment for the full rationale. Deliberately NOT
  -- task_visible_v2(id): that would also let marketing_manager (via the creative-role door) and
  -- an am_agent/am_team_lead with no real management relationship to THIS task manage its
  -- assignees merely because they can see it. Allowed:
  --   - task_closable(p_task_id): admin roles, the task's creator, or any current assignee.
  --   - am_agent who manages the task's client (client_am_agent_is_caller — same door
  --     task_visible_v2 itself uses for am_agent).
  --   - am_team_lead whose OWN team includes the am_agent managing the task's client.
  --   - any of the 4 team-lead roles, on a task visible to them via the team rule (creator or any
  --     assignee on their own team, plus the seo_team_lead/Programming carve-out) — byte-identical
  --     to task_visible_v2's own team-lead branch.
  -- sales is excluded explicitly (not just structurally — see header comment).
  if public.app_user_role() = 'sales' or not (
    public.task_closable(p_task_id)
    or (
      public.app_user_role() = 'am_agent'
      and v_task.client_id is not null
      and public.client_am_agent_is_caller(v_task.client_id)
    )
    or (
      public.app_user_role() = 'am_team_lead'
      and v_task.client_id is not null
      and exists (
        select 1 from public.clients c
        join public.users ua on ua.id = c.am_agent_id
        where c.id = v_task.client_id and ua.team = public.app_user_team()
      )
    )
    or (
      public.app_user_role() in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
      and (
        exists (select 1 from public.users u where u.id = v_task.created_by and u.team = public.app_user_team())
        or exists (
          select 1 from public.task_assignees ta
          join public.users u on u.id = ta.user_id
          where ta.task_id = p_task_id and u.team = public.app_user_team()
        )
        or (
          public.app_user_role() = 'seo_team_lead'
          and (
            exists (select 1 from public.users u where u.id = v_task.created_by and u.team = 'Programming')
            or exists (
              select 1 from public.task_assignees ta
              join public.users u on u.id = ta.user_id
              where ta.task_id = p_task_id and u.team = 'Programming'
            )
          )
        )
      )
    )
  ) then
    raise exception 'You do not have permission to modify this task''s assignees.';
  end if;

  -- Dedupe + drop nulls, preserving first-occurrence order. Order matters: among brand-new
  -- additions below, the first one listed gets the earliest clock_timestamp() and so becomes the
  -- oldest assignee (tasks.assigned_to, via the reverse trigger) if the task had none before.
  foreach v_uid in array coalesce(p_user_ids, array[]::text[]) loop
    if v_uid is not null and not (v_uid = any(v_ordered_ids)) then
      v_ordered_ids := array_append(v_ordered_ids, v_uid);
    end if;
  end loop;

  select coalesce(array_agg(user_id), array[]::text[]) into v_current_ids
  from public.task_assignees where task_id = p_task_id;

  foreach v_uid in array v_ordered_ids loop
    if not (v_uid = any(v_current_ids)) then
      v_to_add := array_append(v_to_add, v_uid);
    end if;
  end loop;

  foreach v_uid in array v_current_ids loop
    if not (v_uid = any(v_ordered_ids)) then
      v_to_remove := array_append(v_to_remove, v_uid);
    end if;
  end loop;

  -- The creator can never be removed from their own task's assignee list — independent of who is
  -- calling, and checked against the diff (not the raw requested list) so it fires exactly when
  -- the creator is CURRENTLY assigned and the new list would drop them.
  if v_task.created_by = any(v_to_remove) then
    raise exception 'The task''s creator cannot be removed from its assignee list.';
  end if;

  if array_length(v_to_add, 1) is null and array_length(v_to_remove, 1) is null then
    return;
  end if;

  -- Validity + escalation guard, applied ONLY to ids actually entering the list (v_to_add) — see
  -- this migration's header comment. A pre-existing assignee is never re-validated just because
  -- the list is being re-saved.
  foreach v_uid in array v_to_add loop
    v_target_role := public.user_role_by_id(v_uid);
    if v_target_role is null then
      raise exception 'User % not found', v_uid;
    end if;
    if v_target_role = 'sales' then
      raise exception 'sales may not be assigned to tasks';
    end if;
    if not (
      v_uid = v_actor_id
      or v_target_role not in ('executive', 'head_of_technical')
      or (public.app_user_role() = 'executive' and v_target_role = 'head_of_technical')
    ) then
      raise exception 'You are not permitted to assign %.', v_uid;
    end if;

    select auth_id, deactivated_at into v_auth_id, v_deactivated_at
    from public.users where id = v_uid;
    if v_auth_id is null or v_deactivated_at is not null then
      raise exception 'User % is not an active employee and cannot be newly assigned.', v_uid;
    end if;
  end loop;

  foreach v_uid in array v_to_remove loop
    delete from public.task_assignees where task_id = p_task_id and user_id = v_uid;
    insert into public.task_assignee_log (task_id, user_id, action, actor_id)
    values (p_task_id, v_uid, 'removed', v_actor_id);
    -- Deliberately no notification: the removed person would open a link into a task
    -- task_visible_v2 has already stopped showing them, the moment their row is gone.
  end loop;

  foreach v_uid in array v_to_add loop
    insert into public.task_assignees (task_id, user_id, added_by, created_at)
    values (p_task_id, v_uid, v_actor_id, clock_timestamp());
    insert into public.task_assignee_log (task_id, user_id, action, actor_id)
    values (p_task_id, v_uid, 'added', v_actor_id);

    -- No notification when you assign yourself — nothing to tell yourself you don't already know.
    if v_uid <> v_actor_id then
      insert into public.notifications (id, user_id, title, message, sender_id, is_read, type, link_url, created_at)
      values (
        'notif-' || gen_random_uuid()::text,
        v_uid,
        'New Task Assigned',
        'You have been assigned a new task: ' || v_task.title || '.',
        v_actor_id,
        false,
        'task_assigned',
        'module:tasks',
        now()
      );
    end if;
  end loop;
end;
$$;

revoke all on function public.set_task_assignees(text, text[]) from public, anon;
grant execute on function public.set_task_assignees(text, text[]) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. create_task_copy(...) — SECURITY INVOKER on purpose: the INSERT below runs under the
--    CALLER's own tasks_insert_rls (role <> sales, created_by = caller, parent_task_id visible —
--    all already enforced there with no need to duplicate any of it here), with assigned_to
--    always null at insert time, so that policy's own assignee-escalation branch is always
--    trivially satisfied too. set_task_assignees() (SECURITY DEFINER) is called afterward for the
--    real assignee list — the one and only path that can ever put someone other than null into
--    this task's assignee set. One call creates one task; a "send to multiple clients" batch calls
--    this once per client, passing the same p_batch_id each time.
--
--    Idempotent per (batch_id, client_id): ON CONFLICT DO NOTHING against the partial unique
--    index means a retried/duplicate call for a pair that already has a copy inserts nothing;
--    the fallback SELECT (also under the caller's own RLS) then returns that EXISTING row instead
--    of raising. Race-safe because Postgres's own ON CONFLICT handling blocks a conflicting
--    inserter until the winning transaction commits, so by the time the fallback SELECT runs, the
--    other copy is guaranteed to already be visible (if it's visible to this caller at all) — an
--    existing-but-invisible-to-this-caller row is treated as an error, not silently returned.
-- ----------------------------------------------------------------------------
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
  p_assignee_ids text[] default null
)
returns public.tasks
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_task public.tasks;
  v_id text := 'tsk-' || gen_random_uuid()::text;
begin
  -- The tasks.client_id foreign key only checks EXISTENCE (FK checks bypass RLS, running as the
  -- table owner) — it would happily let a caller reference a real client they can't actually see.
  -- This EXISTS, run under SECURITY INVOKER, goes through clients_select_rls as the caller, so an
  -- existing-but-invisible client is rejected exactly like a nonexistent one.
  if p_client_id is not null and not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'Client not found or not accessible.';
  end if;

  insert into public.tasks (
    id, client_id, title, description, assigned_to, created_by, team, status,
    due_date, priority, estimated_hours, actual_hours, parent_task_id,
    task_type, task_type_other, batch_id
  ) values (
    v_id, p_client_id, p_title, p_description, null, public.app_user_id(), p_team, 'todo',
    p_due_date, p_priority, p_estimated_hours, 0, p_parent_task_id,
    p_task_type, p_task_type_other, p_batch_id
  )
  on conflict (batch_id, client_id) where batch_id is not null do nothing
  returning * into v_task;

  if not found then
    -- Idempotent retry: a copy for this batch+client pair already exists. Return it (under the
    -- caller's own RLS) instead of failing on the unique index.
    select * into v_task from public.tasks where batch_id = p_batch_id and client_id = p_client_id;
    if not found then
      raise exception 'A task for this batch and client already exists but is not accessible to you.';
    end if;
    return v_task;
  end if;

  if p_assignee_ids is not null and array_length(p_assignee_ids, 1) is not null then
    perform public.set_task_assignees(v_task.id, p_assignee_ids);
  end if;

  -- Re-select: set_task_assignees()'s inserts into task_assignees fire the reverse-sync trigger
  -- (section 3) synchronously, so by now tasks.assigned_to reflects the real assignee list —
  -- the row captured by the RETURNING clause above always had assigned_to = null.
  select * into v_task from public.tasks where id = v_task.id;

  return v_task;
end;
$$;

revoke all on function public.create_task_copy(text, text, text, text, date, text, numeric, text, text, text, text, text[]) from public, anon;
grant execute on function public.create_task_copy(text, text, text, text, date, text, numeric, text, text, text, text, text[]) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. mark_task_viewed(p_task_id) — SECURITY DEFINER: task_assignees has no UPDATE grant for
--    authenticated at all (PR 1's own comment), so the first write below is impossible without it.
--    First-view-wins: both writes are gated on the target column currently being null, so a
--    second call (opening the task again later) never overwrites the original "first viewed at"
--    moment. By construction this can only ever touch the CALLING user's own task_assignees row
--    and the task's assignee_viewed_at column when the caller is specifically its current legacy
--    assigned_to — there is no parameter a caller could pass to touch anyone else's data, same
--    reasoning as touch_last_seen() (20261030200000_touch_last_seen_rpc.sql).
-- ----------------------------------------------------------------------------
create or replace function public.mark_task_viewed(p_task_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.task_assignees
  set viewed_at = now()
  where task_id = p_task_id and user_id = public.app_user_id() and viewed_at is null;

  -- Backward-compat mirror for MyWorkHub's existing `!assignee_viewed_at` badge check, which still
  -- reads the single legacy column — only meaningful while the caller IS the legacy assigned_to.
  update public.tasks
  set assignee_viewed_at = now()
  where id = p_task_id and assigned_to = public.app_user_id() and assignee_viewed_at is null;
end;
$$;

revoke all on function public.mark_task_viewed(text) from public, anon;
grant execute on function public.mark_task_viewed(text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. get_capacity_snapshot(p_user_ids) — SECURITY DEFINER, counts only, no task or client content.
--
--    am_agent/am_team_lead branch: byte-identical to capacity.ts's getUserCapacityData
--    (src/lib/capacity.ts) — both roles are measured by clients.am_agent_id = this user's id
--    (NOT am_team_lead_id; capacity.ts filters assignedClients by am_agent_id regardless of which
--    of the two roles the user holds, so a team lead's count is literally "clients where THEY
--    personally are am_agent_id", same as the agent case), excluding status = 'closed' and
--    status = 'paused' (isPausedClient()). Re-checked line by line against the live capacity.ts
--    text — this branch was already correct in the first draft of this migration, kept unchanged.
--
--    Every other role: DELIBERATELY DIVERGES from capacity.ts's current client-side computation.
--    capacity.ts still filters its own (RLS-narrowed) `tasks` array by `assigned_to === user.id`
--    — the single legacy column — because that's the only relationship it has today. This
--    function instead counts by task_assignees MEMBERSHIP (join task_assignees -> tasks), so a
--    task with 3 assignees counts fully for all 3 of them, and a task with zero assignees counts
--    for nobody — the real multi-assignee measure, not a mirror of the legacy single-column one.
--    "Non-done" mirrors isTaskDone() (src/lib/taskLifecycle.ts: status in ('completed', 'closed'))
--    exactly. capacityLimit/isUntracked/status/remainingCapacity/utilizationRate are left to
--    capacity.ts to keep computing client-side from users.capacity_limit, exactly as today — pure
--    arithmetic, not data this function needs to duplicate.
-- ----------------------------------------------------------------------------
create or replace function public.get_capacity_snapshot(p_user_ids text[])
returns table(user_id text, used_capacity integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- Explicit raise, not a silently-empty resultset: a sales caller asking for capacity data is a
  -- permission violation, not a legitimately-empty query — same posture as every other
  -- permission check in this migration.
  if public.app_user_role() = 'sales' then
    raise exception 'sales may not query capacity data.';
  end if;

  return query
    select
      u.id,
      (case
        when u.role in ('am_agent', 'am_team_lead') then (
          select count(*)::integer
          from public.clients c
          where c.am_agent_id = u.id
            and c.status <> 'closed'
            and c.status <> 'paused'
        )
        else (
          select count(*)::integer
          from public.task_assignees ta
          join public.tasks t on t.id = ta.task_id
          where ta.user_id = u.id
            and t.status not in ('completed', 'closed')
        )
      end)
    from public.users u
    where u.id = any(coalesce(p_user_ids, array[]::text[]));
end;
$$;

revoke all on function public.get_capacity_snapshot(text[]) from public, anon;
grant execute on function public.get_capacity_snapshot(text[]) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. storage.objects SELECT policy, widened to an OR of the original folder-name -> task id ->
--    task_visible_v2 rule and a new task_attachments.storage_path -> task_visible_v2 rule. Keeping
--    the old rule (rather than replacing it, as the first draft of this migration did) matters for
--    two cases: a legacy single-task file (whose folder-owner task has no reason to ever gain a
--    task_attachments row referencing it beyond the one it already has) stays resolvable purely by
--    the old rule, and a just-uploaded object for a NEW batch — uploaded before
--    add_task_attachments_for_copies() (section 9a) has run, so no task_attachments row exists
--    pointing at it yet — stays resolvable too, via the folder it was uploaded into. The new rule
--    is what makes every OTHER copy's own assignees able to see the same shared object once
--    section 9a's rows exist. INSERT policy is untouched (still folder-name -> task_visible_v2 —
--    the very first upload for a batch still has no task_attachments row for a path-based check to
--    key off). The pre-existing DELETE policy is untouched too; section 9c adds an independent one
--    alongside it.
-- ----------------------------------------------------------------------------
drop policy if exists "task_attachments_objects_select_rls" on storage.objects;
create policy "task_attachments_objects_select_rls" on storage.objects
for select
to authenticated
using (
  bucket_id = 'task-attachments'
  and (
    exists (
      select 1 from public.tasks t
      where t.id = (storage.foldername(name))[1]
        and public.task_visible_v2(t.id)
    )
    or exists (
      select 1 from public.task_attachments a
      where a.storage_path = storage.objects.name
        and public.task_visible_v2(a.task_id)
    )
  )
);

-- 8b. Index backing the new rule's join (storage_path had no index before this migration).
create index if not exists idx_task_attachments_storage_path on public.task_attachments (storage_path);

-- ----------------------------------------------------------------------------
-- 9a. add_task_attachments_for_copies(...) — SECURITY INVOKER. Adds one task_attachments row per
--     given task id, all sharing the one already-uploaded storage_path. Deliberately does NOT
--     re-check storage.objects itself — running under the caller's own RLS means each inserted row
--     is independently checked by the existing task_attachments_insert_rls policy (uploaded_by =
--     caller and task_visible_v2(task_id)) — exactly the same rule a single direct insert already
--     has to satisfy, just applied once per task id in the array. If any one of the given task ids
--     isn't actually visible to/created by the caller, the whole multi-row insert is rejected
--     atomically.
-- ----------------------------------------------------------------------------
create or replace function public.add_task_attachments_for_copies(
  p_task_ids text[],
  p_storage_path text,
  p_filename text,
  p_file_size bigint,
  p_mime_type text
)
returns setof public.task_attachments
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_task_ids is null or array_length(p_task_ids, 1) is null then
    raise exception 'p_task_ids must not be empty';
  end if;

  if not ((storage.foldername(p_storage_path))[1] = any(p_task_ids)) then
    raise exception 'storage_path does not belong to any of the given tasks';
  end if;

  return query
    insert into public.task_attachments (id, task_id, storage_path, filename, file_size, mime_type, uploaded_by, uploaded_at)
    select 'att-' || gen_random_uuid()::text, t, p_storage_path, p_filename, p_file_size, p_mime_type, public.app_user_id(), now()
    from unnest(p_task_ids) as t
    returning *;
end;
$$;

revoke all on function public.add_task_attachments_for_copies(text[], text, text, bigint, text) from public, anon;
grant execute on function public.add_task_attachments_for_copies(text[], text, text, bigint, text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 9b. delete_task_attachment(p_attachment_id) — SECURITY DEFINER, uploader-only (deliberately
--     stricter than the live table/storage delete policies, which also let
--     executive/head_of_technical/ai_engineer delete any attachment — a shared, multi-copy
--     attachment's blast radius is wider now, so this one path has no role escape).
--
--     Deletes ONLY the task_attachments metadata row, then returns the storage_path when no other
--     task_attachments row still references it (null otherwise) — it deliberately does NOT touch
--     storage.objects. Confirmed against Supabase's own docs (Storage > Management > Delete
--     Objects): removing a storage.objects row with plain SQL deletes only the metadata; the
--     actual file is left behind in the bucket as an orphan, because the real deletion against the
--     underlying object store happens in the Storage API server, not via a database trigger or
--     constraint. The caller must follow a non-null return with
--     `supabase.storage.from('task-attachments').remove([path])` — see section 9c for the policy
--     that lets that succeed.
--
--     The advisory lock makes the "is this the last reference" check race-safe: two concurrent
--     deletes of sibling rows sharing one path serialize on it, so whichever runs second always
--     sees the first's delete already committed-in-transaction before counting remaining
--     references — exactly one of the two calls gets back the non-null path, never zero, never
--     both.
-- ----------------------------------------------------------------------------
create or replace function public.delete_task_attachment(p_attachment_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attachment public.task_attachments;
  v_remaining integer;
begin
  select * into v_attachment from public.task_attachments where id = p_attachment_id;
  if not found then
    raise exception 'Attachment not found';
  end if;

  if v_attachment.uploaded_by <> public.app_user_id() then
    raise exception 'Only the uploader may delete this attachment.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_attachment.storage_path, 0));

  delete from public.task_attachments where id = p_attachment_id;

  select count(*) into v_remaining
  from public.task_attachments
  where storage_path = v_attachment.storage_path;

  if v_remaining = 0 then
    return v_attachment.storage_path;
  end if;

  return null;
end;
$$;

revoke all on function public.delete_task_attachment(text) from public, anon;
grant execute on function public.delete_task_attachment(text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 9c. NEW storage.objects DELETE policy — additive, alongside the pre-existing
--     task_attachments_objects_delete_rls (untouched). That old policy keys off a task_attachments
--     row's uploaded_by, but by the time a client calls the Storage API's remove() following a
--     non-null delete_task_attachment() return, the metadata row is ALREADY gone — so the old
--     policy alone would no longer match, and the call would silently remove 0 objects. This one
--     keys off storage.objects' own `owner` column instead (set by the Storage API to the
--     uploader's auth.uid() at upload time), independent of task_attachments entirely, so the
--     uploader can always remove their own object however many task_attachments rows referenced it
--     before this cleanup call.
-- ----------------------------------------------------------------------------
drop policy if exists "task_attachments_objects_delete_own_rls" on storage.objects;
create policy "task_attachments_objects_delete_own_rls" on storage.objects
for delete
to authenticated
using (
  bucket_id = 'task-attachments'
  and owner = auth.uid()
);

commit;
