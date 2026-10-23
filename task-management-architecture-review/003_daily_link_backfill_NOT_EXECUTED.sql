-- DESIGN DRAFT — NOT EXECUTED. Preserves existing claims without inventing completion actors.
-- Run only after historical_conflicts_READ_ONLY.sql proves duplicate and orphan counts are zero.
begin;
set local lock_timeout='5s';
set local statement_timeout='5min';
do $$ begin
  if current_setting('app.apply_task_architecture_draft',true)<>'review-only' then
    raise exception 'DRAFT ONLY: historical daily-link backfill was not approved';
  end if;
  if to_regclass('public.daily_log_task_links') is null then raise exception 'Foundation is missing'; end if;
  -- Freeze both sides of the compatibility mirror for this transaction. SHARE ROW EXCLUSIVE
  -- blocks concurrent INSERT/UPDATE/DELETE but permits the backfill's own INSERT below.
  lock table public.daily_logs in share row exclusive mode;
  lock table public.daily_log_task_links in share row exclusive mode;
  if exists (
    select 1 from public.daily_logs d cross join lateral unnest(coalesce(d.linked_task_ids,array[]::text[])) x(task_id)
    group by d.user_id,d.date,x.task_id having count(*)>1
  ) then raise exception 'Duplicate employee/date/task claims must be reviewed before backfill'; end if;
  if exists (
    select 1 from public.daily_logs d cross join lateral unnest(coalesce(d.linked_task_ids,array[]::text[])) x(task_id)
    left join public.tasks t on t.id=x.task_id where t.id is null
  ) then raise exception 'Orphan task references must be reviewed before backfill'; end if;
  if exists (
    select 1 from public.daily_log_task_links l join public.daily_logs d on d.id=l.daily_log_id
    where l.user_id<>d.user_id or l.report_date<>d.date or l.client_id is distinct from d.client_id
  ) then raise exception 'Existing normalized links disagree with their Daily Log scope'; end if;
  if exists (
    select 1
    from public.daily_log_task_links l
    join public.daily_logs d on d.id=l.daily_log_id
    where not (l.task_id=any(coalesce(d.linked_task_ids,array[]::text[])))
  ) then raise exception 'Existing normalized links are not represented in the legacy arrays'; end if;
end $$;

insert into public.daily_log_task_links(
  daily_log_id,task_id,user_id,report_date,client_id,completion_event_id,attribution_status,created_by,created_at
)
select d.id,x.task_id,d.user_id,d.date,d.client_id,null,'historical_unknown',null,d.created_at
from public.daily_logs d
cross join lateral unnest(coalesce(d.linked_task_ids,array[]::text[])) x(task_id)
on conflict (daily_log_id,task_id) do nothing;

do $$ begin
  if exists (
    (select d.id,x.task_id from public.daily_logs d cross join lateral unnest(coalesce(d.linked_task_ids,array[]::text[])) x(task_id)
     except select l.daily_log_id,l.task_id from public.daily_log_task_links l)
    union all
    (select l.daily_log_id,l.task_id from public.daily_log_task_links l
     except select d.id,x.task_id from public.daily_logs d cross join lateral unnest(coalesce(d.linked_task_ids,array[]::text[])) x(task_id))
  ) then raise exception 'Backfill parity assertion failed'; end if;
  if exists (
    select 1 from public.daily_log_task_links l join public.daily_logs d on d.id=l.daily_log_id
    where l.user_id<>d.user_id or l.report_date<>d.date or l.client_id is distinct from d.client_id
  ) then raise exception 'Backfill scope assertion failed'; end if;
end $$;
commit;
