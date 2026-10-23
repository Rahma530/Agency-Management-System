-- DESIGN DRAFT — NOT EXECUTED, NOT APPROVED FOR PRODUCTION.
-- Depends on 001 and on approved answers in REVIEW.md. It intentionally fails closed.
begin;
set local lock_timeout='5s';
set local statement_timeout='5min';
do $$ begin
  if current_setting('app.apply_task_architecture_draft', true) <> 'review-only' then
    raise exception 'DRAFT ONLY: transactional RPC contracts were not approved for execution';
  end if;
  if to_regclass('public.task_events') is null
     or to_regclass('public.task_completion_events') is null
     or to_regclass('public.daily_log_task_links') is null
     or to_regclass('public.task_mutation_requests') is null
     or to_regclass('public.task_completion_revocations') is null
     or to_regprocedure('public.client_visible_for_task_rpc(text)') is null
     or to_regprocedure('public.task_actor_is_assignee(text,text)') is null
     or to_regprocedure('public.resolve_task_audit_identity(text)') is null
     or to_regprocedure('pg_catalog.sha256(bytea)') is null then
    raise exception 'Foundation draft is missing';
  end if;
end $$;

-- Daily Activity contract: p_entries is a JSON array of
-- {client_id: text|null, summary_text: text, task_ids: text[]}.
-- One call is one employee/day and is all-or-nothing. It requires individual completion evidence;
-- it does not infer completion from assignment. Existing linked_task_ids is written as a temporary
-- compatibility mirror until Report Workspace reads daily_log_task_links directly.
create or replace function public.submit_daily_activity_v2(
  p_request_key uuid,
  p_report_date date,
  p_entries jsonb,
  p_impersonation_session_id text default null
) returns setof public.daily_logs
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor text := public.app_user_id();
  v_original_actor text; v_audit_session text; v_identity record;
  v_hash text;
  v_existing public.task_mutation_requests;
  v_entry jsonb;
  v_task_id text;
  v_client_id text;
  v_log public.daily_logs;
  v_task public.tasks;
  v_completion_id uuid;
  v_result_ids text[] := array[]::text[];
  v_result_versions jsonb := '{}'::jsonb;
  v_seen_task_ids text[] := array[]::text[];
  v_task_count integer:=0;
  v_event_ordinal integer:=0;
begin
  select * into v_identity from public.resolve_task_audit_identity(p_impersonation_session_id);
  v_actor:=v_identity.effective_actor_id; v_original_actor:=v_identity.original_actor_id;
  v_audit_session:=v_identity.impersonation_session_id;
  if v_actor is null or p_request_key is null or p_report_date is null
     or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries)=0 then
    raise exception 'Invalid daily activity request';
  end if;
  if jsonb_array_length(p_entries)>50 then raise exception 'Daily Activity accepts at most 50 entries'; end if;

  -- Validate the complete bounded payload before the first INSERT. JSON strings are required;
  -- jsonb_array_elements_text coercion is deliberately not accepted as schema validation.
  for v_entry in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(v_entry)<>'object'
       or (v_entry-array['client_id','summary_text','task_ids']::text[])<>'{}'::jsonb
       or not (v_entry ? 'task_ids') or jsonb_typeof(v_entry->'task_ids')<>'array'
       or (v_entry ? 'summary_text' and jsonb_typeof(v_entry->'summary_text')<>'string')
       or (v_entry ? 'client_id' and jsonb_typeof(v_entry->'client_id') not in ('string','null')) then
      raise exception 'Invalid Daily Activity entry shape';
    end if;
    if char_length(coalesce(v_entry->>'summary_text',''))>5000 then raise exception 'Daily Activity text is too long'; end if;
    if nullif(trim(coalesce(v_entry->>'summary_text','')),'') is null
       and jsonb_array_length(v_entry->'task_ids')=0 then
      raise exception 'Each Daily Activity entry needs text or task evidence';
    end if;
    v_client_id:=nullif(trim(v_entry->>'client_id'),'');
    if v_client_id is not null and (char_length(v_client_id)>200 or not public.client_visible_for_task_rpc(v_client_id)) then
      raise exception 'Client is unavailable';
    end if;
    for v_task_id in select value#>>'{}' from jsonb_array_elements(v_entry->'task_ids') loop
      if exists(select 1 from jsonb_array_elements(v_entry->'task_ids') x where jsonb_typeof(x.value)<>'string') then
        raise exception 'Every task id must be a JSON string';
      end if;
      if nullif(trim(v_task_id),'') is null or char_length(v_task_id)>200 then raise exception 'Invalid task id'; end if;
      if v_task_id=any(v_seen_task_ids) then raise exception 'Task % appears more than once in this request',v_task_id; end if;
      v_seen_task_ids:=array_append(v_seen_task_ids,v_task_id);
      v_task_count:=v_task_count+1;
      if v_task_count>100 then raise exception 'Daily Activity accepts at most 100 task links'; end if;
    end loop;
  end loop;

  v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('date',p_report_date,'entries',p_entries,
    'impersonation_session_id',v_audit_session)::text,'UTF8')),'hex');
  select * into v_existing from public.task_mutation_requests
  where actor_id=v_actor and request_key=p_request_key;
  if found then
    if v_existing.action<>'submit_daily_activity_v2' or v_existing.payload_hash<>v_hash then
      raise exception 'Idempotency key was reused with a different payload';
    end if;
    if v_existing.completed_at is not null then
      if jsonb_typeof(v_existing.result->'daily_log_ids') is distinct from 'array'
         or jsonb_typeof(v_existing.result->'daily_log_versions') is distinct from 'object'
         or exists (
           select 1 from jsonb_array_elements_text(v_existing.result->'daily_log_ids') saved(saved_id)
           where not (v_existing.result->'daily_log_versions' ? saved_id)
         )
         or exists (
           select 1 from jsonb_object_keys(v_existing.result->'daily_log_versions') saved(saved_id)
           where not exists (
             select 1 from jsonb_array_elements_text(v_existing.result->'daily_log_ids') x(id)
             where x.id=saved_id
           )
         )
         or exists (
           select 1
           from jsonb_each_text(v_existing.result->'daily_log_versions') saved(id,row_version)
           left join public.daily_logs d on d.id=saved.id and d.user_id=v_actor
           where d.id is null or d.row_version<>saved.row_version::bigint
         ) then
        raise exception 'Prior request succeeded, but its Daily Activity rows changed; reload instead of replaying';
      end if;
      return query select d.* from public.daily_logs d
      where d.user_id=v_actor
        and d.id=any(coalesce(array(select jsonb_array_elements_text(v_existing.result->'daily_log_ids')),array[]::text[]));
      return;
    end if;
  end if;

  -- Acquire the actor/request lock before task locks, matching every other v2 RPC. Invalid task
  -- evidence still rolls this row back with the surrounding transaction.
  insert into public.task_mutation_requests(actor_id,original_actor_id,impersonation_session_id,request_key,action,payload_hash)
  values(v_actor,v_original_actor,v_audit_session,p_request_key,'submit_daily_activity_v2',v_hash)
  on conflict do nothing;
  select * into v_existing from public.task_mutation_requests
  where actor_id=v_actor and request_key=p_request_key for update;
  if v_existing.action<>'submit_daily_activity_v2' or v_existing.payload_hash<>v_hash then
    raise exception 'Idempotency key was reused with a different payload';
  end if;
  if v_existing.completed_at is not null then
    if jsonb_typeof(v_existing.result->'daily_log_ids') is distinct from 'array'
       or jsonb_typeof(v_existing.result->'daily_log_versions') is distinct from 'object'
       or exists (
         select 1 from jsonb_array_elements_text(v_existing.result->'daily_log_ids') saved(saved_id)
         where not (v_existing.result->'daily_log_versions' ? saved_id)
       )
       or exists (
         select 1 from jsonb_object_keys(v_existing.result->'daily_log_versions') saved(saved_id)
         where not exists (
           select 1 from jsonb_array_elements_text(v_existing.result->'daily_log_ids') x(id)
           where x.id=saved_id
         )
       )
       or exists (
         select 1
         from jsonb_each_text(v_existing.result->'daily_log_versions') saved(id,row_version)
         left join public.daily_logs d on d.id=saved.id and d.user_id=v_actor
         where d.id is null or d.row_version<>saved.row_version::bigint
       ) then
      raise exception 'Prior request succeeded, but its Daily Activity rows changed; reload instead of replaying';
    end if;
    return query select d.* from public.daily_logs d
    where d.user_id=v_actor
      and d.id=any(coalesce(array(select jsonb_array_elements_text(v_existing.result->'daily_log_ids')),array[]::text[]));
    return;
  end if;

  -- Deterministic lock order avoids two multi-task submissions deadlocking each other.
  for v_task_id in select unnest(v_seen_task_ids) order by 1 loop
    perform 1 from public.tasks where id=v_task_id for update;
  end loop;

  -- Validate every task and its current completion cycle before any data write.
  for v_entry in select value from jsonb_array_elements(p_entries) loop
    v_client_id:=nullif(trim(v_entry->>'client_id'),'');
    for v_task_id in select jsonb_array_elements_text(v_entry->'task_ids') loop
      select * into v_task from public.tasks where id=v_task_id;
      if not found or v_task.archived_at is not null or not public.task_visible_v2(v_task_id) then raise exception 'Task is unavailable'; end if;
      if v_task.client_id is distinct from v_client_id then raise exception 'Task client mismatch'; end if;
      if v_task.status not in ('completed','closed') or v_task.completed_at is null
         or (v_task.completed_at at time zone 'UTC')::date<>p_report_date then
        raise exception 'Task completion state/date does not match the Daily Activity date';
      end if;
      if not public.task_actor_is_assignee(v_task_id,v_actor) then
        raise exception 'Task is not assigned to the Daily Activity owner';
      end if;
      select e.id into v_completion_id from public.task_completion_events e
      where e.task_id=v_task_id and e.user_id=v_actor and e.task_cycle=v_task.lifecycle_cycle
        and (e.completed_at at time zone 'UTC')::date=p_report_date
        and not exists(select 1 from public.task_completion_revocations r where r.completion_event_id=e.id)
      order by e.completed_at desc limit 1;
      if v_completion_id is null then raise exception 'No individual completion evidence for task % in its current cycle',v_task_id; end if;
    end loop;
  end loop;

  for v_entry in select value from jsonb_array_elements(p_entries) loop
    v_client_id:=nullif(trim(v_entry->>'client_id'),'');
    v_log := null;
    insert into public.daily_logs(id,user_id,date,summary_text,linked_task_ids,client_id)
    values(
      'dlog-'||gen_random_uuid()::text, v_actor, p_report_date,
      coalesce(v_entry->>'summary_text',''),
      array(select jsonb_array_elements_text(v_entry->'task_ids')),
      v_client_id
    ) returning * into v_log;

    for v_task_id in select jsonb_array_elements_text(v_entry->'task_ids') loop
      select * into v_task from public.tasks where id=v_task_id;
      select e.id into v_completion_id
      from public.task_completion_events e
      where e.task_id=v_task_id and e.user_id=v_actor and e.task_cycle=v_task.lifecycle_cycle
        and (e.completed_at at time zone 'UTC')::date=p_report_date
        and not exists(select 1 from public.task_completion_revocations r where r.completion_event_id=e.id)
      order by e.completed_at desc limit 1;
      insert into public.daily_log_task_links(
        daily_log_id,task_id,user_id,report_date,client_id,completion_event_id,attribution_status,created_by
      ) values(v_log.id,v_task_id,v_actor,p_report_date,v_task.client_id,v_completion_id,'confirmed',v_actor);
      insert into public.task_events(task_id,batch_id,event_type,actor_id,original_actor_id,impersonation_session_id,request_key,event_ordinal,metadata)
      values(v_task_id,v_task.batch_id,'daily_log_linked',v_actor,v_original_actor,v_audit_session,p_request_key,v_event_ordinal,
        jsonb_build_object('daily_log_id',v_log.id));
      v_event_ordinal:=v_event_ordinal+1;
    end loop;
    v_result_ids := array_append(v_result_ids,v_log.id);
    v_result_versions := v_result_versions || jsonb_build_object(v_log.id,v_log.row_version);
  end loop;

  update public.task_mutation_requests
  set result=jsonb_build_object('daily_log_ids',to_jsonb(v_result_ids),'daily_log_versions',v_result_versions),completed_at=clock_timestamp()
  where actor_id=v_actor and request_key=p_request_key;
  return query select d.* from public.daily_logs d where d.id=any(v_result_ids) order by d.id;
