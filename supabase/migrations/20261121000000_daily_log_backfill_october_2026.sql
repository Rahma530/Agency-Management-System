-- One-time backfill of auto_task daily_logs rows for tasks delivered during October 2026 (Africa/
-- Cairo), mirroring 20261120000000_auto_daily_log_from_delivered_task.sql's own trigger logic
-- exactly — same assignee resolution (task_assignees, falling back to assigned_to), same
-- NULL-safe summary_text formula, same (task_id, user_id, date) grain and ON CONFLICT target, same
-- source='auto_task'. This migration adds no column/constraint/trigger/policy — it only inserts
-- rows into the existing public.daily_logs shape that migration already created.
--
-- Source scope: tasks currently in_review or completed with delivered_at NOT NULL — closed is
-- deliberately excluded (closed tasks are a separate lifecycle state this backfill does not
-- touch), and delivered_at is itself trigger-owned (track_delivery_and_revisions(),
-- 20261112000000_in_review_not_workload.sql) so a task that was never really delivered (legacy
-- row with delivered_at still NULL) is never backfilled.
--
-- Cutoff: (delivered_at at time zone 'Africa/Cairo')::date >= date '2026-10-01' — computed via
-- Postgres's own tzdata for 'Africa/Cairo' rather than a hardcoded UTC offset, matching every
-- other Cairo-date expression in this schema (get_user_schedule_load, countDeliveredToday, the
-- trigger this backfill mirrors).
--
-- Idempotency / safety:
--   - Deterministic id ('dlog-bf-' || md5(task_id||user_id||date)) lets the rollback delete only
--     this backfill's own rows (`where id like 'dlog-bf-%'`), never a trigger-inserted ('dlog-')
--     or manually-created row.
--   - `ON CONFLICT (task_id, user_id, date) WHERE task_id IS NOT NULL DO NOTHING` — the same
--     partial unique index the trigger uses — makes a second run of this exact statement a
--     no-op: every row it would try to re-insert already occupies that same index key, so the
--     conflict is caught there, before the deterministic id (which would also already exist by
--     then) is ever written to. This is the standard Postgres "insert ... on conflict (natural
--     key) do nothing" idempotent-upsert idiom.
--   - A `NOT EXISTS` guard additionally skips a (task, employee) pair where that employee already
--     has ANY daily_log (manual or auto) linking this task_id in linked_task_ids, regardless of
--     that existing log's own date — this is strictly broader than the unique index above (which
--     only catches a conflict on the exact same date) and is what "a task linked manually is
--     never duplicated" actually requires.
begin;

with qualifying_tasks as (
  select t.id as task_id, t.client_id, t.title, t.description, t.delivered_at, t.assigned_to
  from public.tasks t
  where t.status in ('in_review', 'completed')
    and t.delivered_at is not null
    and (t.delivered_at at time zone 'Africa/Cairo')::date >= date '2026-10-01'
),
assignees as (
  select
    qt.task_id, qt.client_id, qt.title, qt.description, qt.delivered_at,
    coalesce(
      (select array_agg(distinct ta.user_id) from public.task_assignees ta where ta.task_id = qt.task_id),
      case when qt.assigned_to is not null then array[qt.assigned_to] else array[]::text[] end
    ) as assignee_ids
  from qualifying_tasks qt
),
expanded as (
  select a.task_id, a.client_id, a.title, a.description, a.delivered_at, u as user_id
  from assignees a, unnest(a.assignee_ids) as u
)
insert into public.daily_logs (id, user_id, date, summary_text, linked_task_ids, client_id, task_id, source)
select
  'dlog-bf-' || md5(e.task_id || e.user_id || ((e.delivered_at at time zone 'Africa/Cairo')::date)::text),
  e.user_id,
  (e.delivered_at at time zone 'Africa/Cairo')::date,
  coalesce(e.title, '') || coalesce(E'\n' || nullif(btrim(e.description), ''), ''),
  array[e.task_id],
  e.client_id,
  e.task_id,
  'auto_task'
from expanded e
where not exists (
  select 1 from public.daily_logs dl
  where dl.user_id = e.user_id and e.task_id = any(dl.linked_task_ids)
)
on conflict (task_id, user_id, date) where task_id is not null do nothing;

commit;
