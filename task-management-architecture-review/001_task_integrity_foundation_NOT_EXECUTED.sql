-- DESIGN DRAFT — NOT EXECUTED, NOT APPROVED FOR PRODUCTION.
-- This file intentionally aborts before any DDL unless a reviewer explicitly sets:
--   select set_config('app.apply_task_architecture_draft','review-only',false);
-- Even with that flag, run only in a disposable test database after conflict review.
begin;
set local lock_timeout='5s';
set local statement_timeout='5min';
do $$ begin
  if current_setting('app.apply_task_architecture_draft', true) <> 'review-only' then
    raise exception 'DRAFT ONLY: task integrity foundation was not approved for execution';
  end if;
end $$;

-- These are the exact legacy columns referenced by the compatibility grants and RPC row types.
-- Missing columns mean this draft was pointed at a different lineage and must fail before DDL.
do $$ declare v_missing text;
begin
  select string_agg(x.table_name||'.'||x.column_name,', ' order by x.table_name,x.column_name)
  into v_missing
  from (values
    ('tasks','id'),('tasks','client_id'),('tasks','title'),('tasks','description'),
    ('tasks','assigned_to'),('tasks','created_by'),('tasks','team'),('tasks','status'),
    ('tasks','due_date'),('tasks','priority'),('tasks','estimated_hours'),('tasks','actual_hours'),
    ('tasks','created_at'),('tasks','parent_task_id'),('tasks','completed_at'),
    ('tasks','assignee_viewed_at'),('tasks','drive_link'),('tasks','done_link'),
    ('tasks','task_type'),('tasks','task_type_other'),('tasks','batch_id'),
    ('daily_logs','id'),('daily_logs','user_id'),('daily_logs','date'),
    ('daily_logs','summary_text'),('daily_logs','linked_task_ids'),('daily_logs','client_id'),
    ('daily_logs','created_at'),('task_assignees','task_id'),('task_assignees','user_id')
  ) x(table_name,column_name)
  left join information_schema.columns c
    on c.table_schema='public' and c.table_name=x.table_name and c.column_name=x.column_name
  where c.column_name is null;
  if v_missing is not null then
    raise exception 'Required repository-lineage columns are missing: %',v_missing;
  end if;
end $$;

-- Assert the repository lineage before any query dereferences a required table. This is
-- deliberately earlier than the drift scan below so a missing prerequisite produces this
-- controlled error rather than a relation-does-not-exist parser/runtime error.
do $$ begin
  if to_regclass('public.tasks') is null
     or to_regclass('public.daily_logs') is null
     or to_regclass('public.task_assignees') is null
     or to_regclass('public.users') is null
     or to_regclass('public.clients') is null
     or to_regclass('public.impersonation_sessions') is null
     or to_regprocedure('public.task_visible_v2(text)') is null
     or to_regprocedure('public.task_closable(text)') is null
     or to_regprocedure('public.app_user_id()') is null
     or to_regprocedure('public.app_user_role()') is null
     or to_regprocedure('public.agent_assigned(text,text)') is null
     or to_regprocedure('pg_catalog.sha256(bytea)') is null then
    raise exception 'Foundation prerequisites are missing';
  end if;
end $$;

-- The existing Edge Function is the only INSERT path for impersonation_sessions. More than one
-- open row for the same effective Auth account makes the originating actor ambiguous and must be
-- repaired explicitly rather than guessed.
do $$ begin
  if exists (
    select employee_auth_id from public.impersonation_sessions
    where ended_at is null group by employee_auth_id having count(*)>1
  ) then raise exception 'Multiple open impersonation sessions exist for one effective identity'; end if;
end $$;
create unique index if not exists uq_impersonation_sessions_one_open_employee
  on public.impersonation_sessions(employee_auth_id) where ended_at is null;