end;
$$;

revoke all on function public.submit_daily_activity_v2(uuid,date,jsonb,text) from public,anon;
grant execute on function public.submit_daily_activity_v2(uuid,date,jsonb,text) to authenticated;

-- Single-row edit contract. Historical links may be preserved unchanged without inventing a
-- completion actor. Any date/client/task-link change requires current-cycle confirmed evidence
-- for the complete replacement set and is committed atomically with the compatibility array.
create or replace function public.update_daily_activity_v2(
  p_request_key uuid,p_log_id text,p_expected_row_version bigint,p_report_date date,
  p_client_id text,p_summary_text text,p_task_ids jsonb,p_impersonation_session_id text default null
) returns public.daily_logs
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor text:=public.app_user_id(); v_log public.daily_logs; v_task public.tasks;
  v_original_actor text; v_audit_session text; v_identity record;
  v_request public.task_mutation_requests; v_hash text; v_task_id text; v_completion_id uuid;
  v_ids text[]:=array[]::text[]; v_old_ids text[]; v_scope_changed boolean; v_ordinal integer:=0;
begin
  select * into v_identity from public.resolve_task_audit_identity(p_impersonation_session_id);
  v_actor:=v_identity.effective_actor_id; v_original_actor:=v_identity.original_actor_id;
  v_audit_session:=v_identity.impersonation_session_id;
  if v_actor is null or p_request_key is null or nullif(trim(p_log_id),'') is null
     or p_expected_row_version is null or p_expected_row_version<1 or p_report_date is null
     or p_task_ids is null or jsonb_typeof(p_task_ids)<>'array' or jsonb_array_length(p_task_ids)>100
     or char_length(coalesce(p_summary_text,''))>5000
     or (nullif(trim(coalesce(p_summary_text,'')),'') is null and jsonb_array_length(p_task_ids)=0) then
    raise exception 'Invalid Daily Activity update';
  end if;
  if p_client_id is not null and (nullif(trim(p_client_id),'') is null or char_length(p_client_id)>200
     or not public.client_visible_for_task_rpc(p_client_id)) then raise exception 'Client is unavailable'; end if;
  for v_task_id in select value#>>'{}' from jsonb_array_elements(p_task_ids) loop
    if exists(select 1 from jsonb_array_elements(p_task_ids) x where jsonb_typeof(x.value)<>'string')
       or nullif(trim(v_task_id),'') is null or char_length(v_task_id)>200 then raise exception 'Invalid task id'; end if;
    if v_task_id=any(v_ids) then raise exception 'Duplicate task id %',v_task_id; end if;
    v_ids:=array_append(v_ids,v_task_id);
  end loop;
  v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('log_id',p_log_id,'version',p_expected_row_version,
    'date',p_report_date,'client_id',p_client_id,'summary_text',p_summary_text,'task_ids',p_task_ids,
    'impersonation_session_id',v_audit_session)::text,'UTF8')),'hex');
  insert into public.task_mutation_requests(actor_id,original_actor_id,impersonation_session_id,request_key,action,payload_hash)
  values(v_actor,v_original_actor,v_audit_session,p_request_key,'update_daily_activity_v2',v_hash) on conflict do nothing;
  select * into v_request from public.task_mutation_requests where actor_id=v_actor and request_key=p_request_key for update;
  if v_request.action<>'update_daily_activity_v2' or v_request.payload_hash<>v_hash then
    raise exception 'Idempotency key was reused with a different payload';
  end if;
  if v_request.completed_at is not null then
    select * into v_log from public.daily_logs where id=v_request.result->>'daily_log_id' and user_id=v_actor;
    if not found or v_log.row_version is distinct from nullif(v_request.result->>'row_version','')::bigint then
      raise exception 'Prior request succeeded, but the Daily Activity row changed; reload instead of replaying';
    end if;
    return v_log;
  end if;
  select * into v_log from public.daily_logs where id=p_log_id for update;
  if not found or v_log.user_id<>v_actor or v_log.created_at<=now()-interval '7 days' then
    raise exception 'Daily Activity log is unavailable for editing';
  end if;
  if v_log.row_version<>p_expected_row_version then raise exception 'Daily Activity changed; refresh first'; end if;
  v_old_ids:=coalesce(v_log.linked_task_ids,array[]::text[]);
  v_scope_changed:=v_log.date<>p_report_date or v_log.client_id is distinct from p_client_id or v_old_ids is distinct from v_ids;
  if v_scope_changed then
    for v_task_id in select unnest(v_ids) order by 1 loop perform 1 from public.tasks where id=v_task_id for update; end loop;
    for v_task_id in select unnest(v_ids) loop
      select * into v_task from public.tasks where id=v_task_id;
      if not found or v_task.archived_at is not null or not public.task_visible_v2(v_task_id)
         or v_task.client_id is distinct from p_client_id
         or v_task.status not in ('completed','closed') or v_task.completed_at is null
         or (v_task.completed_at at time zone 'UTC')::date<>p_report_date
         or not public.task_actor_is_assignee(v_task_id,v_actor) then raise exception 'Task % is not eligible for this log',v_task_id; end if;
      select e.id into v_completion_id from public.task_completion_events e
      where e.task_id=v_task_id and e.user_id=v_actor and e.task_cycle=v_task.lifecycle_cycle
        and (e.completed_at at time zone 'UTC')::date=p_report_date
        and not exists(select 1 from public.task_completion_revocations r where r.completion_event_id=e.id)
      order by e.completed_at desc limit 1;
      if v_completion_id is null then raise exception 'No current-cycle completion evidence for task %',v_task_id; end if;
    end loop;
  end if;
  update public.daily_logs set date=p_report_date,client_id=p_client_id,summary_text=coalesce(p_summary_text,''),linked_task_ids=v_ids
  where id=p_log_id returning * into v_log;
  if v_scope_changed then
    for v_task_id in select task_id from public.daily_log_task_links where daily_log_id=p_log_id order by task_id loop
      select * into v_task from public.tasks where id=v_task_id;
      insert into public.task_events(task_id,batch_id,event_type,actor_id,original_actor_id,impersonation_session_id,request_key,event_ordinal,metadata)
      values(v_task_id,v_task.batch_id,'daily_log_unlinked',v_actor,v_original_actor,v_audit_session,p_request_key,v_ordinal,jsonb_build_object('daily_log_id',p_log_id));
      v_ordinal:=v_ordinal+1;
    end loop;
    delete from public.daily_log_task_links where daily_log_id=p_log_id;
    for v_task_id in select unnest(v_ids) loop
      select * into v_task from public.tasks where id=v_task_id;
      select e.id into v_completion_id from public.task_completion_events e
      where e.task_id=v_task_id and e.user_id=v_actor and e.task_cycle=v_task.lifecycle_cycle
        and (e.completed_at at time zone 'UTC')::date=p_report_date
        and not exists(select 1 from public.task_completion_revocations r where r.completion_event_id=e.id)
      order by e.completed_at desc limit 1;
      insert into public.daily_log_task_links(daily_log_id,task_id,user_id,report_date,client_id,completion_event_id,attribution_status,created_by)
      values(p_log_id,v_task_id,v_actor,p_report_date,p_client_id,v_completion_id,'confirmed',v_actor);
      insert into public.task_events(task_id,batch_id,event_type,actor_id,original_actor_id,impersonation_session_id,request_key,event_ordinal,metadata)
      values(v_task_id,v_task.batch_id,'daily_log_linked',v_actor,v_original_actor,v_audit_session,p_request_key,v_ordinal,jsonb_build_object('daily_log_id',p_log_id));
      v_ordinal:=v_ordinal+1;
    end loop;
  end if;
  update public.task_mutation_requests set result=jsonb_build_object('daily_log_id',p_log_id,'row_version',v_log.row_version),completed_at=clock_timestamp()
  where actor_id=v_actor and request_key=p_request_key;
  return v_log;
