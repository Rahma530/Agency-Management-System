-- READ ONLY proposed post-migration verification. Object absence yields false/null where possible.

-- 1. Required object and RLS inventory.
select
  to_regclass('public.task_events') is not null task_events_exists,
  to_regclass('public.task_completion_events') is not null completion_events_exists,
  to_regclass('public.task_completion_revocations') is not null completion_revocations_exists,
  to_regclass('public.daily_log_task_links') is not null daily_links_exists,
  to_regclass('public.task_mutation_requests') is not null request_table_exists,
  to_regclass('public.task_batches') is not null task_batches_exists,
  to_regclass('public.task_batch_items') is not null task_batch_items_exists,
  to_regprocedure('public.resolve_task_audit_identity(text)') is not null audit_identity_rpc_exists,
  to_regprocedure('public.submit_daily_activity_v2(uuid,date,jsonb,text)') is not null daily_rpc_exists,
  to_regprocedure('public.update_daily_activity_v2(uuid,text,bigint,date,text,text,jsonb,text)') is not null daily_update_rpc_exists,
  to_regprocedure('public.delete_daily_activity_v2(uuid,text,bigint,text)') is not null daily_delete_rpc_exists,
  to_regprocedure('public.transition_task_v2(text,text,jsonb,bigint,uuid,text)') is not null transition_rpc_exists,
  to_regprocedure('public.mutate_task_v2(text,bigint,jsonb,uuid,text)') is not null mutation_rpc_exists,
  to_regprocedure('public.archive_task_v2(text,boolean,text,bigint,uuid,text)') is not null archive_rpc_exists,
  to_regprocedure('public.list_archived_tasks_v2()') is not null archived_list_rpc_exists,
  to_regprocedure('public.create_task_bulk_v2(uuid,text,text[],jsonb,text)') is not null bulk_rpc_exists,
  to_regprocedure('public.remove_user_from_open_tasks_v2(text,uuid,text)') is not null deactivation_rpc_exists;

select c.relname table_name, c.relrowsecurity rls_enabled, c.relforcerowsecurity rls_forced
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'
  and c.relname in ('task_events','task_completion_events','task_completion_revocations','daily_log_task_links','task_mutation_requests','task_batches','task_batch_items')
order by c.relname;

-- 2. Effective privileges: audit/completion/link tables must not permit direct ordinary writes.
select role_name, table_name,
       has_table_privilege(role_name, format('public.%I',table_name), 'SELECT') can_select,
       has_table_privilege(role_name, format('public.%I',table_name), 'INSERT') can_insert,
       has_table_privilege(role_name, format('public.%I',table_name), 'UPDATE') can_update,
       has_table_privilege(role_name, format('public.%I',table_name), 'DELETE') can_delete
from (values ('anon'),('authenticated')) roles(role_name)
cross join (values ('task_events'),('task_completion_events'),('task_completion_revocations'),('daily_log_task_links'),('task_mutation_requests'),('task_batches'),('task_batch_items')) tables(table_name)
where to_regclass(format('public.%I',table_name)) is not null
order by table_name, role_name;

-- 3. Unique contracts must cover concurrency keys, not merely object names.
select schemaname, tablename, indexname, indexdef
from pg_indexes
where schemaname='public'
  and tablename in ('daily_log_task_links','task_mutation_requests','task_completion_events','task_completion_revocations','task_batches','task_batch_items','tasks','daily_logs','impersonation_sessions')
order by tablename,indexname;

-- 4. Function security/search_path and execute grants.
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) arguments,
       p.prosecdef security_definer, p.proconfig,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') anon_execute,
       p.proacl::text explicit_acl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('resolve_task_audit_identity','submit_daily_activity_v2','update_daily_activity_v2','delete_daily_activity_v2',
    'transition_task_v2','mutate_task_v2','archive_task_v2','list_archived_tasks_v2','create_task_bulk_v2',
    'remove_user_from_open_tasks_v2','client_visible_for_task_rpc','task_actor_is_assignee',
    'task_active_visible_v2','task_history_visible_v2','task_mutable_v2','task_archive_allowed_v2','task_batch_client_ids_valid')
order by p.proname, arguments;

-- 5. Policy definitions for human review. SELECT policies must follow task/client visibility;
-- no direct INSERT/UPDATE/DELETE policy should exist for ordinary roles on immutable ledgers.
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname='public'
  and tablename in ('task_events','task_completion_events','task_completion_revocations','daily_log_task_links','task_mutation_requests','task_batches','task_batch_items','tasks','daily_logs')
order by tablename, policyname;

-- 6. Post-backfill invariants. All counts must be zero.
select 'daily_link_duplicate' check_name, count(*) violations
from (
  select user_id, report_date, task_id
  from public.daily_log_task_links
  group by user_id, report_date, task_id having count(*)>1
) q
union all
select 'daily_link_denormalized_mismatch', count(*)
from public.daily_log_task_links l
join public.daily_logs d on d.id=l.daily_log_id
where l.user_id<>d.user_id or l.report_date<>d.date or l.client_id is distinct from d.client_id
union all
select 'completion_event_wrong_task_date', count(*)
from public.task_completion_events e
join public.tasks t on t.id=e.task_id
where e.completed_at is null
union all
select 'event_missing_actor', count(*) from public.task_events where actor_id is null;

