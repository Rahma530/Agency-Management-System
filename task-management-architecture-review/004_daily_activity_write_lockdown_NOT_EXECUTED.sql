-- DESIGN DRAFT — NOT EXECUTED. Apply only after frontend create/edit/delete uses v2 RPCs,
-- backfill parity is zero, and PostgreSQL RLS/concurrency tests pass.
begin;
set local lock_timeout='5s';
set local statement_timeout='5min';
do $$ begin
  if current_setting('app.apply_task_architecture_draft',true)<>'review-only' then
    raise exception 'DRAFT ONLY: Daily Activity write lockdown was not approved';
  end if;
  if to_regprocedure('public.submit_daily_activity_v2(uuid,date,jsonb,text)') is null
     or to_regprocedure('public.update_daily_activity_v2(uuid,text,bigint,date,text,text,jsonb,text)') is null
     or to_regprocedure('public.delete_daily_activity_v2(uuid,text,bigint,text)') is null
     or to_regprocedure('public.mutate_task_v2(text,bigint,jsonb,uuid,text)') is null
     or to_regprocedure('public.set_task_assignees_v2(text,text[],bigint,uuid,text)') is null
     or to_regprocedure('public.transition_task_v2(text,text,jsonb,bigint,uuid,text)') is null
     or to_regprocedure('public.archive_task_v2(text,boolean,text,bigint,uuid,text)') is null
     or to_regprocedure('public.create_task_bulk_v2(uuid,text,text[],jsonb,text)') is null
     or to_regprocedure('public.remove_user_from_open_tasks_v2(text,uuid,text)') is null then
    raise exception 'Required v2 mutation RPCs are missing';
  end if;
  -- Serialize the final parity check with legacy writers. Writers queued behind this transaction
  -- re-check privileges after COMMIT and fail once the revokes below become effective.
  lock table public.daily_logs in share row exclusive mode;
  lock table public.daily_log_task_links in share row exclusive mode;
  if exists (
    (select d.id,x.task_id from public.daily_logs d cross join lateral unnest(coalesce(d.linked_task_ids,array[]::text[])) x(task_id)
     except select l.daily_log_id,l.task_id from public.daily_log_task_links l)
    union all
    (select l.daily_log_id,l.task_id from public.daily_log_task_links l
     except select d.id,x.task_id from public.daily_logs d cross join lateral unnest(coalesce(d.linked_task_ids,array[]::text[])) x(task_id))
  ) then raise exception 'Legacy and normalized Daily Activity links are not in parity'; end if;
end $$;

revoke insert,update,delete on public.daily_logs from public,anon,authenticated;
revoke insert(id,user_id,date,summary_text,linked_task_ids,client_id,created_at)
  on public.daily_logs from public,anon,authenticated;
revoke update(date,summary_text,linked_task_ids,client_id) on public.daily_logs from public,anon,authenticated;

revoke insert,update on public.tasks from public,anon,authenticated;
revoke insert(id,client_id,title,description,assigned_to,created_by,team,status,due_date,priority,
  estimated_hours,actual_hours,created_at,parent_task_id,completed_at,assignee_viewed_at,drive_link,
  done_link,task_type,task_type_other,batch_id,updated_at,row_version,lifecycle_cycle,source_task_id,
  archived_at,archived_by,archive_reason,blocked_from_status) on public.tasks from public,anon,authenticated;
revoke update(client_id,title,description,assigned_to,created_by,team,status,due_date,priority,
  estimated_hours,actual_hours,created_at,parent_task_id,completed_at,assignee_viewed_at,drive_link,
  done_link,task_type,task_type_other,batch_id,updated_at,row_version,lifecycle_cycle,source_task_id,
  archived_at,archived_by,archive_reason,blocked_from_status) on public.tasks from public,anon,authenticated;
revoke execute on function public.set_task_assignees(text,text[]) from public,anon,authenticated;
-- Existing RLS policies remain for read/rollback inspection; without effective table/column write
-- privileges they cannot authorize legacy mutations. Controlled SECURITY DEFINER RPCs own writes.
commit;