end; $$;
revoke all on function public.update_daily_activity_v2(uuid,text,bigint,date,text,text,jsonb,text) from public,anon;
grant execute on function public.update_daily_activity_v2(uuid,text,bigint,date,text,text,jsonb,text) to authenticated;

-- Delete remains the existing own-row/7-day behavior, but requires normalized-array parity so a
-- legacy or conflicted row cannot silently lose links. Link removals are audited before deletion.
create or replace function public.delete_daily_activity_v2(
  p_request_key uuid,p_log_id text,p_expected_row_version bigint,p_impersonation_session_id text default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor text:=public.app_user_id(); v_log public.daily_logs; v_request public.task_mutation_requests;
  v_original_actor text; v_audit_session text; v_identity record;
  v_hash text; v_task_id text; v_task public.tasks; v_ordinal integer:=0; v_link_ids text[];
begin
  select * into v_identity from public.resolve_task_audit_identity(p_impersonation_session_id);
  v_actor:=v_identity.effective_actor_id; v_original_actor:=v_identity.original_actor_id;
  v_audit_session:=v_identity.impersonation_session_id;
  if v_actor is null or p_request_key is null or nullif(trim(p_log_id),'') is null
     or p_expected_row_version is null or p_expected_row_version<1 then
    raise exception 'Invalid Daily Activity delete';
  end if;
  v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('log_id',p_log_id,'version',p_expected_row_version,
    'impersonation_session_id',v_audit_session)::text,'UTF8')),'hex');
  insert into public.task_mutation_requests(actor_id,original_actor_id,impersonation_session_id,request_key,action,payload_hash)
  values(v_actor,v_original_actor,v_audit_session,p_request_key,'delete_daily_activity_v2',v_hash) on conflict do nothing;
  select * into v_request from public.task_mutation_requests where actor_id=v_actor and request_key=p_request_key for update;
  if v_request.action<>'delete_daily_activity_v2' or v_request.payload_hash<>v_hash then raise exception 'Idempotency key reuse'; end if;
  if v_request.completed_at is not null then return true; end if;
  select * into v_log from public.daily_logs where id=p_log_id for update;
  if not found or v_log.user_id<>v_actor or v_log.created_at<=now()-interval '7 days' then raise exception 'Log unavailable for deletion'; end if;
  if v_log.row_version<>p_expected_row_version then raise exception 'Daily Activity changed; refresh first'; end if;
  select coalesce(array_agg(task_id order by task_id),array[]::text[]) into v_link_ids
  from public.daily_log_task_links where daily_log_id=p_log_id;
  if v_link_ids is distinct from coalesce((select array_agg(u.task_id order by u.task_id)
    from unnest(coalesce(v_log.linked_task_ids,array[]::text[])) as u(task_id)),array[]::text[]) then
    raise exception 'Legacy link parity is unresolved; deletion is blocked';
  end if;
  for v_task_id in select unnest(v_link_ids) loop
    select * into v_task from public.tasks where id=v_task_id;
    insert into public.task_events(task_id,batch_id,event_type,actor_id,original_actor_id,impersonation_session_id,request_key,event_ordinal,metadata)
    values(v_task_id,v_task.batch_id,'daily_log_unlinked',v_actor,v_original_actor,v_audit_session,p_request_key,v_ordinal,jsonb_build_object('daily_log_id',p_log_id));
    v_ordinal:=v_ordinal+1;
  end loop;
  delete from public.daily_log_task_links where daily_log_id=p_log_id;
  delete from public.daily_logs where id=p_log_id;
  update public.task_mutation_requests set result=jsonb_build_object('deleted',true,'daily_log_id',p_log_id),completed_at=clock_timestamp()
  where actor_id=v_actor and request_key=p_request_key;
  return true;
