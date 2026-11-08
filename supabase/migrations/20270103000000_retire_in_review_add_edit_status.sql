-- Tasks board: retire "Reviewing" (in_review), add "Edit" — owner decisions, 2026-11-08:
--   1. In Progress now advances straight to Completed. "Completed" becomes the one and only
--      "delivered" marker (replacing in_review/completed together) — her literal answer was
--      "any in_review task moves to completed," so every existing in_review row is migrated to
--      completed below, not just hidden from new picks.
--   2. "Edit" is a brand-new status: a task reaches it ONLY by being a fresh, separate duplicate
--      row (never an ordinary status transition of the same row) — see create_task_copy's new
--      p_status parameter in PART 3. The app-side duplicate-into-Edit flow
--      (CrossTeamTaskBoard.tsx's handleDragEnd) always passes 'todo' or 'edit' here, never
--      anything else — PART 3's check constraint enforces that server-side too, so this isn't
--      merely a client-side convention.
--
-- ================================================================================================
-- PART 1 — track_delivery_and_revisions(): drop in_review from the delivered-detection condition.
-- Same function as 20261112000000_in_review_not_workload.sql, CREATE OR REPLACE in place (no
-- signature change, so no DROP needed) — only the two `in ('in_review', 'completed')` /
-- `in ('in_review', 'completed', 'closed')` lists lose 'in_review'. 'edit' is deliberately NOT
-- added to either list: reaching 'edit' is not a delivery, and leaving 'edit' for 'todo'/
-- 'in_progress' is not a revision (it was never delivered in the first place — it's a fresh copy).
-- ================================================================================================
begin;

create or replace function public.track_delivery_and_revisions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    new.revision_count := 0;
    new.revision_started_at := null;
    new.delivered_at := null;
    if new.status = 'completed' then
      new.delivered_at := now();
    end if;
    return new;
  end if;

  -- TG_OP = 'UPDATE'. Restore first — clients can never write these three directly.
  new.delivered_at := old.delivered_at;
  new.revision_count := old.revision_count;
  new.revision_started_at := old.revision_started_at;

  if new.status = 'completed' and old.delivered_at is null and new.status is distinct from old.status then
    new.delivered_at := now();
  end if;

  -- Revision: a previously-delivered task (was completed/closed) sent back to todo/in_progress.
  -- 'in_review' dropped from this list along with the status itself; a task already mid-flight in
  -- in_review at the moment this migration runs is handled by PART 2's one-time data migration
  -- below, not by this trigger (a bare status string comparison, not a type/enum check, so it
  -- still evaluates correctly against a to-be-retired value during this same transaction).
  if old.status in ('completed', 'closed') and new.status in ('todo', 'in_progress') then
    new.revision_count := old.revision_count + 1;
    new.revision_started_at := now();
  end if;

  return new;
end;
$$;

-- ================================================================================================
-- PART 2 — one-time data migration: every existing in_review row becomes completed, BEFORE the
-- constraint below stops allowing 'in_review' at all (a CHECK added without NOT VALID validates
-- every existing row immediately, so this order is required, not just tidy). Runs through the
-- trigger just replaced in PART 1 — an in_review row with delivered_at already set (it was
-- delivered when it first reached in_review) is left untouched by the `old.delivered_at is null`
-- guard; a legacy row with delivered_at still null (pre-20261112000000, never backfilled, per that
-- migration's own decision 5) gets delivered_at stamped now instead of staying null forever.
-- Neither outcome is a regression — both are strictly more accurate than "unknown."
-- ================================================================================================
update public.tasks set status = 'completed' where status = 'in_review';

-- ================================================================================================
-- PART 3 — tasks_status_check: drop 'in_review', add 'edit'. Same drop+recreate pattern as
-- 20261023000000_task_done_link_and_closed_status.sql.
-- ================================================================================================
alter table public.tasks drop constraint tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('todo', 'in_progress', 'edit', 'completed', 'blocked', 'closed'));

-- ================================================================================================
-- PART 4 — create_task_copy(): new trailing p_status parameter (default 'todo', so every existing
-- call site that omits it is unaffected). Restricted to 'todo'/'edit' only — a duplicate is always
-- either an ordinary copy or an Edit-column copy, never a backdoor into 'completed'/'closed'/
-- 'in_progress'/'blocked' bookkeeping those statuses normally only reach through
-- handleUpdateTaskStatus's own started_at/completed_at/actual_hours logic. CREATE OR REPLACE with
-- one new DEFAULT-valued trailing parameter is additive (existing 12-positional-arg callers still
-- resolve correctly) — no DROP FUNCTION needed, but the REVOKE/GRANT lines must restate the full,
-- now-13-parameter signature or they'd silently target a signature that no longer exists.
-- ================================================================================================
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
begin
  if p_status not in ('todo', 'edit') then
    raise exception 'p_status must be todo or edit.';
  end if;

  if p_client_id is not null and not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'Client not found or not accessible.';
  end if;

  insert into public.tasks (
    id, client_id, title, description, assigned_to, created_by, team, status,
    due_date, priority, estimated_hours, actual_hours, parent_task_id,
    task_type, task_type_other, batch_id
  ) values (
    v_id, p_client_id, p_title, p_description, null, public.app_user_id(), p_team, p_status,
    p_due_date, p_priority, p_estimated_hours, 0, p_parent_task_id,
    p_task_type, p_task_type_other, p_batch_id
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

-- The OLD 12-parameter signature is a separate, now-orphaned overload left behind by CREATE OR
-- REPLACE adding a 13th parameter (Postgres treats a different parameter count as a distinct
-- function identity, not a replacement) — drop it explicitly so exactly one create_task_copy
-- overload exists, matching every other RPC in this schema.
drop function if exists public.create_task_copy(text, text, text, text, date, text, numeric, text, text, text, text, text[]);

commit;
