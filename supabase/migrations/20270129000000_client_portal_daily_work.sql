-- ============================================================================
-- Client Portal — Daily Work Feed + per-department ratings (MVP, 2026-11-26)
--
-- Shows the client, grouped by department and by day, the actual work logged
-- for them (reusing public.daily_logs — the same source Reports already pull
-- from, see src/lib/reportDraftSources.ts), and lets the client leave one
-- star rating + optional comment per department per day.
--
-- Department resolution deliberately reuses the existing, admin-managed
-- public.departments / public.department_member_teams tables (the same data
-- that backs getOperationalTeams()/getCombinedTeamValuesFromCache() in
-- src/lib/departmentStaffing.ts and src/data/customRoles.ts) instead of a
-- new hardcoded department list — team_value is unique across
-- department_member_teams (20261102000000), so 'Video Production' and
-- 'Creative & Design' both resolve to the single 'creative_design'
-- department, matching how CapacityManagement/task assignment already treat
-- that pairing as one combined team.
--
-- A log's department is resolved from, in order:
--   1. its first linked task's `team` (tasks.team) — most specific
--   2. the logging employee's own `users.team` — fallback for logs with no
--      linked task
-- A log that resolves to neither (no matching department_member_teams row)
-- is simply left out of department_id/department_label (NULL) rather than
-- hidden — the frontend buckets NULL under a generic "Other" section instead
-- of silently dropping real work.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. client_portal_work_ratings
-- ----------------------------------------------------------------------------
create table if not exists public.client_portal_work_ratings (
  id text primary key,
  client_id text not null references public.clients (id),
  department_id text not null references public.departments (id),
  work_date date not null,
  rating smallint not null,
  comment text,
  created_by text not null references public.client_portal_users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.client_portal_work_ratings
  add constraint client_portal_work_ratings_rating_check check (rating between 1 and 5);

-- One rating per department per day per client — portal_submit_work_rating() below upserts
-- against this.
create unique index if not exists idx_cpwr_unique
  on public.client_portal_work_ratings (client_id, department_id, work_date);
create index if not exists idx_cpwr_client_id on public.client_portal_work_ratings (client_id);

alter table public.client_portal_work_ratings enable row level security;

-- Client-portal session: only its own client's ratings, and only through the RPC below for
-- writes (no direct insert/update grant to authenticated — see grants at the bottom).
create policy "client_portal_work_ratings_select_portal_rls" on public.client_portal_work_ratings
for select to authenticated
using (client_id = public.portal_client_id());

-- Staff visibility: the same role set that already sees the client's row via clients_select_rls
-- (executive/head_of_technical/am_team_lead always; am_agent only their own assigned client) —
-- so the AM handling a client can see what that client actually rated.
create policy "client_portal_work_ratings_select_staff_rls" on public.client_portal_work_ratings
for select to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical', 'am_team_lead')
  or (public.app_user_role() = 'am_agent' and public.client_am_agent_is_caller(client_id))
);

grant select on public.client_portal_work_ratings to authenticated;

-- ----------------------------------------------------------------------------
-- 2. portal_get_daily_work — read the client's own work feed
-- ----------------------------------------------------------------------------
create or replace function public.portal_get_daily_work(p_from date default null, p_to date default null)
returns table (
  log_id text,
  work_date date,
  summary_text text,
  department_id text,
  department_label text,
  task_id text,
  task_title text,
  rating smallint,
  rating_comment text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_client_id text := public.portal_client_id();
begin
  if v_client_id is null then
    return;
  end if;

  return query
  select
    dl.id,
    dl.date,
    dl.summary_text,
    d.id,
    d.label,
    t.task_id,
    t.title,
    r.rating,
    r.comment
  from public.daily_logs dl
  left join lateral (
    select tt.id as task_id, tt.title, tt.team
    from unnest(dl.linked_task_ids) with ordinality as lt(task_id, ord)
    join public.tasks tt on tt.id = lt.task_id
    order by lt.ord
    limit 1
  ) t on true
  left join public.users u on u.id = dl.user_id
  left join public.department_member_teams dmt on dmt.team_value = coalesce(t.team, u.team)
  left join public.departments d on d.id = dmt.department_id and d.is_active
  left join public.client_portal_work_ratings r
    on r.client_id = v_client_id and r.department_id = d.id and r.work_date = dl.date
  where dl.client_id = v_client_id
    and (p_from is null or dl.date >= p_from)
    and (p_to is null or dl.date <= p_to)
  order by dl.date desc, dl.id desc;
end;
$$;

revoke all on function public.portal_get_daily_work(date, date) from public;
revoke all on function public.portal_get_daily_work(date, date) from anon;
grant execute on function public.portal_get_daily_work(date, date) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. portal_submit_work_rating — the client rates one department's work on one day
-- ----------------------------------------------------------------------------
create or replace function public.portal_submit_work_rating(
  p_department_id text,
  p_work_date date,
  p_rating smallint,
  p_comment text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client_id text := public.portal_client_id();
  v_portal_user_id text;
begin
  if v_client_id is null then
    raise exception 'You must be signed in to the client portal to submit a rating.';
  end if;

  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5.';
  end if;

  if not exists (select 1 from public.departments where id = p_department_id) then
    raise exception 'Unknown department.';
  end if;

  select id into v_portal_user_id from public.client_portal_users where auth_id = auth.uid();
  if v_portal_user_id is null then
    raise exception 'Client portal account not found.';
  end if;

  insert into public.client_portal_work_ratings
    (id, client_id, department_id, work_date, rating, comment, created_by)
  values
    (gen_random_uuid()::text, v_client_id, p_department_id, p_work_date, p_rating, p_comment, v_portal_user_id)
  on conflict (client_id, department_id, work_date)
  do update set rating = excluded.rating, comment = excluded.comment, updated_at = now();
end;
$$;

revoke all on function public.portal_submit_work_rating(text, date, smallint, text) from public;
revoke all on function public.portal_submit_work_rating(text, date, smallint, text) from anon;
grant execute on function public.portal_submit_work_rating(text, date, smallint, text) to authenticated;

commit;