end; $$;
revoke all on function public.delete_daily_activity_v2(uuid,text,bigint,text) from public,anon;
grant execute on function public.delete_daily_activity_v2(uuid,text,bigint,text) to authenticated;

-- Lifecycle mutation contract. This draft implements only the invariants that are already
-- established: trusted actor, optimistic version, individual completion evidence, Close from
-- completed with done_link, and durable reopen history. The shared-task rule remains fail-closed.
create or replace function public.transition_task_v2(
  p_task_id text,
  p_action text,
  p_payload jsonb,
  p_expected_row_version bigint,
  p_request_key uuid,
  p_impersonation_session_id text default null
) returns public.tasks
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor text:=public.app_user_id();
  v_original_actor text; v_audit_session text; v_identity record;
  v_task public.tasks;
  v_before jsonb;
  v_cycle bigint;
  v_reason text;
  v_target_status text;
  v_hash text;
  v_request public.task_mutation_requests;
begin
  select * into v_identity from public.resolve_task_audit_identity(p_impersonation_session_id);
  v_actor:=v_identity.effective_actor_id; v_original_actor:=v_identity.original_actor_id;
  v_audit_session:=v_identity.impersonation_session_id;
  if v_actor is null or p_request_key is null or nullif(trim(p_task_id),'') is null
     or p_expected_row_version is null or p_expected_row_version<1
     or p_action not in ('record_completion','close','reopen','set_status')
     or p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'Invalid task transition request';
  end if;
  if (p_action='reopen' and (p_payload-array['reason','status']::text[])<>'{}'::jsonb)
     or (p_action='set_status' and (p_payload-array['status','reason']::text[])<>'{}'::jsonb)
     or (p_action in ('record_completion','close') and p_payload<>'{}'::jsonb) then
    raise exception 'Unexpected task transition fields';
  end if;
  v_reason:=nullif(trim(p_payload->>'reason'),'');
  v_target_status:=nullif(trim(p_payload->>'status'),'');
  if p_action='reopen' and (v_reason is null or char_length(v_reason)>500
     or coalesce(v_target_status,'in_progress') not in ('todo','in_progress','in_review','blocked')) then
    raise exception 'A reason of at most 500 characters is required';
  end if;
  if p_action='set_status' and (
    v_target_status not in ('todo','in_progress','in_review','blocked')
    or (v_target_status='blocked' and (v_reason is null or char_length(v_reason)>500))
    or (v_reason is not null and char_length(v_reason)>500)
  ) then raise exception 'Invalid status transition payload'; end if;
  v_hash:=encode(pg_catalog.sha256(convert_to(
    jsonb_build_object('task_id',p_task_id,'action',p_action,'payload',p_payload,'expected_row_version',p_expected_row_version,
      'impersonation_session_id',v_audit_session)::text,
    'UTF8')),'hex');

  insert into public.task_mutation_requests(actor_id,original_actor_id,impersonation_session_id,request_key,action,payload_hash)
  values(v_actor,v_original_actor,v_audit_session,p_request_key,'transition_task_v2:'||p_action,v_hash)
  on conflict do nothing;
  select * into v_request from public.task_mutation_requests
  where actor_id=v_actor and request_key=p_request_key for update;
  if v_request.action<>'transition_task_v2:'||p_action or v_request.payload_hash<>v_hash then
    raise exception 'Idempotency key was reused with a different lifecycle payload';
  end if;
  if v_request.completed_at is not null then
    select * into v_task from public.tasks where id=v_request.result->>'task_id';
    if not found or v_task.row_version is distinct from nullif(v_request.result->>'row_version','')::bigint then
      raise exception 'Prior request succeeded, but the task changed; reload instead of replaying';
    end if;
    return v_task;
  end if;

  select * into v_task from public.tasks where id=p_task_id for update;
  if not found or v_task.archived_at is not null or not public.task_visible_v2(p_task_id) then raise exception 'Task unavailable'; end if;
  if v_task.row_version<>p_expected_row_version then raise exception 'Task changed; refresh first'; end if;
  v_before:=jsonb_build_object('status',v_task.status,'completed_at',v_task.completed_at,
    'row_version',v_task.row_version,'lifecycle_cycle',v_task.lifecycle_cycle,
    'blocked_from_status',v_task.blocked_from_status,'done_link_present',nullif(trim(v_task.done_link),'') is not null);

  if p_action='record_completion' then
    if not public.task_actor_is_assignee(p_task_id,v_actor) then
      raise exception 'Only a current assignee may record individual completion';
    end if;
    if v_task.status in ('completed','closed') then raise exception 'This task cycle is already complete'; end if;
    v_cycle:=v_task.lifecycle_cycle;
    insert into public.task_completion_events(task_id,user_id,task_cycle,actor_id,request_key,evidence)
      values(p_task_id,v_actor,v_cycle,v_actor,p_request_key,
        jsonb_build_object('source','task_transition_v2','output_present',nullif(trim(v_task.done_link),'') is not null));
    -- Approved rule: the first authorized assignee who records their own evidence completes the
    -- shared task. The task row lock serializes competing assignees; no caller may name a
    -- different employee, and the unique per-user/cycle evidence remains immutable.
    update public.tasks set status='completed',completed_at=clock_timestamp(),blocked_from_status=null
    where id=p_task_id returning * into v_task;
  elsif p_action='close' then
    if not public.task_closable(p_task_id) or v_task.status<>'completed' or nullif(trim(v_task.done_link),'') is null then
      raise exception 'Task is not eligible to close';
    end if;
    update public.tasks set status='closed',blocked_from_status=null
      where id=p_task_id returning * into v_task;
  elsif p_action='reopen' then
    if not public.task_closable(p_task_id) or v_task.status not in ('completed','closed') then
      raise exception 'Task cannot be reopened without authorization and reason';
    end if;
    update public.tasks set status=coalesce(v_target_status,'in_progress'),completed_at=null,
      lifecycle_cycle=lifecycle_cycle+1,
      blocked_from_status=case when v_target_status='blocked' then v_task.status else null end
      where id=p_task_id returning * into v_task;
  elsif p_action='set_status' then
    if not public.task_mutable_v2(p_task_id) or v_task.status in ('completed','closed') then
      raise exception 'Task status requires a dedicated authorized transition';
    end if;
    if v_task.status='blocked' and v_target_status='blocked' then raise exception 'Task is already blocked'; end if;
    update public.tasks set status=v_target_status,
      completed_at=null,
      blocked_from_status=case when v_target_status='blocked' then v_task.status else null end
    where id=p_task_id returning * into v_task;
  end if;

  insert into public.task_events(task_id,batch_id,event_type,actor_id,original_actor_id,impersonation_session_id,request_key,before_state,after_state,metadata)
  values(p_task_id,v_task.batch_id,p_action,v_actor,v_original_actor,v_audit_session,p_request_key,
    v_before,
    jsonb_build_object('status',v_task.status,'completed_at',v_task.completed_at,
      'row_version',v_task.row_version,'lifecycle_cycle',v_task.lifecycle_cycle,
      'blocked_from_status',v_task.blocked_from_status,'done_link_present',nullif(trim(v_task.done_link),'') is not null),
    case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason',v_reason) end);
  update public.task_mutation_requests
  set result=jsonb_build_object('task_id',p_task_id,'row_version',v_task.row_version),completed_at=clock_timestamp()
  where actor_id=v_actor and request_key=p_request_key;
  return v_task;
end;
$$;

revoke all on function public.transition_task_v2(text,text,jsonb,bigint,uuid,text) from public,anon;
grant execute on function public.transition_task_v2(text,text,jsonb,bigint,uuid,text) to authenticated;

-- Allowlisted ordinary-field mutation. Status, assignments, archive identity and concurrency
-- columns have dedicated RPCs and can never be supplied here.
create or replace function public.mutate_task_v2(
  p_task_id text,p_expected_row_version bigint,p_changes jsonb,p_request_key uuid,
  p_impersonation_session_id text default null
) returns public.tasks language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_identity record; v_actor text; v_original text; v_session text; v_task public.tasks;
  v_request public.task_mutation_requests; v_hash text; v_before jsonb; v_changed jsonb;
begin
  select * into v_identity from public.resolve_task_audit_identity(p_impersonation_session_id);
  v_actor:=v_identity.effective_actor_id; v_original:=v_identity.original_actor_id; v_session:=v_identity.impersonation_session_id;
  if p_request_key is null or nullif(trim(p_task_id),'') is null or p_expected_row_version is null
     or p_expected_row_version<1 or jsonb_typeof(p_changes)<>'object' or p_changes='{}'::jsonb
     or (p_changes-array['title','description','client_id','team','due_date','priority','estimated_hours',
       'actual_hours','parent_task_id','drive_link','done_link','task_type','task_type_other']::text[])<>'{}'::jsonb then
    raise exception 'Invalid task mutation payload';
  end if;
  if p_changes ? 'title' and (jsonb_typeof(p_changes->'title')<>'string'
      or char_length(trim(p_changes->>'title')) not between 1 and 300) then raise exception 'Invalid task title'; end if;
  if p_changes ? 'description' and (jsonb_typeof(p_changes->'description')<>'string'
      or char_length(p_changes->>'description')>10000) then raise exception 'Invalid task description'; end if;
  if p_changes ? 'priority' and p_changes->>'priority' not in ('low','medium','high','urgent') then raise exception 'Invalid priority'; end if;
  if p_changes ? 'client_id' and (jsonb_typeof(p_changes->'client_id')<>'string'
      or not public.client_visible_for_task_rpc(p_changes->>'client_id')) then raise exception 'Client is unavailable'; end if;
  if p_changes ? 'due_date' and jsonb_typeof(p_changes->'due_date')<>'string' then raise exception 'Invalid due date'; end if;
  if p_changes ? 'estimated_hours' and jsonb_typeof(p_changes->'estimated_hours') not in ('number','null') then raise exception 'Invalid estimated hours'; end if;
  if p_changes ? 'actual_hours' and jsonb_typeof(p_changes->'actual_hours') not in ('number','null') then raise exception 'Invalid actual hours'; end if;
  if p_changes ? 'done_link' and jsonb_typeof(p_changes->'done_link') not in ('string','null') then raise exception 'Invalid done link'; end if;

  v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('task_id',p_task_id,'version',p_expected_row_version,
    'changes',p_changes,'impersonation_session_id',v_session)::text,'UTF8')),'hex');
  insert into public.task_mutation_requests(actor_id,original_actor_id,impersonation_session_id,request_key,action,payload_hash)
  values(v_actor,v_original,v_session,p_request_key,'mutate_task_v2',v_hash) on conflict do nothing;
  select * into v_request from public.task_mutation_requests where actor_id=v_actor and request_key=p_request_key for update;
  if v_request.action<>'mutate_task_v2' or v_request.payload_hash<>v_hash then raise exception 'Idempotency key reuse'; end if;
  if v_request.completed_at is not null then
    select * into v_task from public.tasks where id=v_request.result->>'task_id';
    if not found or v_task.row_version is distinct from nullif(v_request.result->>'row_version','')::bigint then
      raise exception 'Prior request succeeded, but the task changed; reload instead of replaying';
    end if;
    return v_task;
  end if;

  select * into v_task from public.tasks where id=p_task_id for update;
  if not found or v_task.archived_at is not null or not public.task_mutable_v2(p_task_id) then raise exception 'Task is unavailable for editing' using errcode='42501'; end if;
  if v_task.row_version<>p_expected_row_version then raise exception 'Task changed; refresh first' using errcode='40001'; end if;
  v_before:=jsonb_build_object('status',v_task.status,'completed_at',v_task.completed_at,'row_version',v_task.row_version,
    'lifecycle_cycle',v_task.lifecycle_cycle,'blocked_from_status',v_task.blocked_from_status,
    'done_link_present',nullif(trim(v_task.done_link),'') is not null);

  update public.tasks set
    title=case when p_changes?'title' then trim(p_changes->>'title') else title end,
    description=case when p_changes?'description' then p_changes->>'description' else description end,
    client_id=case when p_changes?'client_id' then p_changes->>'client_id' else client_id end,
    team=case when p_changes?'team' then p_changes->>'team' else team end,
    due_date=case when p_changes?'due_date' then (p_changes->>'due_date')::date else due_date end,
    priority=case when p_changes?'priority' then p_changes->>'priority' else priority end,
    estimated_hours=case when p_changes?'estimated_hours' then (p_changes->>'estimated_hours')::numeric else estimated_hours end,
    actual_hours=case when p_changes?'actual_hours' then (p_changes->>'actual_hours')::numeric else actual_hours end,
    parent_task_id=case when p_changes?'parent_task_id' then nullif(p_changes->>'parent_task_id','') else parent_task_id end,
    drive_link=case when p_changes?'drive_link' then nullif(p_changes->>'drive_link','') else drive_link end,
    done_link=case when p_changes?'done_link' then nullif(p_changes->>'done_link','') else done_link end,
    task_type=case when p_changes?'task_type' then nullif(p_changes->>'task_type','') else task_type end,
    task_type_other=case when p_changes?'task_type_other' then nullif(p_changes->>'task_type_other','') else task_type_other end
  where id=p_task_id returning * into v_task;
  select jsonb_agg(k.key order by k.key) into v_changed from jsonb_object_keys(p_changes) k(key);
  insert into public.task_events(task_id,batch_id,event_type,actor_id,original_actor_id,impersonation_session_id,
    request_key,before_state,after_state,metadata)
  values(p_task_id,v_task.batch_id,'field_changed',v_actor,v_original,v_session,p_request_key,v_before,
    jsonb_build_object('status',v_task.status,'completed_at',v_task.completed_at,'row_version',v_task.row_version,
      'lifecycle_cycle',v_task.lifecycle_cycle,'blocked_from_status',v_task.blocked_from_status,
      'done_link_present',nullif(trim(v_task.done_link),'') is not null),jsonb_build_object('changed_fields',v_changed));
  update public.task_mutation_requests set result=jsonb_build_object('task_id',p_task_id,'row_version',v_task.row_version),completed_at=clock_timestamp()
  where actor_id=v_actor and request_key=p_request_key;
  return v_task;