-- p_session_id is an opaque correlation reference, never an identity assertion. Both identities
-- come from server-owned rows. A caller in an open impersonation session cannot omit or swap the
-- reference to make the mutation look like an ordinary employee action.
create or replace function public.resolve_task_audit_identity(p_session_id text default null)
returns table(effective_actor_id text, original_actor_id text, impersonation_session_id text)
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_effective text:=public.app_user_id(); v_session public.impersonation_sessions; v_count integer;
begin
  if v_effective is null then raise exception 'Authenticated employee identity is unavailable' using errcode='42501'; end if;
  select count(*),min(id) into v_count,impersonation_session_id
  from public.impersonation_sessions where employee_auth_id=auth.uid() and ended_at is null;
  if v_count>1 then raise exception 'Impersonation identity is ambiguous' using errcode='42501'; end if;
  if v_count=0 then
    if p_session_id is not null then raise exception 'Impersonation session is not active' using errcode='42501'; end if;
    effective_actor_id:=v_effective; original_actor_id:=v_effective; impersonation_session_id:=null;
    return next; return;
  end if;
  if p_session_id is distinct from impersonation_session_id then
    raise exception 'Active impersonation context is required for this mutation' using errcode='42501';
  end if;
  select * into v_session from public.impersonation_sessions
  where id=impersonation_session_id and employee_auth_id=auth.uid() and ended_at is null;
  if not found or v_session.employee_id<>v_effective then
    raise exception 'Impersonation identity does not match the effective employee' using errcode='42501';
  end if;
  effective_actor_id:=v_effective;
  original_actor_id:=v_session.admin_user_id;
  impersonation_session_id:=v_session.id;
  return next;
end $$;
revoke all on function public.resolve_task_audit_identity(text) from public,anon,authenticated;

-- IF NOT EXISTS is not a shape assertion. Fail before DDL when a same-named column already has
-- an incompatible type. Production lineage must still be compared with verification_READ_ONLY.sql.
do $$
declare v_bad text;
begin
  select string_agg(table_name||'.'||column_name||'='||data_type, ', ' order by table_name,column_name)
  into v_bad
  from information_schema.columns
  where table_schema='public'
    and ((table_name='tasks' and column_name in ('updated_at','row_version','lifecycle_cycle','source_task_id','archived_at','archived_by','archive_reason','blocked_from_status'))
      or (table_name='daily_logs' and column_name in ('updated_at','row_version')))
    and not (
      (column_name in ('updated_at','archived_at') and data_type='timestamp with time zone')
      or (column_name in ('row_version','lifecycle_cycle') and data_type='bigint')
      or (column_name in ('source_task_id','archived_by','archive_reason','blocked_from_status') and data_type='text')
    );
  if v_bad is not null then raise exception 'Incompatible existing proposal columns: %',v_bad; end if;
end $$;

-- The repository migrations promise a populated shadow table plus two-way compatibility sync.
-- Do not silently repair drift here; legacy conflicts need an explicit reviewed remediation.
do $$ begin
  if exists (
    select 1 from public.tasks t
    where exists (select 1 from public.task_assignees ta where ta.task_id=t.id)
      and (t.assigned_to is null or not exists (
        select 1 from public.task_assignees ta where ta.task_id=t.id and ta.user_id=t.assigned_to
      ))
  ) then
    raise exception 'tasks.assigned_to and task_assignees are not in the expected synchronized lineage';
  end if;
end $$;

-- RPC-only client authorization helper. This mirrors the latest repository definition of
-- clients_select_rls (20261104100000_task_visibility_cutover.sql) without replacing that policy.
-- Keeping the helper ungranted prevents it becoming a new client-enumeration API. A future
-- approved implementation must update this helper and clients_select_rls together if either
-- authorization contract changes.
create or replace function public.client_visible_for_task_rpc(p_client_id text)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select exists (
    select 1
    from public.clients c
    where c.id=p_client_id
      and case public.app_user_role()
        when 'sales' then c.sales_owner_id=public.app_user_id()
        when 'executive' then true
        when 'head_of_technical' then true
        when 'ai_engineer' then true
        when 'am_team_lead' then true
        when 'am_agent' then c.am_agent_id=public.app_user_id()
        when 'media_buying_team_lead' then true
        when 'media_buying_agent' then public.agent_assigned(c.id,'media_buying')
        when 'seo_team_lead' then true
        when 'social_media_team_lead' then true
        when 'seo_agent' then (
          public.agent_assigned(c.id,'seo')
          or exists (
            select 1 from public.tasks t
            where t.client_id=c.id
              and exists (
                select 1 from public.task_assignees ta
                where ta.task_id=t.id and ta.user_id=public.app_user_id()
              )
          )
        )
        when 'social_media_agent' then (
          public.agent_assigned(c.id,'social_media')
          or exists (
            select 1 from public.tasks t
            where t.client_id=c.id
              and exists (
                select 1 from public.task_assignees ta
                where ta.task_id=t.id and ta.user_id=public.app_user_id()
              )
          )
        )
        else exists (
          select 1 from public.tasks t
          where t.client_id=c.id
            and exists (
              select 1 from public.task_assignees ta
              where ta.task_id=t.id and ta.user_id=public.app_user_id()
            )
        )
      end
  );
