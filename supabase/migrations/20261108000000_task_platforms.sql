-- Adds an optional "Platforms" multi-select tag to tasks (Instagram/TikTok/Snapchat/...),
-- independent of task_types. Two new tables:
--
--   public.platforms — admin-managed reference list (add/rename/deactivate), seeded with
--   Instagram, TikTok, Snapchat. Same "no DELETE policy, deactivate via active=false" posture as
--   task_types (20261031900000_task_types.sql), for the same reason: a task that already
--   references a platform must never be left pointing at a row that no longer exists. Read access
--   is open to every authenticated user EXCEPT sales (sales has no door onto tasks at all per
--   task_visible_v2 — this read policy keeps that exclusion explicit and symmetric rather than
--   relying only on task_platform_links' own task_visible_v2-gated SELECT to hide the option list
--   from sales). Write access (insert/update) is restricted to executive/head_of_technical/
--   ai_engineer — the same three-role admin set already used for task_closable's admin branch and
--   task_visible_v2's "always visible" branch, one role wider than task_types' own
--   executive/head_of_technical-only gate because ai_engineer is this project's third admin role.
--
--   public.task_platform_links — join table, task_id -> platform_id, cascade-deleted with its
--   task (platforms are never deleted, so no cascade is needed on that side). No INSERT/UPDATE/
--   DELETE policy and no insert/update/delete grant at all — every write goes through
--   set_task_platforms() below, SECURITY DEFINER, exactly as task_assignees has "no UPDATE grant
--   for authenticated at all" per 20261105000000_task_assignees_rpcs.sql's own comment on
--   mark_task_viewed. SELECT is gated by task_visible_v2(task_id) — the same single door already
--   used for task_attachments/task_comments visibility — so a platform tag is only ever visible
--   to someone who can already see the task itself.
--
-- set_task_platforms(p_task_id, p_platform_ids) replaces a task's full platform set. Its
-- permission gate is byte-identical to set_task_assignees' gate (same migration referenced
-- above): task_closable(p_task_id) [admin roles / creator / any current assignee] OR an am_agent
-- who manages the task's client OR an am_team_lead whose own team includes the am_agent managing
-- the task's client OR any of the 4 team-lead roles on a task visible to them via the team rule,
-- with sales explicitly excluded exactly as that gate excludes it, and marketing_manager
-- structurally excluded the same way that gate excludes it (never granted a branch of its own,
-- so task_visible_v2's creative-role visibility door never doubles as a management door — see
-- that migration's own header comment for why). Re-verified against
-- 20261105000000_task_assignees_rpcs.sql directly for this change: it is still the only, and so
-- the latest, migration defining set_task_assignees (confirmed via `grep -rl set_task_assignees
-- supabase/migrations/`), unchanged since PR #91 (`git log --oneline -- <that file>` shows a
-- single commit) and identical between this branch and origin/main — so there was nothing to
-- reconcile; the gate below is copied from that exact, current text. Copied rather than factored
-- into a shared helper so that a future change to one RPC's authorization never silently changes
-- the other's. Every requested id is validated against platforms (must exist and be active)
-- before anything is written, on EVERY call (never grandfathered just because it was already
-- part of the set) — so deactivating a platform leaves any existing task_platform_links row
-- alone, but blocks it from a future set_task_platforms call, new or repeated. The full set is
-- capped at 10 platforms per task; a no-op diff is a plain delete+insert of the same rows
-- (platforms carries no per-row audit log or notification, so unlike set_task_assignees there is
-- nothing to skip by special-casing "unchanged").
begin;