end $$;
revoke all on function public.mutate_task_v2(text,bigint,jsonb,uuid,text) from public,anon;
grant execute on function public.mutate_task_v2(text,bigint,jsonb,uuid,text) to authenticated;

-- Audited assignment boundary. The established set_task_assignees function remains the source of
-- assignment authorization and mirror synchronization; this wrapper adds concurrency,
-- idempotency and trusted impersonation audit identity.
create or replace function public.set_task_assignees_v2(
  p_task_id text,p_user_ids text[],p_expected_row_version bigint,p_request_key uuid,
  p_impersonation_session_id text default null
) returns public.tasks language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_identity record; v_actor text; v_original text; v_session text; v_task public.tasks;
  v_request public.task_mutation_requests; v_hash text; v_before jsonb;
begin
  select * into v_identity from public.resolve_task_audit_identity(p_impersonation_session_id);
  v_actor:=v_identity.effective_actor_id; v_original:=v_identity.original_actor_id; v_session:=v_identity.impersonation_session_id;
  if p_request_key is null or nullif(trim(p_task_id),'') is null or p_expected_row_version is null
     or p_expected_row_version<1 or p_user_ids is null or cardinality(p_user_ids)>100
     or array_position(p_user_ids,null) is not null
     or exists(select 1 from unnest(p_user_ids) u(id) group by id having nullif(trim(id),'') is null or count(*)>1) then
    raise exception 'Invalid task assignment request';
  end if;
  v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('task_id',p_task_id,'version',p_expected_row_version,
    'user_ids',p_user_ids,'impersonation_session_id',v_session)::text,'UTF8')),'hex');
  insert into public.task_mutation_requests(actor_id,original_actor_id,impersonation_session_id,request_key,action,payload_hash)
  values(v_actor,v_original,v_session,p_request_key,'set_task_assignees_v2',v_hash) on conflict do nothing;
  select * into v_request from public.task_mutation_requests where actor_id=v_actor and request_key=p_request_key for update;
  if v_request.action<>'set_task_assignees_v2' or v_request.payload_hash<>v_hash then raise exception 'Idempotency key reuse'; end if;
  if v_request.completed_at is not null then
    select * into v_task from public.tasks where id=v_request.result->>'task_id';
    if not found or v_task.row_version is distinct from nullif(v_request.result->>'row_version','')::bigint then
      raise exception 'Prior assignment request succeeded, but the task changed; reload instead of replaying';
    end if;
    return v_task;
  end if;
  select * into v_task from public.tasks where id=p_task_id for update;
  if not found or v_task.archived_at is not null then raise exception 'Task is unavailable'; end if;
  if v_task.row_version<>p_expected_row_version then raise exception 'Task changed; refresh first' using errcode='40001'; end if;
  v_before:=jsonb_build_object('status',v_task.status,'completed_at',v_task.completed_at,'row_version',v_task.row_version,
    'lifecycle_cycle',v_task.lifecycle_cycle,'blocked_from_status',v_task.blocked_from_status,
    'done_link_present',nullif(trim(v_task.done_link),'') is not null);
  perform public.set_task_assignees(p_task_id,p_user_ids);
  -- Assignment membership is part of the task's concurrency contract even when the legacy mirror
  -- value does not change (for example adding a second assignee). Force one task-row version bump.
  update public.tasks set updated_at=updated_at where id=p_task_id returning * into v_task;
  insert into public.task_events(task_id,batch_id,event_type,actor_id,original_actor_id,impersonation_session_id,
    request_key,before_state,after_state,metadata)
  values(p_task_id,v_task.batch_id,'assignees_changed',v_actor,v_original,v_session,p_request_key,v_before,
    jsonb_build_object('status',v_task.status,'completed_at',v_task.completed_at,'row_version',v_task.row_version,
      'lifecycle_cycle',v_task.lifecycle_cycle,'blocked_from_status',v_task.blocked_from_status,
      'done_link_present',nullif(trim(v_task.done_link),'') is not null),
    jsonb_build_object('changed_fields',jsonb_build_array('assignees')));
  update public.task_mutation_requests set result=jsonb_build_object('task_id',p_task_id,'row_version',v_task.row_version),
    completed_at=clock_timestamp() where actor_id=v_actor and request_key=p_request_key;
  return v_task;
