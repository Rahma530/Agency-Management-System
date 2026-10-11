-- PR 1 of the "task assignees" project — DATABASE FOUNDATION ONLY. Purely additive: no existing
-- table, column, function, trigger, policy, or grant is altered or dropped. tasks.assigned_to
-- keeps being the single column every existing screen and every existing RLS policy reads — this
-- migration only grows a new, currently-unread shadow structure alongside it and keeps it in sync
-- going one direction (legacy assigned_to -> new task_assignees). No frontend behavior changes.
--
-- IMPORTANT — what this migration deliberately does NOT do (by design, per the agreed PR
-- sequencing, so later PRs know exactly what's still owed):
--   1. It does NOT change task_visible(), tasks_select_rls, tasks_update_rls, tasks_insert_rls,
--      task_comments_*_rls, task_attachments_*_rls, employee_visible(), clients_select_rls, or
--      capacity/notifications. All of those still key off tasks.assigned_to alone. Today that's
--      harmless because nothing in this PR gives a task more than one real assignee yet (see next
--      point) — but it is the thing that MUST be fixed, together with whatever later PR adds a
--      write path that actually assigns a second person to a task, or that second person will be
--      added to task_assignees and still be unable to see the task at all.
--   2. It does NOT add any write path (RPC, policy, or UI) that lets a task end up with more than
--      one row in task_assignees. The only writer of task_assignees in this PR is the sync trigger
--      below, which only ever mirrors the single tasks.assigned_to column — so immediately after
--      this migration, task_assignees still has at most one row per task, exactly matching
--      assigned_to. Multi-assignee as a real, usable feature starts in a later PR.
--   3. It does NOT implement the reverse sync (task_assignees -> tasks.assigned_to). That belongs
--      in PR 4, together with pg_trigger_depth() recursion protection (needed then because a
--      reverse trigger writing tasks.assigned_to would re-fire THIS forward trigger). This
--      forward-only trigger cannot recurse: it only ever writes to task_assignees/
--      task_assignee_log, never back to tasks, so there is nothing for it to re-trigger.
begin;

-- ----------------------------------------------------------------------------
-- 1. task_assignees — the new, currently-unread source of truth for "who is on this task."
--    Kept in sync FROM tasks.assigned_to by the trigger below; nothing reads it yet.
-- ----------------------------------------------------------------------------
create table if not exists public.task_assignees (
  task_id text not null references public.tasks (id) on delete cascade,
  user_id text not null references public.users (id),
  added_by text references public.users (id),
  viewed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

create index if not exists idx_task_assignees_user_id on public.task_assignees (user_id);

-- ----------------------------------------------------------------------------
-- 2. task_assignee_log — append-only audit trail of every add/remove. Deliberately NOT
--    foreign-keyed to tasks.id: the log must survive even if a task row were ever removed (tasks
--    itself has no DELETE grant/policy today, so this is defensive, not a response to a real
--    deletion path), so a task_id here is a plain, unenforced reference, not a real FK.
-- ----------------------------------------------------------------------------
create table if not exists public.task_assignee_log (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  user_id text not null,
  action text not null check (action in ('added', 'removed')),
  actor_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_task_assignee_log_task_id_created_at
  on public.task_assignee_log (task_id, created_at);

-- ----------------------------------------------------------------------------
-- 3. tasks.batch_id — groups the independent per-client task copies a later PR's "create for
--    multiple clients" flow will produce, for DISPLAY ONLY. Nothing in this migration, and nothing
--    else today, reads this column — it has zero effect on capacity, KPI, or any report
--    aggregation, by construction (nothing queries it).
-- ----------------------------------------------------------------------------
alter table public.tasks add column if not exists batch_id text;
create index if not exists idx_tasks_batch_id on public.tasks (batch_id);

-- ----------------------------------------------------------------------------
-- 4. Backfill — one task_assignees row per existing task that already has an assigned_to, so the
--    new table starts out exactly mirroring current reality. ON CONFLICT DO NOTHING makes this
--    half idempotent on its own; re-running the whole migration file is additionally guarded by
--    the create-table-if-not-exists above (a second run finds the tables already populated and
--    this insert simply no-ops every row via the conflict clause).
-- ----------------------------------------------------------------------------
insert into public.task_assignees (task_id, user_id, added_by, viewed_at, created_at)
select id, assigned_to, created_by, assignee_viewed_at, created_at
from public.tasks
where assigned_to is not null
on conflict (task_id, user_id) do nothing;

-- Log backfill: a single set-based INSERT...SELECT over the same row set above — cheap (no
-- per-row procedural loop), so included rather than skipped. created_at is backdated to the
-- task's own created_at (not now()), so the log's timeline reflects when the assignment actually
-- happened, not when this migration ran. The NOT EXISTS guard makes this safe to re-run: unlike
-- the task_assignees backfill above, this plain INSERT has no natural ON CONFLICT target (the
-- log's primary key is a generated uuid, not (task_id, user_id)), so without it a second run of
-- this migration file would duplicate every backfilled log row.
insert into public.task_assignee_log (task_id, user_id, action, actor_id, created_at)
select t.id, t.assigned_to, 'added', t.created_by, t.created_at
from public.tasks t
where t.assigned_to is not null
  and not exists (select 1 from public.task_assignee_log l
                  where l.task_id = t.id and l.user_id = t.assigned_to and l.action = 'added');

-- ----------------------------------------------------------------------------
-- 5. Legacy -> new sync trigger. SECURITY DEFINER so it can write task_assignees/
--    task_assignee_log even though authenticated has no INSERT/UPDATE/DELETE grant on either
--    (see section 6) — the trigger runs as its owner, not as the authenticated caller.
--
--    Fires on INSERT, and on UPDATE of either assigned_to OR assignee_viewed_at — assignee_viewed_at
--    is included in the column list (beyond what the task's header literally asked for) because
--    handleMarkTaskViewed (App.tsx) updates ONLY assignee_viewed_at, with assigned_to absent from
--    that statement's column list entirely; a trigger declared "UPDATE OF assigned_to" alone would
--    never fire for that write, and the mirrored viewed_at this trigger maintains would silently
--    go stale the first time anyone opens a task without its assignment also changing in the same
--    statement. Flagging this explicitly since it's a deliberate reading of the spec, not a typo.
-- ----------------------------------------------------------------------------
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

      -- actor_id: tasks has no "who made this specific edit" column, so created_by is the best
      -- available proxy for this legacy-mirror path. A later PR's RPC-based write path (the one
      -- that actually lets someone other than the creator change assignees) can pass the true
      -- actor explicitly instead of relying on this trigger's inference.
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
    -- assigned_to unchanged, only the shared "viewed" timestamp moved — mirror it onto that
    -- assignee's row rather than touching task_assignee_log (no add/remove happened).
    update public.task_assignees
    set viewed_at = new.assignee_viewed_at
    where task_id = new.id and user_id = new.assigned_to;
  end if;

  return new;
end;
$$;

revoke all on function public.sync_legacy_assigned_to_to_task_assignees() from public, anon, authenticated;

drop trigger if exists sync_legacy_assigned_to_to_task_assignees_trigger on public.tasks;
create trigger sync_legacy_assigned_to_to_task_assignees_trigger
after insert or update of assigned_to, assignee_viewed_at on public.tasks
for each row
execute function public.sync_legacy_assigned_to_to_task_assignees();

-- ----------------------------------------------------------------------------
-- 6. RLS — SELECT only, for both new tables. "Can see this row" is defined purely as "can see the
--    parent task," by re-querying public.tasks from inside the policy: because this policy runs
--    under the caller's own role (not a SECURITY DEFINER function), that inner query is itself
--    subject to tasks' own RLS (tasks_select_rls) — so this adds no new visibility logic of its
--    own and automatically tracks task_visible()/tasks_select_rls forever, including whatever a
--    later PR changes them to. No INSERT/UPDATE/DELETE policy or grant on either table: the only
--    writer today is the SECURITY DEFINER trigger above (which bypasses grants as the function
--    owner), and a later PR's controlled RPC will be the only other one. Default privileges are
--    revoked in this project, so every grant below is explicit.
-- ----------------------------------------------------------------------------
alter table public.task_assignees enable row level security;

drop policy if exists "task_assignees_select_rls" on public.task_assignees;
create policy "task_assignees_select_rls" on public.task_assignees
for select to authenticated
using (
  exists (select 1 from public.tasks t where t.id = task_assignees.task_id)
);

grant select on public.task_assignees to authenticated;
grant all on public.task_assignees to service_role;

alter table public.task_assignee_log enable row level security;

drop policy if exists "task_assignee_log_select_rls" on public.task_assignee_log;
create policy "task_assignee_log_select_rls" on public.task_assignee_log
for select to authenticated
using (
  exists (select 1 from public.tasks t where t.id = task_assignee_log.task_id)
);

grant select on public.task_assignee_log to authenticated;
grant all on public.task_assignee_log to service_role;

commit;