-- 6a. Trusted impersonation audit shape and archive-active separation. All counts must be zero.
select 'event_identity_shape' check_name,count(*) violations from public.task_events
where original_actor_id is null
   or (impersonation_session_id is null and original_actor_id<>actor_id)
   or (impersonation_session_id is not null and original_actor_id=actor_id)
union all
select 'request_identity_shape',count(*) from public.task_mutation_requests
where original_actor_id is null
   or (impersonation_session_id is null and original_actor_id<>actor_id)
   or (impersonation_session_id is not null and original_actor_id=actor_id)
union all
select 'batch_item_not_final',count(*) from public.task_batch_items where result_status='pending'
union all
select 'archived_task_invalid_shape',count(*) from public.tasks
where (archived_at is null and (archived_by is not null or archive_reason is not null))
   or (archived_at is not null and (archived_by is null or nullif(trim(archive_reason),'') is null));

-- 6b. Legacy-array/normalized parity and attribution-shape checks. All counts must be zero after 003.
select 'legacy_missing_normalized' check_name,count(*) violations from (
  select d.id,x.task_id from public.daily_logs d cross join lateral unnest(coalesce(d.linked_task_ids,array[]::text[])) x(task_id)
  except select l.daily_log_id,l.task_id from public.daily_log_task_links l
) q
union all
select 'normalized_missing_legacy',count(*) from (
  select l.daily_log_id,l.task_id from public.daily_log_task_links l
  except select d.id,x.task_id from public.daily_logs d cross join lateral unnest(coalesce(d.linked_task_ids,array[]::text[])) x(task_id)
) q
union all
select 'invalid_attribution_shape',count(*) from public.daily_log_task_links
where not (
  (attribution_status='confirmed' and completion_event_id is not null and created_by is not null)
  or (attribution_status='historical_unknown' and completion_event_id is null)
)
union all
select 'completion_evidence_mismatch',count(*) from public.daily_log_task_links l
join public.task_completion_events e on e.id=l.completion_event_id
where l.attribution_status='confirmed'
  and (e.task_id<>l.task_id or e.user_id<>l.user_id or (e.completed_at at time zone 'UTC')::date<>l.report_date);

-- 6c. Version triggers and append-only triggers must be enabled, not merely present.
select c.relname table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition
from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and not t.tgisinternal
  and t.tgname in ('touch_task_row_version_trigger','touch_daily_log_row_version_trigger',
    'task_events_append_only_trigger','task_completion_events_append_only_trigger','task_completion_revocations_append_only_trigger',
    'task_batch_items_immutable_trigger')
order by c.relname,t.tgname;

-- 7. Direct-write cutover check. Run only after frontend RPC cutover: sensitive task columns
-- should not be directly updateable by authenticated.
select column_name,
       has_column_privilege('authenticated','public.tasks',column_name,'UPDATE') authenticated_can_update,
       has_column_privilege('authenticated','public.tasks',column_name,'INSERT') authenticated_can_insert
from information_schema.columns
where table_schema='public' and table_name='tasks'
  and column_name in ('title','description','client_id','status','completed_at','done_link','priority','due_date',
    'archived_at','archived_by','archive_reason','blocked_from_status','row_version','lifecycle_cycle')
order by column_name;

-- 8. Daily direct-write lockdown must remove both table- and column-level effective privileges.
select role_name,privilege,
  has_table_privilege(role_name,'public.daily_logs',privilege) effective_table_privilege
from (values('authenticated'),('anon')) r(role_name)
cross join (values('INSERT'),('UPDATE'),('DELETE')) p(privilege)
union all
select role_name,'UPDATE:'||column_name,
  has_column_privilege(role_name,'public.daily_logs',column_name,'UPDATE')
from (values('authenticated'),('anon')) r(role_name)
cross join information_schema.columns
where table_schema='public' and table_name='daily_logs'
union all
select role_name,'INSERT:'||column_name,
  has_column_privilege(role_name,'public.daily_logs',column_name,'INSERT')
from (values('authenticated'),('anon')) r(role_name)
cross join information_schema.columns
where table_schema='public' and table_name='daily_logs'
order by 1,2;

-- 9. Task direct-write lockdown must remove both table- and column-level effective privileges.
select role_name,privilege,
  has_table_privilege(role_name,'public.tasks',privilege) effective_table_privilege
from (values('authenticated'),('anon')) r(role_name)
cross join (values('INSERT'),('UPDATE')) p(privilege)
union all
select role_name,'UPDATE:'||column_name,
  has_column_privilege(role_name,'public.tasks',column_name,'UPDATE')
from (values('authenticated'),('anon')) r(role_name)
cross join information_schema.columns
where table_schema='public' and table_name='tasks'
union all
select role_name,'INSERT:'||column_name,
  has_column_privilege(role_name,'public.tasks',column_name,'INSERT')
from (values('authenticated'),('anon')) r(role_name)
cross join information_schema.columns
where table_schema='public' and table_name='tasks'
order by 1,2;