end $$;
revoke all on function public.set_task_assignees_v2(text,text[],bigint,uuid,text) from public,anon;
grant execute on function public.set_task_assignees_v2(text,text[],bigint,uuid,text) to authenticated;

create or replace function public.archive_task_v2(
  p_task_id text,p_restore boolean,p_reason text,p_expected_row_version bigint,p_request_key uuid,
  p_impersonation_session_id text default null
) returns public.tasks language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_identity record; v_actor text; v_original text; v_session text; v_task public.tasks;
  v_request public.task_mutation_requests; v_hash text; v_reason text:=nullif(trim(p_reason),''); v_before jsonb;
begin
  select * into v_identity from public.resolve_task_audit_identity(p_impersonation_session_id);
  v_actor:=v_identity.effective_actor_id; v_original:=v_identity.original_actor_id; v_session:=v_identity.impersonation_session_id;
  if p_request_key is null or nullif(trim(p_task_id),'') is null or p_expected_row_version is null or p_expected_row_version<1
     or p_restore is null or (not p_restore and (v_reason is null or char_length(v_reason)>500))
     or (v_reason is not null and char_length(v_reason)>500) then raise exception 'Invalid archive request'; end if;
  v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('task_id',p_task_id,'restore',p_restore,'reason',v_reason,
    'version',p_expected_row_version,'impersonation_session_id',v_session)::text,'UTF8')),'hex');
  insert into public.task_mutation_requests(actor_id,original_actor_id,impersonation_session_id,request_key,action,payload_hash)
  values(v_actor,v_original,v_session,p_request_key,case when p_restore then 'restore_task_v2' else 'archive_task_v2' end,v_hash) on conflict do nothing;
  select * into v_request from public.task_mutation_requests where actor_id=v_actor and request_key=p_request_key for update;
  if v_request.action<>case when p_restore then 'restore_task_v2' else 'archive_task_v2' end or v_request.payload_hash<>v_hash then raise exception 'Idempotency key reuse'; end if;
  if v_request.completed_at is not null then
    select * into v_task from public.tasks where id=v_request.result->>'task_id';
    if not found or v_task.row_version is distinct from nullif(v_request.result->>'row_version','')::bigint then
      raise exception 'Prior request succeeded, but the task changed; reload instead of replaying';
    end if;
    return v_task;
  end if;
  select * into v_task from public.tasks where id=p_task_id for update;
  if not found or not public.task_archive_allowed_v2(p_task_id) then raise exception 'Task archive action is unauthorized' using errcode='42501'; end if;
  if v_task.row_version<>p_expected_row_version then raise exception 'Task changed; refresh first' using errcode='40001'; end if;
  if p_restore and v_task.archived_at is null then raise exception 'Task is not archived'; end if;
  if not p_restore and v_task.archived_at is not null then raise exception 'Task is already archived'; end if;
  v_before:=jsonb_build_object('status',v_task.status,'completed_at',v_task.completed_at,'row_version',v_task.row_version,
    'lifecycle_cycle',v_task.lifecycle_cycle,'blocked_from_status',v_task.blocked_from_status,
    'done_link_present',nullif(trim(v_task.done_link),'') is not null);
  if p_restore then
    update public.tasks set archived_at=null,archived_by=null,archive_reason=null where id=p_task_id returning * into v_task;
  else
    update public.tasks set archived_at=clock_timestamp(),archived_by=v_actor,archive_reason=v_reason where id=p_task_id returning * into v_task;
  end if;
  insert into public.task_events(task_id,batch_id,event_type,actor_id,original_actor_id,impersonation_session_id,
    request_key,before_state,after_state,metadata)
  values(p_task_id,v_task.batch_id,case when p_restore then 'task_restored' else 'task_archived' end,
    v_actor,v_original,v_session,p_request_key,v_before,
    jsonb_build_object('status',v_task.status,'completed_at',v_task.completed_at,'row_version',v_task.row_version,
      'lifecycle_cycle',v_task.lifecycle_cycle,'blocked_from_status',v_task.blocked_from_status,
      'done_link_present',nullif(trim(v_task.done_link),'') is not null),
    case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason',v_reason) end);
  update public.task_mutation_requests set result=jsonb_build_object('task_id',p_task_id,'row_version',v_task.row_version),completed_at=clock_timestamp()
  where actor_id=v_actor and request_key=p_request_key;
  return v_task;
end $$;
revoke all on function public.archive_task_v2(text,boolean,text,bigint,uuid,text) from public,anon;
grant execute on function public.archive_task_v2(text,boolean,text,bigint,uuid,text) to authenticated;

create or replace function public.list_archived_tasks_v2()
returns setof public.tasks language sql stable security definer set search_path=public,pg_temp as $$
  select t.* from public.tasks t where t.archived_at is not null and public.task_history_visible_v2(t.id)
  order by t.archived_at desc,t.id;
$$;
revoke all on function public.list_archived_tasks_v2() from public,anon;
grant execute on function public.list_archived_tasks_v2() to authenticated;

-- Capacity is an active-work view. Preserve the existing AM client-count branch and make the task
-- branch archive-aware while retaining the repository's normalized-assignee/legacy-fallback rule.
create or replace function public.get_capacity_snapshot(p_user_ids text[])
returns table(user_id text, used_capacity integer)
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if public.app_user_role()='sales' then raise exception 'sales may not query capacity data.'; end if;
  return query
  select u.id,(case when u.role in ('am_agent','am_team_lead') then (
    select count(*)::integer from public.clients c
    where c.am_agent_id=u.id and c.status not in ('closed','paused')
  ) else (
    select count(*)::integer from public.tasks t
    where t.archived_at is null and t.status not in ('completed','closed') and (
      exists(select 1 from public.task_assignees ta where ta.task_id=t.id and ta.user_id=u.id)
      or (not exists(select 1 from public.task_assignees ta where ta.task_id=t.id) and t.assigned_to=u.id)
    )
  ) end) from public.users u where u.id=any(coalesce(p_user_ids,array[]::text[]));
end $$;
revoke all on function public.get_capacity_snapshot(text[]) from public,anon;
grant execute on function public.get_capacity_snapshot(text[]) to authenticated,service_role;

-- Ordinary table reads are active-only. Historical consumers must use the explicit history helper
-- from SECURITY DEFINER report sources or list_archived_tasks_v2; permissive-policy OR cannot
-- reintroduce archived rows because this is the only tasks SELECT policy in the repository lineage.
drop policy if exists tasks_select_rls on public.tasks;
create policy tasks_select_rls on public.tasks for select to authenticated using (
  archived_at is null and ((created_by=public.app_user_id() and public.app_user_role()<>'sales') or public.task_active_visible_v2(id))
);
drop policy if exists tasks_update_rls on public.tasks;
create policy tasks_update_rls on public.tasks for update to authenticated
using (archived_at is null and public.task_mutable_v2(id))
with check (archived_at is null and public.task_mutable_v2(id)
  and (status<>'closed' or public.task_closable(id) or created_by=public.app_user_id()));

-- Partial-success bulk creation. Each BEGIN/EXCEPTION block is a PostgreSQL subtransaction: a
-- failed item rolls back its task, assignment changes and event, while prior independent items
-- remain eligible to commit with the outer call. The batch header and final item rows make retry
-- results stable, including duplicate/invalid explicit inputs.
create or replace function public.create_task_bulk_v2(
  p_request_key uuid,p_selection_mode text,p_client_ids text[],p_payload jsonb,
  p_impersonation_session_id text default null
) returns table(item_ordinal integer,requested_client_id text,success boolean,task_id text,error_code text,error_message text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_identity record; v_actor text; v_original text; v_session text; v_hash text; v_batch public.task_batches;
  v_clients text[]; v_client text; v_ordinal integer; v_item_hash text; v_task public.tasks; v_task_id text;
  v_assignees text[]; v_sqlstate text; v_message text;
begin
  select * into v_identity from public.resolve_task_audit_identity(p_impersonation_session_id);
  v_actor:=v_identity.effective_actor_id; v_original:=v_identity.original_actor_id; v_session:=v_identity.impersonation_session_id;
  if v_actor is null or p_request_key is null or p_selection_mode not in ('explicit','all_clients')
     or jsonb_typeof(p_payload)<>'object'
     or (p_payload-array['title','description','team','due_date','priority','estimated_hours','task_type',
       'task_type_other','parent_task_id','assignee_ids']::text[])<>'{}'::jsonb
     or jsonb_typeof(p_payload->'title')<>'string' or char_length(trim(p_payload->>'title')) not between 1 and 300
     or jsonb_typeof(p_payload->'description')<>'string' or char_length(p_payload->>'description')>10000
     or jsonb_typeof(p_payload->'due_date')<>'string'
     or p_payload->>'priority' not in ('low','medium','high','urgent')
     or not (p_payload ? 'assignee_ids') or jsonb_typeof(p_payload->'assignee_ids')<>'array'
     or jsonb_array_length(p_payload->'assignee_ids')>100
     or exists(select 1 from jsonb_array_elements(p_payload->'assignee_ids') x where jsonb_typeof(x.value)<>'string') then
    raise exception 'Invalid bulk task request';
  end if;
  if public.app_user_role()='sales' then raise exception 'Sales cannot create tasks' using errcode='42501'; end if;
  select coalesce(array_agg(value order by value),array[]::text[]) into v_assignees
  from (select distinct nullif(trim(value#>>'{}'),'') value from jsonb_array_elements(p_payload->'assignee_ids')) q
  where value is not null;
  if p_selection_mode='all_clients' then
    if p_client_ids is not null and cardinality(p_client_ids)>0 then raise exception 'All Clients does not accept client ids'; end if;
    select coalesce(array_agg(c.id order by c.id),array[]::text[]) into v_clients
    from public.clients c where c.status='active' and public.client_visible_for_task_rpc(c.id);
    if cardinality(v_clients)=0 then raise exception 'No active authorized clients are eligible'; end if;
  else
    if p_client_ids is null or cardinality(p_client_ids)=0 or cardinality(p_client_ids)>200 then
      raise exception 'Explicit bulk creation requires 1 to 200 client items';
    end if;
    v_clients:=p_client_ids;
  end if;
  v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('mode',p_selection_mode,'client_ids',v_clients,
    'payload',p_payload,'impersonation_session_id',v_session)::text,'UTF8')),'hex');
  insert into public.task_batches(id,created_by,original_actor_id,impersonation_session_id,request_key,selection_mode,client_ids,payload_hash)
  values(p_request_key,v_actor,v_original,v_session,p_request_key,p_selection_mode,
    array(select distinct trim(x) from unnest(v_clients) x where nullif(trim(x),'') is not null order by 1),v_hash)
  on conflict(created_by,request_key) do nothing;
  select * into v_batch from public.task_batches where created_by=v_actor and request_key=p_request_key for update;
  if not found or v_batch.payload_hash<>v_hash or v_batch.selection_mode<>p_selection_mode then
    raise exception 'Bulk idempotency key was reused with a different payload';
  end if;
  if exists(select 1 from public.task_batch_items i where i.batch_id=v_batch.id) then
    if exists(select 1 from public.task_batch_items i where i.batch_id=v_batch.id and i.result_status='pending') then
      raise exception 'Stored bulk request has an incomplete item state';
    end if;
    return query select i.item_ordinal,i.requested_client_id,i.result_status='succeeded',i.task_id,i.error_code,i.error_message
      from public.task_batch_items i where i.batch_id=v_batch.id order by i.item_ordinal;
    return;
  end if;

  for v_client,v_ordinal in select x.client_id,x.ordinality::integer from unnest(v_clients) with ordinality x(client_id,ordinality) loop
    v_client:=nullif(trim(v_client),'');
    v_item_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('ordinal',v_ordinal,'client_id',v_client,'payload',p_payload)::text,'UTF8')),'hex');
    insert into public.task_batch_items(batch_id,item_ordinal,requested_client_id,item_payload_hash,result_status)
    values(v_batch.id,v_ordinal,v_client,v_item_hash,'pending');
    begin
      if v_client is null then raise exception using errcode='22023',message='Client id is empty'; end if;
      if exists(select 1 from unnest(v_clients) with ordinality prior(id,n) where n<v_ordinal and nullif(trim(id),'')=v_client) then
        raise exception using errcode='23505',message='Duplicate client item';
      end if;
      if not public.client_visible_for_task_rpc(v_client) then raise exception using errcode='42501',message='Client is unavailable'; end if;
      if p_selection_mode='all_clients' then
        perform 1 from public.clients c where c.id=v_client and c.status='active' for key share;
        if not found then raise exception using errcode='55000',message='Client is no longer active'; end if;
      end if;
      if nullif(p_payload->>'parent_task_id','') is not null
         and not public.task_active_visible_v2(p_payload->>'parent_task_id') then
        raise exception using errcode='42501',message='Parent task is unavailable';
      end if;
      v_task_id:='tsk-'||gen_random_uuid()::text;
      insert into public.tasks(id,client_id,title,description,assigned_to,created_by,team,status,due_date,priority,
        estimated_hours,actual_hours,parent_task_id,task_type,task_type_other,batch_id)
      values(v_task_id,v_client,trim(p_payload->>'title'),p_payload->>'description',null,v_actor,nullif(p_payload->>'team',''),
        'todo',(p_payload->>'due_date')::date,p_payload->>'priority',(p_payload->>'estimated_hours')::numeric,0,
        nullif(p_payload->>'parent_task_id',''),nullif(p_payload->>'task_type',''),nullif(p_payload->>'task_type_other',''),p_request_key::text)
      returning * into v_task;
      if cardinality(v_assignees)>0 then perform public.set_task_assignees(v_task_id,v_assignees); end if;
      select * into v_task from public.tasks where id=v_task_id;
      insert into public.task_events(task_id,batch_id,event_type,actor_id,original_actor_id,impersonation_session_id,
        request_key,event_ordinal,after_state,metadata)
      values(v_task_id,v_task.batch_id,'task_created',v_actor,v_original,v_session,p_request_key,v_ordinal,
        jsonb_build_object('status',v_task.status,'completed_at',v_task.completed_at,'row_version',v_task.row_version,
          'lifecycle_cycle',v_task.lifecycle_cycle,'blocked_from_status',v_task.blocked_from_status,
          'done_link_present',false),jsonb_build_object('batch_id',v_batch.id::text));
      update public.task_batch_items set result_status='succeeded',task_id=v_task_id,completed_at=clock_timestamp()
      where batch_id=v_batch.id and item_ordinal=v_ordinal;
    exception when others then
      get stacked diagnostics v_sqlstate=returned_sqlstate,v_message=message_text;
      update public.task_batch_items set result_status='failed',
        error_code=case v_sqlstate when '23505' then 'DUPLICATE_ITEM' when '42501' then 'NOT_AUTHORIZED'
          when '23503' then 'INVALID_REFERENCE' when '22007' then 'INVALID_DATE' else 'INVALID_ITEM' end,
        error_message=case v_sqlstate when '23505' then 'This client appears more than once in the request.'
          when '42501' then 'The client, parent task, or assignee is not authorized.'
          when '23503' then 'A referenced client, task, or employee is unavailable.'
          when '22007' then 'The due date is invalid.' else 'This task item failed validation and was not created.' end,
        completed_at=clock_timestamp()
      where batch_id=v_batch.id and item_ordinal=v_ordinal;
    end;
  end loop;
  return query select i.item_ordinal,i.requested_client_id,i.result_status='succeeded',i.task_id,i.error_code,i.error_message
    from public.task_batch_items i where i.batch_id=v_batch.id order by i.item_ordinal;