$$;
revoke all on function public.client_visible_for_task_rpc(text) from public,anon,authenticated;

-- Compatibility predicate: normalized membership is authoritative when any normalized row exists;
-- assigned_to is only a fallback for a genuinely legacy task with zero task_assignees rows.
create or replace function public.task_actor_is_assignee(p_task_id text,p_user_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.task_assignees ta where ta.task_id=p_task_id and ta.user_id=p_user_id)
    or (
      not exists(select 1 from public.task_assignees ta where ta.task_id=p_task_id)
      and exists(select 1 from public.tasks t where t.id=p_task_id and t.assigned_to=p_user_id)
    );
$$;
revoke all on function public.task_actor_is_assignee(text,text) from public,anon,authenticated;

-- Keep history visibility compatible with the repository's current task_visible_v2 contract,
-- while active consumers receive an explicit archive filter. Neither helper grants mutation.
create or replace function public.task_history_visible_v2(p_task_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.task_visible_v2(p_task_id);
$$;
revoke all on function public.task_history_visible_v2(text) from public,anon;
grant execute on function public.task_history_visible_v2(text) to authenticated;

-- Explicit mutation scope: visibility alone is insufficient. Preserve creators/current assignees,
-- existing managing AM/team-lead responsibility, and leadership; deliberately exclude the
-- marketing-manager view-only branch from task_visible_v2.
create or replace function public.task_mutable_v2(p_task_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  with t as (select * from public.tasks where id=p_task_id)
  select public.app_user_role()<>'sales' and exists(select 1 from t) and (
    public.app_user_role() in ('executive','head_of_technical','ai_engineer')
    or exists(select 1 from t where created_by=public.app_user_id())
    or public.task_actor_is_assignee(p_task_id,public.app_user_id())
    or (public.app_user_role()='am_agent' and exists(select 1 from t where public.client_am_agent_is_caller(client_id)))
    or (
      public.app_user_role() in ('am_team_lead','media_buying_team_lead','seo_team_lead','social_media_team_lead')
      and (
        exists(select 1 from t join public.users u on u.id=t.created_by where u.team=public.app_user_team())
        or exists(select 1 from public.task_assignees ta join public.users u on u.id=ta.user_id
          where ta.task_id=p_task_id and u.team=public.app_user_team())
        or (public.app_user_role()='seo_team_lead' and (
          exists(select 1 from t join public.users u on u.id=t.created_by where u.team='Programming')
          or exists(select 1 from public.task_assignees ta join public.users u on u.id=ta.user_id
            where ta.task_id=p_task_id and u.team='Programming')
        ))
      )
    )
  );
$$;

create or replace function public.task_archive_allowed_v2(p_task_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.app_user_role() in ('executive','head_of_technical','ai_engineer')
    or exists(select 1 from public.tasks t where t.id=p_task_id and t.created_by=public.app_user_id())
    or public.task_actor_is_assignee(p_task_id,public.app_user_id());
$$;
revoke all on function public.task_mutable_v2(text),public.task_archive_allowed_v2(text) from public,anon,authenticated;
-- tasks_update_rls invokes task_mutable_v2 as the caller during the compatibility window.
-- The helper returns only a boolean and does not expose task contents.
grant execute on function public.task_mutable_v2(text) to authenticated;

-- Optimistic concurrency and reversible task removal. No existing task is archived or changed.
alter table public.tasks add column if not exists updated_at timestamptz not null default now();
alter table public.tasks add column if not exists row_version bigint not null default 1;
alter table public.tasks add column if not exists lifecycle_cycle bigint not null default 1;
alter table public.tasks add column if not exists source_task_id text;
alter table public.tasks add column if not exists archived_at timestamptz;
alter table public.tasks add column if not exists archived_by text;
alter table public.tasks add column if not exists archive_reason text;
alter table public.tasks add column if not exists blocked_from_status text;

-- IF NOT EXISTS on a column cannot guarantee its FK. Add the two proposal FKs explicitly and
-- reject a conflicting single-column FK instead of silently accepting a different lineage.
do $$
declare v_source smallint; v_archiver smallint;
begin
  select attnum into v_source from pg_attribute
  where attrelid='public.tasks'::regclass and attname='source_task_id' and not attisdropped;
  select attnum into v_archiver from pg_attribute
  where attrelid='public.tasks'::regclass and attname='archived_by' and not attisdropped;
  if exists(select 1 from pg_constraint where conrelid='public.tasks'::regclass and contype='f'
      and conkey=array[v_source] and (confrelid<>'public.tasks'::regclass or confdeltype<>'r')) then
    raise exception 'tasks.source_task_id has a conflicting foreign key';
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.tasks'::regclass and contype='f'
      and conkey=array[v_source] and confrelid='public.tasks'::regclass and confdeltype='r') then
    alter table public.tasks add constraint tasks_source_task_id_fkey
      foreign key(source_task_id) references public.tasks(id) on delete restrict;
  end if;
  if exists(select 1 from pg_constraint where conrelid='public.tasks'::regclass and contype='f'
      and conkey=array[v_archiver] and (confrelid<>'public.users'::regclass or confdeltype<>'r')) then
    raise exception 'tasks.archived_by has a conflicting foreign key';
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.tasks'::regclass and contype='f'
      and conkey=array[v_archiver] and confrelid='public.users'::regclass and confdeltype='r') then
    alter table public.tasks add constraint tasks_archived_by_fkey
      foreign key(archived_by) references public.users(id) on delete restrict;
  end if;
end $$;

create or replace function public.task_active_visible_v2(p_task_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.tasks t where t.id=p_task_id and t.archived_at is null)
    and public.task_history_visible_v2(p_task_id);
$$;
revoke all on function public.task_active_visible_v2(text) from public,anon;
grant execute on function public.task_active_visible_v2(text) to authenticated;

alter table public.tasks drop constraint if exists tasks_soft_delete_shape_check;
alter table public.tasks add constraint tasks_soft_delete_shape_check check (
  (archived_at is null and archived_by is null and archive_reason is null)
  or (archived_at is not null and archived_by is not null and nullif(trim(archive_reason),'') is not null)
);
alter table public.tasks drop constraint if exists tasks_lifecycle_cycle_check;
alter table public.tasks add constraint tasks_lifecycle_cycle_check check (lifecycle_cycle > 0);
alter table public.tasks drop constraint if exists tasks_blocked_from_status_check;
alter table public.tasks add constraint tasks_blocked_from_status_check check (
  blocked_from_status is null
  or (status='blocked' and blocked_from_status in ('todo','in_progress','in_review'))
);

-- Every UPDATE, including legacy direct writes and assignment/view-sync writes, receives a
-- server timestamp and monotonic version. This detects changes but cannot prevent lost updates
-- until direct writes are revoked and all mutations require an expected row_version.
create or replace function public.touch_task_row_version()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  new.updated_at:=clock_timestamp();
  new.row_version:=old.row_version+1;
  return new;
end; $$;
revoke all on function public.touch_task_row_version() from public,anon,authenticated;
drop trigger if exists touch_task_row_version_trigger on public.tasks;
create trigger touch_task_row_version_trigger before update on public.tasks
for each row execute function public.touch_task_row_version();

alter table public.daily_logs add column if not exists updated_at timestamptz not null default now();
alter table public.daily_logs add column if not exists row_version bigint not null default 1;
create or replace function public.touch_daily_log_row_version()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  new.updated_at:=clock_timestamp();
  new.row_version:=old.row_version+1;
  return new;
end; $$;
revoke all on function public.touch_daily_log_row_version() from public,anon,authenticated;
drop trigger if exists touch_daily_log_row_version_trigger on public.daily_logs;
create trigger touch_daily_log_row_version_trigger before update on public.daily_logs
for each row execute function public.touch_daily_log_row_version();

-- A table-level privilege would automatically cover the new system columns. Replace it with a
-- compatibility allowlist for the pre-cutover frontend. Trigger functions/SECURITY DEFINER RPCs
-- retain owner privileges; ordinary callers cannot set versions, cycles or archive identity.
revoke insert,update on public.tasks from public,anon,authenticated;
revoke insert(updated_at,row_version,lifecycle_cycle,source_task_id,archived_at,archived_by,archive_reason,blocked_from_status),
  update(updated_at,row_version,lifecycle_cycle,source_task_id,archived_at,archived_by,archive_reason,blocked_from_status)
  on public.tasks from authenticated,anon;
grant insert(id,client_id,title,description,assigned_to,created_by,team,status,due_date,priority,
  estimated_hours,actual_hours,created_at,parent_task_id,completed_at,assignee_viewed_at,drive_link,
  done_link,task_type,task_type_other,batch_id) on public.tasks to authenticated;
grant update(client_id,title,description,assigned_to,team,status,due_date,priority,estimated_hours,
  actual_hours,parent_task_id,completed_at,assignee_viewed_at,drive_link,done_link,task_type,
  task_type_other,batch_id) on public.tasks to authenticated;

revoke insert,update on public.daily_logs from public,anon,authenticated;
revoke insert(updated_at,row_version),update(updated_at,row_version)
  on public.daily_logs from authenticated,anon;
grant insert(id,user_id,date,summary_text,linked_task_ids,client_id,created_at)
  on public.daily_logs to authenticated;
grant update(date,summary_text,linked_task_ids,client_id) on public.daily_logs to authenticated;

create or replace function public.jsonb_text_array_valid(p_value jsonb,p_min integer,p_max integer)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select jsonb_typeof(p_value)='array'
    and jsonb_array_length(p_value) between p_min and p_max
    and not exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x.value)<>'string');
