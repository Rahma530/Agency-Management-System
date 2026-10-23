-- READ ONLY. No writes, DDL, temporary tables, functions, or transactions.
-- Run each result set separately if the SQL Editor does not show multiple grids.

-- 1. Duplicate task IDs inside one daily_logs array.
with expanded as (
  select d.id daily_log_id, d.user_id, d.date report_date, x.task_id, count(*) occurrences
  from public.daily_logs d
  cross join lateral unnest(coalesce(d.linked_task_ids, array[]::text[])) x(task_id)
  group by d.id, d.user_id, d.date, x.task_id
)
select * from expanded where occurrences > 1
order by report_date, user_id, task_id;

-- 2. Same stable task linked by more than one log for the same employee/date.
with expanded as (
  select d.id daily_log_id, d.user_id, d.date report_date, x.task_id
  from public.daily_logs d
  cross join lateral unnest(coalesce(d.linked_task_ids, array[]::text[])) x(task_id)
)
select user_id, report_date, task_id,
       count(distinct daily_log_id) log_count,
       array_agg(distinct daily_log_id order by daily_log_id) daily_log_ids
from expanded
group by user_id, report_date, task_id
having count(distinct daily_log_id) > 1
order by report_date, user_id, task_id;

-- 3. Orphaned task references.
with expanded as (
  select d.id daily_log_id, d.user_id, d.date report_date, d.client_id log_client_id, x.task_id
  from public.daily_logs d
  cross join lateral unnest(coalesce(d.linked_task_ids, array[]::text[])) x(task_id)
)
select e.*
from expanded e
left join public.tasks t on t.id = e.task_id
where t.id is null
order by e.report_date, e.daily_log_id, e.task_id;

-- 4. Date/client/status mismatches. UTC matches the current Report Workspace contract.
with expanded as (
  select d.id daily_log_id, d.user_id, d.date report_date, d.client_id log_client_id, x.task_id
  from public.daily_logs d
  cross join lateral unnest(coalesce(d.linked_task_ids, array[]::text[])) x(task_id)
)
select e.daily_log_id, e.user_id, e.report_date, e.log_client_id,
       t.id task_id, t.client_id task_client_id, t.status, t.completed_at,
       case
         when t.status not in ('completed','closed') then 'task_not_done'
         when t.completed_at is null then 'missing_completed_at'
         when (t.completed_at at time zone 'UTC')::date <> e.report_date then 'completion_date_mismatch'
         when t.client_id is distinct from e.log_client_id then 'client_mismatch'
       end conflict_type
from expanded e
join public.tasks t on t.id = e.task_id
where t.status not in ('completed','closed')
   or t.completed_at is null
   or (t.completed_at at time zone 'UTC')::date <> e.report_date
   or t.client_id is distinct from e.log_client_id
order by e.report_date, e.daily_log_id, t.id;

-- 5. Assignment mismatch using task_assignees first and legacy assigned_to only when no rows exist.
with expanded as (
  select d.id daily_log_id, d.user_id, d.date report_date, x.task_id
  from public.daily_logs d
  cross join lateral unnest(coalesce(d.linked_task_ids, array[]::text[])) x(task_id)
), evidence as (
  select e.*,
         case when exists (select 1 from public.task_assignees any_ta where any_ta.task_id=e.task_id)
              then exists (select 1 from public.task_assignees own_ta where own_ta.task_id=e.task_id and own_ta.user_id=e.user_id)
              else t.assigned_to=e.user_id end assigned_to_log_owner
  from expanded e
  join public.tasks t on t.id=e.task_id
)
select * from evidence where not assigned_to_log_owner
order by report_date, daily_log_id, task_id;

-- 6. Ambiguous individual attribution: linked task currently has multiple assignees.
with expanded as (
  select d.id daily_log_id, d.user_id, d.date report_date, x.task_id
  from public.daily_logs d
  cross join lateral unnest(coalesce(d.linked_task_ids, array[]::text[])) x(task_id)
), counts as (
  select task_id, count(*) assignee_count, array_agg(user_id order by user_id) assignee_ids
  from public.task_assignees group by task_id
)
select e.*, c.assignee_count, c.assignee_ids
from expanded e join counts c on c.task_id=e.task_id
where c.assignee_count > 1
order by e.report_date, e.daily_log_id, e.task_id;

-- 7. Lifecycle inconsistencies in the current row model.
select id, status, completed_at, done_link, created_by, assigned_to
from public.tasks
where (status in ('completed','closed') and completed_at is null)
   or (status not in ('completed','closed') and completed_at is not null)
   or (status='closed' and nullif(trim(done_link),'') is null)
order by created_at, id;

-- 8. Assignment membership/log coverage and duplicate log events.
select ta.task_id, ta.user_id, ta.created_at,
       count(l.id) filter (where l.action='added') added_event_count,
       count(l.id) filter (where l.action='removed') removed_event_count
from public.task_assignees ta
left join public.task_assignee_log l on l.task_id=ta.task_id and l.user_id=ta.user_id
group by ta.task_id, ta.user_id, ta.created_at
having count(l.id) filter (where l.action='added') <> 1
order by ta.task_id, ta.user_id;

-- 9. Batch conflicts and incomplete batch snapshots visible in current data.
select batch_id, client_id, count(*) row_count, array_agg(id order by id) task_ids
from public.tasks
where batch_id is not null
group by batch_id, client_id
having count(*) > 1
order by batch_id, client_id;

-- 10. Task deletion dependencies and FK actions. This explains why hard delete is unsafe.
select tc.table_schema, tc.table_name, tc.constraint_name,
       rc.delete_rule, kcu.column_name
from information_schema.table_constraints tc
join information_schema.referential_constraints rc
  on rc.constraint_schema=tc.constraint_schema and rc.constraint_name=tc.constraint_name
join information_schema.key_column_usage kcu
  on kcu.constraint_schema=tc.constraint_schema and kcu.constraint_name=tc.constraint_name
join information_schema.constraint_column_usage ccu
  on ccu.constraint_schema=rc.unique_constraint_schema and ccu.constraint_name=rc.unique_constraint_name
where tc.constraint_type='FOREIGN KEY'
  and ccu.table_schema='public' and ccu.table_name='tasks'
order by tc.table_schema, tc.table_name, tc.constraint_name;

-- 11. Current task audit coverage by target task (activities are client-authored telemetry).
select t.id task_id,
       count(a.id) activity_rows,
       min(a.created_at) first_activity,
       max(a.created_at) last_activity
from public.tasks t
left join public.activities a on a.target_type='task' and a.target_id=t.id
group by t.id
having count(a.id)=0
order by t.id;

-- 12. Legacy-primary/normalized-assignee drift. Foundation migration 001 aborts if any row appears.
select t.id,t.assigned_to,
  array(select ta.user_id from public.task_assignees ta where ta.task_id=t.id order by ta.created_at,ta.user_id) normalized_assignees
from public.tasks t
where (t.assigned_to is not null and not exists(
  select 1 from public.task_assignees ta where ta.task_id=t.id and ta.user_id=t.assigned_to
)) or (t.assigned_to is null and exists(
  select 1 from public.task_assignees ta where ta.task_id=t.id
))
order by t.id;

-- 13. Effective legacy direct-write privileges that must remain until frontend cutover, then be zero.
select role_name,table_name,privilege,
  has_table_privilege(role_name,format('public.%I',table_name),privilege) effective_privilege
from (values('authenticated'),('anon')) r(role_name)
cross join (values('tasks'),('daily_logs')) t(table_name)
cross join (values('INSERT'),('UPDATE'),('DELETE')) p(privilege)
order by table_name,role_name,privilege;