end $$;
revoke all on function public.create_task_bulk_v2(uuid,text,text[],jsonb,text) from public,anon;
grant execute on function public.create_task_bulk_v2(uuid,text,text[],jsonb,text) to authenticated;

-- Replacement for the legacy bulk assigned_to=NULL write used after a permitted employee
-- deactivation. It removes only current assignment membership; history remains in
-- task_assignee_log/task_events and no unrelated task field is changed.
create or replace function public.remove_user_from_open_tasks_v2(
  p_user_id text,p_request_key uuid,p_impersonation_session_id text default null
) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_identity record; v_actor text; v_original text; v_session text; v_target public.users;
  v_request public.task_mutation_requests; v_hash text; v_task_id text; v_task public.tasks;
  v_count integer:=0; v_ordinal integer:=0;
begin
  select * into v_identity from public.resolve_task_audit_identity(p_impersonation_session_id);
  v_actor:=v_identity.effective_actor_id; v_original:=v_identity.original_actor_id; v_session:=v_identity.impersonation_session_id;
  if p_request_key is null or nullif(trim(p_user_id),'') is null then raise exception 'Invalid unassignment request'; end if;
  select * into v_target from public.users where id=p_user_id;
  if not found or v_target.deactivated_at is null or not public.employee_manageable(v_target.id,v_target.role) then
    raise exception 'Employee is unavailable for deactivation cleanup' using errcode='42501';
  end if;
  v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('user_id',p_user_id,
    'impersonation_session_id',v_session)::text,'UTF8')),'hex');
  insert into public.task_mutation_requests(actor_id,original_actor_id,impersonation_session_id,request_key,action,payload_hash)
  values(v_actor,v_original,v_session,p_request_key,'remove_user_from_open_tasks_v2',v_hash) on conflict do nothing;
  select * into v_request from public.task_mutation_requests where actor_id=v_actor and request_key=p_request_key for update;
  if v_request.action<>'remove_user_from_open_tasks_v2' or v_request.payload_hash<>v_hash then raise exception 'Idempotency key reuse'; end if;
  if v_request.completed_at is not null then return coalesce((v_request.result->>'affected_count')::integer,0); end if;
  for v_task_id in
    select t.id from public.tasks t
    where t.archived_at is null and t.status not in ('completed','closed') and (
      exists(select 1 from public.task_assignees ta where ta.task_id=t.id and ta.user_id=p_user_id)
      or (not exists(select 1 from public.task_assignees ta where ta.task_id=t.id) and t.assigned_to=p_user_id)
    ) order by t.id for update of t
  loop
    select * into v_task from public.tasks where id=v_task_id;
    delete from public.task_assignees where task_id=v_task_id and user_id=p_user_id;
    if not exists(select 1 from public.task_assignees where task_id=v_task_id) and v_task.assigned_to=p_user_id then
      update public.tasks set assigned_to=null where id=v_task_id;
      select * into v_task from public.tasks where id=v_task_id;
    end if;
    insert into public.task_events(task_id,batch_id,event_type,actor_id,original_actor_id,impersonation_session_id,
      request_key,event_ordinal,metadata)
    values(v_task_id,v_task.batch_id,'assignee_removed',v_actor,v_original,v_session,p_request_key,v_ordinal,
      jsonb_build_object('affected_count',1));
    v_count:=v_count+1; v_ordinal:=v_ordinal+1;
  end loop;
  update public.task_mutation_requests set result=jsonb_build_object('affected_count',v_count),completed_at=clock_timestamp()
  where actor_id=v_actor and request_key=p_request_key;
  return v_count;
end $$;
revoke all on function public.remove_user_from_open_tasks_v2(text,uuid,text) from public,anon;
grant execute on function public.remove_user_from_open_tasks_v2(text,uuid,text) to authenticated;

-- set_status supports todo/in_progress/in_review/blocked under task_mutable_v2. Completion,
-- closing and reopening remain dedicated actions with stronger evidence and authorization.

-- Direct legacy-column task and Daily Activity writes remain during frontend cutover. Daily writes
-- are locked down by 004 only after parity/smoke tests. Task lockdown remains blocked until every
-- ordinary edit/assignment/batch/archive path has an expected-version audited RPC.
commit;