$$;
revoke all on function public.jsonb_text_array_valid(jsonb,integer,integer) from public,anon,authenticated;

-- Trusted append-only task ledger. task_id intentionally uses ON DELETE RESTRICT: initial design
-- does not permit hard deletion to erase the object whose history is being retained.
create table if not exists public.task_events (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references public.tasks(id) on delete restrict,
  batch_id text,
  event_type text not null,
  actor_id text not null references public.users(id),
  original_actor_id text not null references public.users(id),
  impersonation_session_id text references public.impersonation_sessions(id) on delete restrict,
  request_key uuid not null,
  event_ordinal integer not null default 0,
  schema_version integer not null default 1,
  before_state jsonb check (before_state is null or (
    jsonb_typeof(before_state)='object'
    and (before_state-array['status','completed_at','row_version','lifecycle_cycle','blocked_from_status','done_link_present']::text[])='{}'::jsonb
  )),
  after_state jsonb check (after_state is null or (
    jsonb_typeof(after_state)='object'
    and (after_state-array['status','completed_at','row_version','lifecycle_cycle','blocked_from_status','done_link_present']::text[])='{}'::jsonb
  )),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata)='object'
    and (metadata - array['reason','daily_log_id','source_task_id','batch_id','affected_count','changed_fields']::text[])='{}'::jsonb
    and (not metadata ? 'reason' or (jsonb_typeof(metadata->'reason')='string' and char_length(metadata->>'reason')<=500))
    and (not metadata ? 'changed_fields' or public.jsonb_text_array_valid(metadata->'changed_fields',1,20))
  ),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (impersonation_session_id is null and original_actor_id=actor_id)
    or impersonation_session_id is not null
  ),
  unique (actor_id, request_key, event_ordinal)
);
create index if not exists idx_task_events_task_created on public.task_events(task_id, created_at, id);