-- ----------------------------------------------------------------------------
-- 1. public.platforms
-- ----------------------------------------------------------------------------
create table public.platforms (
  id text primary key,
  name text not null unique,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_platforms_active_sort on public.platforms (active, sort_order);

alter table public.platforms enable row level security;

create policy "platforms_select_rls" on public.platforms
for select to authenticated
using (public.app_user_role() <> 'sales');

create policy "platforms_write_rls" on public.platforms
for insert to authenticated
with check (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer'));

create policy "platforms_update_rls" on public.platforms
for update to authenticated
using (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer'))
with check (public.app_user_role() in ('executive', 'head_of_technical', 'ai_engineer'));

-- No delete policy: rows are deactivated (active = false) rather than removed, so that tasks
-- already tagged with a retired platform keep a valid reference.

grant select, insert, update on public.platforms to authenticated;
grant all on public.platforms to service_role;

-- ----------------------------------------------------------------------------
-- 2. public.task_platform_links
-- ----------------------------------------------------------------------------
create table public.task_platform_links (
  task_id text not null references public.tasks(id) on delete cascade,
  platform_id text not null references public.platforms(id),
  created_at timestamptz not null default now(),
  primary key (task_id, platform_id)
);

create index idx_task_platform_links_platform_id on public.task_platform_links (platform_id);

alter table public.task_platform_links enable row level security;

create policy "task_platform_links_select_rls" on public.task_platform_links
for select to authenticated
using (public.task_visible_v2(task_id));

-- No insert/update/delete policy — every write goes through set_task_platforms() (SECURITY
-- DEFINER) below.

grant select on public.task_platform_links to authenticated;
grant all on public.task_platform_links to service_role;

-- ----------------------------------------------------------------------------
-- 3. Seed data (idempotent via the unique(name) constraint above).
-- ----------------------------------------------------------------------------
insert into public.platforms (id, name, sort_order, active)
values
  ('instagram', 'Instagram', 0, true),
  ('tiktok', 'TikTok', 1, true),
  ('snapchat', 'Snapchat', 2, true)
on conflict (name) do nothing;

-- ----------------------------------------------------------------------------
-- 4. set_task_platforms(p_task_id, p_platform_ids) — replaces a task's full platform set.
-- ----------------------------------------------------------------------------
create or replace function public.set_task_platforms(p_task_id text, p_platform_ids text[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.tasks;
  v_ids text[] := array[]::text[];
  v_id text;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found';
  end if;

  -- Gate — byte-identical to set_task_assignees' gate
  -- (20261105000000_task_assignees_rpcs.sql). See that migration's header comment for the full
  -- rationale; copied rather than shared so the two RPCs' authorization can never drift apart
  -- silently. sales is excluded explicitly (not just structurally).
  if public.app_user_role() = 'sales' or not (
    public.task_closable(p_task_id)
    or (
      public.app_user_role() = 'am_agent'
      and v_task.client_id is not null
      and public.client_am_agent_is_caller(v_task.client_id)
    )
    or (
      public.app_user_role() = 'am_team_lead'
      and v_task.client_id is not null
      and exists (
        select 1 from public.clients c
        join public.users ua on ua.id = c.am_agent_id
        where c.id = v_task.client_id and ua.team = public.app_user_team()
      )
    )
    or (
      public.app_user_role() in ('am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead')
      and (
        exists (select 1 from public.users u where u.id = v_task.created_by and u.team = public.app_user_team())
        or exists (
          select 1 from public.task_assignees ta
          join public.users u on u.id = ta.user_id
          where ta.task_id = p_task_id and u.team = public.app_user_team()
        )
        or (
          public.app_user_role() = 'seo_team_lead'
          and (
            exists (select 1 from public.users u where u.id = v_task.created_by and u.team = 'Programming')
            or exists (
              select 1 from public.task_assignees ta
              join public.users u on u.id = ta.user_id
              where ta.task_id = p_task_id and u.team = 'Programming'
            )
          )
        )
      )
    )
  ) then
    raise exception 'You do not have permission to modify this task''s platforms.';
  end if;

  -- Dedupe + drop null/blank ids, preserving first-occurrence order.
  foreach v_id in array coalesce(p_platform_ids, array[]::text[]) loop
    if v_id is not null and v_id <> '' and not (v_id = any(v_ids)) then
      v_ids := array_append(v_ids, v_id);
    end if;
  end loop;

  if array_length(v_ids, 1) is not null and array_length(v_ids, 1) > 10 then
    raise exception 'A task may have at most 10 platforms.';
  end if;

  -- Every id must exist and be active. Checked before anything is written, so a bad id leaves the
  -- task's existing platform set untouched rather than partially replaced.
  foreach v_id in array v_ids loop
    if not exists (select 1 from public.platforms where id = v_id and active = true) then
      raise exception 'Platform % does not exist or is not active.', v_id;
    end if;
  end loop;

  delete from public.task_platform_links where task_id = p_task_id;

  if array_length(v_ids, 1) is not null then
    insert into public.task_platform_links (task_id, platform_id)
    select p_task_id, u from unnest(v_ids) as u;
  end if;
end;
$$;

revoke all on function public.set_task_platforms(text, text[]) from public, anon;
grant execute on function public.set_task_platforms(text, text[]) to authenticated, service_role;

commit;