-- Per-employee, per-cycle evidence. No historical rows are fabricated by this migration.
create table if not exists public.task_completion_events (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references public.tasks(id) on delete restrict,
  user_id text not null references public.users(id),
  task_cycle bigint not null check (task_cycle > 0),
  completed_at timestamptz not null default clock_timestamp(),
  actor_id text not null references public.users(id),
  request_key uuid not null,
  evidence jsonb not null default '{"source":"task_transition_v2"}'::jsonb check (
    jsonb_typeof(evidence)='object'
    and (evidence - array['source','output_present']::text[])='{}'::jsonb
  ),
  unique (task_id, user_id, task_cycle),
  unique (actor_id, request_key)
);
create index if not exists idx_task_completion_user_date
  on public.task_completion_events(user_id, completed_at, task_id);

create table if not exists public.task_completion_revocations (
  completion_event_id uuid primary key references public.task_completion_events(id) on delete restrict,
  actor_id text not null references public.users(id),
  request_key uuid not null,
  reason text not null check (char_length(trim(reason)) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  unique(actor_id,request_key)
);

-- Normalized Daily Activity links. Denormalized scope columns make the concurrency contract
-- enforceable without joining from an index. RPCs must copy these values from daily_logs.
create table if not exists public.daily_log_task_links (
  daily_log_id text not null references public.daily_logs(id) on delete restrict,
  task_id text not null references public.tasks(id) on delete restrict,
  user_id text not null references public.users(id),
  report_date date not null,
  client_id text references public.clients(id),
  completion_event_id uuid references public.task_completion_events(id) on delete restrict,
  attribution_status text not null check (attribution_status in ('confirmed','historical_unknown')),
  created_by text references public.users(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (daily_log_id, task_id),
  check (
    (attribution_status='confirmed' and completion_event_id is not null and created_by is not null)
    or (attribution_status='historical_unknown' and completion_event_id is null)
  ),
  unique (user_id, report_date, task_id)
);
create index if not exists idx_daily_log_task_links_task on public.daily_log_task_links(task_id);

-- One server-owned idempotency record per actor/request. Payload hash prevents a key from being
-- reused with different work. Result JSON contains only IDs/outcomes, never sensitive content.
create table if not exists public.task_mutation_requests (
  actor_id text not null references public.users(id),
  original_actor_id text not null references public.users(id),
  impersonation_session_id text references public.impersonation_sessions(id) on delete restrict,
  request_key uuid not null,
  action text not null check (char_length(action) between 1 and 100),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  result jsonb check (result is null or (
    jsonb_typeof(result)='object'
    and (result-array['daily_log_ids','daily_log_versions','daily_log_id','row_version','task_id','deleted','affected_count']::text[])='{}'::jsonb
  )),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check (
    (impersonation_session_id is null and original_actor_id=actor_id)
    or impersonation_session_id is not null
  ),
  primary key (actor_id, request_key)
);

-- Immutable creation-time client snapshot for multi-client and All Clients batches. This helper
-- rejects NULL/blank/duplicate IDs without a CHECK-constraint subquery (which PostgreSQL forbids).
create or replace function public.task_batch_client_ids_valid(p_ids text[])
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select p_ids is not null
    and array_position(p_ids,null) is null
    and not exists (
      select 1 from unnest(p_ids) x(id)
      group by id having nullif(trim(id),'') is null or count(*)>1
    );
$$;
revoke all on function public.task_batch_client_ids_valid(text[]) from public,anon,authenticated;

create table if not exists public.task_batches (
  id uuid primary key,
  created_by text not null references public.users(id),
  original_actor_id text not null references public.users(id),
  impersonation_session_id text references public.impersonation_sessions(id) on delete restrict,
  request_key uuid not null,
  selection_mode text not null check (selection_mode in ('explicit','all_clients')),
  client_ids text[] not null check (public.task_batch_client_ids_valid(client_ids)),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  check ((impersonation_session_id is null and original_actor_id=created_by) or impersonation_session_id is not null),
  unique (created_by, request_key)
);

create table if not exists public.task_batch_items (
  batch_id uuid not null references public.task_batches(id) on delete restrict,
  item_ordinal integer not null check(item_ordinal>0),
  requested_client_id text,
  item_payload_hash text not null check(item_payload_hash ~ '^[0-9a-f]{64}$'),
  result_status text not null check(result_status in ('pending','succeeded','failed')),
  task_id text references public.tasks(id) on delete restrict,
  error_code text,
  error_message text,
  completed_at timestamptz,
  primary key(batch_id,item_ordinal),
  check (
    (result_status='pending' and task_id is null and error_code is null and error_message is null and completed_at is null)
    or (result_status='succeeded' and task_id is not null and error_code is null and error_message is null and completed_at is not null)
    or (result_status='failed' and task_id is null and nullif(trim(error_code),'') is not null
      and nullif(trim(error_message),'') is not null and char_length(error_message)<=500 and completed_at is not null)
  )
);

-- Reject same-named partial tables. These keys are the concurrency boundary, so merely finding a
-- relation with the expected name is not sufficient.
do $$
declare v_missing text;
begin
  select string_agg(x.table_name||'.'||x.column_name,', ' order by x.table_name,x.column_name)
  into v_missing
  from (values
    ('task_events','id'),('task_events','task_id'),('task_events','actor_id'),('task_events','original_actor_id'),('task_events','impersonation_session_id'),('task_events','request_key'),('task_events','event_ordinal'),
    ('task_completion_events','id'),('task_completion_events','task_id'),('task_completion_events','user_id'),('task_completion_events','task_cycle'),
    ('task_completion_revocations','completion_event_id'),('task_completion_revocations','actor_id'),('task_completion_revocations','request_key'),
    ('daily_log_task_links','daily_log_id'),('daily_log_task_links','task_id'),('daily_log_task_links','user_id'),('daily_log_task_links','report_date'),
    ('task_mutation_requests','actor_id'),('task_mutation_requests','original_actor_id'),('task_mutation_requests','impersonation_session_id'),('task_mutation_requests','request_key'),('task_mutation_requests','payload_hash'),('task_mutation_requests','result'),
    ('task_batches','id'),('task_batches','created_by'),('task_batches','original_actor_id'),('task_batches','impersonation_session_id'),('task_batches','request_key'),('task_batches','client_ids'),('task_batches','payload_hash'),
    ('task_batch_items','batch_id'),('task_batch_items','item_ordinal'),('task_batch_items','requested_client_id'),('task_batch_items','item_payload_hash'),('task_batch_items','result_status'),('task_batch_items','task_id')
  ) x(table_name,column_name)
  left join information_schema.columns c
    on c.table_schema='public' and c.table_name=x.table_name and c.column_name=x.column_name
  where c.column_name is null;
  if v_missing is not null then raise exception 'Proposal table shape is incomplete: %',v_missing; end if;

  if not exists(select 1 from pg_constraint where conrelid='public.daily_log_task_links'::regclass
      and contype in ('p','u') and conkey=array[
        (select attnum from pg_attribute where attrelid='public.daily_log_task_links'::regclass and attname='daily_log_id'),
        (select attnum from pg_attribute where attrelid='public.daily_log_task_links'::regclass and attname='task_id')])
     or not exists(select 1 from pg_constraint where conrelid='public.daily_log_task_links'::regclass
      and contype='u' and conkey=array[
        (select attnum from pg_attribute where attrelid='public.daily_log_task_links'::regclass and attname='user_id'),
        (select attnum from pg_attribute where attrelid='public.daily_log_task_links'::regclass and attname='report_date'),
        (select attnum from pg_attribute where attrelid='public.daily_log_task_links'::regclass and attname='task_id')])
     or not exists(select 1 from pg_constraint where conrelid='public.task_mutation_requests'::regclass
      and contype='p' and conkey=array[
        (select attnum from pg_attribute where attrelid='public.task_mutation_requests'::regclass and attname='actor_id'),
        (select attnum from pg_attribute where attrelid='public.task_mutation_requests'::regclass and attname='request_key')])
     or not exists(select 1 from pg_constraint where conrelid='public.task_events'::regclass
      and contype='u' and conkey=array[
        (select attnum from pg_attribute where attrelid='public.task_events'::regclass and attname='actor_id'),
        (select attnum from pg_attribute where attrelid='public.task_events'::regclass and attname='request_key'),
        (select attnum from pg_attribute where attrelid='public.task_events'::regclass and attname='event_ordinal')])
     or not exists(select 1 from pg_constraint where conrelid='public.task_completion_events'::regclass
      and contype='u' and conkey=array[
        (select attnum from pg_attribute where attrelid='public.task_completion_events'::regclass and attname='task_id'),
        (select attnum from pg_attribute where attrelid='public.task_completion_events'::regclass and attname='user_id'),
        (select attnum from pg_attribute where attrelid='public.task_completion_events'::regclass and attname='task_cycle')])
     or not exists(select 1 from pg_constraint where conrelid='public.task_completion_events'::regclass
      and contype='u' and conkey=array[
        (select attnum from pg_attribute where attrelid='public.task_completion_events'::regclass and attname='actor_id'),
        (select attnum from pg_attribute where attrelid='public.task_completion_events'::regclass and attname='request_key')])
     or not exists(select 1 from pg_constraint where conrelid='public.task_completion_revocations'::regclass
      and contype='u' and conkey=array[
        (select attnum from pg_attribute where attrelid='public.task_completion_revocations'::regclass and attname='actor_id'),
        (select attnum from pg_attribute where attrelid='public.task_completion_revocations'::regclass and attname='request_key')])
     or not exists(select 1 from pg_constraint where conrelid='public.task_batches'::regclass
      and contype='u' and conkey=array[
        (select attnum from pg_attribute where attrelid='public.task_batches'::regclass and attname='created_by'),
        (select attnum from pg_attribute where attrelid='public.task_batches'::regclass and attname='request_key')])
     or not exists(select 1 from pg_constraint where conrelid='public.task_batches'::regclass
      and contype='c' and pg_get_constraintdef(oid) like '%task_batch_client_ids_valid(client_ids)%')
     or not exists(select 1 from pg_constraint where conrelid='public.task_batches'::regclass
      and contype='c' and pg_get_constraintdef(oid) like '%payload_hash%64%')
     or not exists(select 1 from pg_constraint where conrelid='public.task_mutation_requests'::regclass
      and contype='c' and pg_get_constraintdef(oid) like '%payload_hash%64%') then
    raise exception 'Proposal concurrency constraints do not match the expected shape';
  end if;
end $$;

alter table public.task_events enable row level security;
alter table public.task_completion_events enable row level security;
alter table public.task_completion_revocations enable row level security;
alter table public.daily_log_task_links enable row level security;
alter table public.task_mutation_requests enable row level security;
alter table public.task_batches enable row level security;
alter table public.task_batch_items enable row level security;

drop policy if exists task_events_select_rls on public.task_events;
create policy task_events_select_rls on public.task_events for select to authenticated
using (public.task_visible_v2(task_id));
drop policy if exists task_completion_events_select_rls on public.task_completion_events;
create policy task_completion_events_select_rls on public.task_completion_events for select to authenticated
using (public.task_visible_v2(task_id));
drop policy if exists task_completion_revocations_select_rls on public.task_completion_revocations;
create policy task_completion_revocations_select_rls on public.task_completion_revocations for select to authenticated
using (exists(select 1 from public.task_completion_events e where e.id=completion_event_id and public.task_visible_v2(e.task_id)));
drop policy if exists daily_log_task_links_select_rls on public.daily_log_task_links;
create policy daily_log_task_links_select_rls on public.daily_log_task_links for select to authenticated
using (exists (select 1 from public.daily_logs d where d.id=daily_log_task_links.daily_log_id));
drop policy if exists task_mutation_requests_select_own_rls on public.task_mutation_requests;
create policy task_mutation_requests_select_own_rls on public.task_mutation_requests for select to authenticated
using (actor_id=public.app_user_id());
drop policy if exists task_batches_select_rls on public.task_batches;
create policy task_batches_select_rls on public.task_batches for select to authenticated
using (created_by=public.app_user_id() or public.app_user_role() in ('executive','head_of_technical','ai_engineer'));
drop policy if exists task_batch_items_select_rls on public.task_batch_items;
create policy task_batch_items_select_rls on public.task_batch_items for select to authenticated
using (exists(select 1 from public.task_batches b where b.id=batch_id));

create or replace function public.guard_task_batch_item_mutation()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if tg_op='DELETE' then raise exception 'task_batch_items is immutable'; end if;
  if old.result_status<>'pending' or new.result_status not in ('succeeded','failed')
     or row(old.batch_id,old.item_ordinal,old.requested_client_id,old.item_payload_hash)
        is distinct from row(new.batch_id,new.item_ordinal,new.requested_client_id,new.item_payload_hash) then
    raise exception 'task_batch_items permits only one pending-to-final transition';
  end if;
  return new;
end $$;
revoke all on function public.guard_task_batch_item_mutation() from public,anon,authenticated;
drop trigger if exists task_batch_items_immutable_trigger on public.task_batch_items;
create trigger task_batch_items_immutable_trigger before update or delete on public.task_batch_items
for each row execute function public.guard_task_batch_item_mutation();

-- True append-only enforcement also protects against accidental service-role UPDATE/DELETE.
create or replace function public.reject_append_only_mutation()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin raise exception '% is append-only',tg_table_name; end; $$;
revoke all on function public.reject_append_only_mutation() from public,anon,authenticated;
drop trigger if exists task_events_append_only_trigger on public.task_events;
create trigger task_events_append_only_trigger before update or delete on public.task_events
for each row execute function public.reject_append_only_mutation();
drop trigger if exists task_completion_events_append_only_trigger on public.task_completion_events;
create trigger task_completion_events_append_only_trigger before update or delete on public.task_completion_events
for each row execute function public.reject_append_only_mutation();
drop trigger if exists task_completion_revocations_append_only_trigger on public.task_completion_revocations;
create trigger task_completion_revocations_append_only_trigger before update or delete on public.task_completion_revocations
for each row execute function public.reject_append_only_mutation();

revoke all on public.task_events, public.task_completion_events, public.task_completion_revocations, public.daily_log_task_links,
  public.task_mutation_requests, public.task_batches, public.task_batch_items from public, anon, authenticated;
grant select on public.task_events, public.task_completion_events, public.task_completion_revocations, public.daily_log_task_links,
  public.task_mutation_requests, public.task_batches, public.task_batch_items to authenticated;
grant all on public.task_events, public.task_completion_events, public.task_completion_revocations, public.daily_log_task_links,
  public.task_mutation_requests, public.task_batches, public.task_batch_items to service_role;

-- No backfill here. historical_conflicts_READ_ONLY.sql must be reviewed first, followed by a
-- separate explicit mapping of rows that can be proven. Unknown attribution remains unknown.
commit;
