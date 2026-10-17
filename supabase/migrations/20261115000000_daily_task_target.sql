-- users.daily_task_target — per-employee daily task-count target (tasks/day), backing the Daily
-- Operations Module's "Delivered today: N / target" card (and, optionally, an override for the
-- role-based default the designer-scheduling suggester currently uses).
--
-- Column-level write-protection audit of users.capacity_limit, before this migration touches
-- anything (requested explicitly — reported in full here):
--
--   - users_update_capacity_rls / users_update_profile_rls / users_deactivate_rls
--     (20261101700000_users_edit_scope_hardening.sql) are three DIFFERENTLY NAMED but BYTE-
--     IDENTICAL row-level predicates:
--       app_user_role() = any(array['executive','head_of_technical','am_team_lead',
--         'media_buying_team_lead','seo_team_lead','social_media_team_lead'])
--       and employee_manageable(id, role)
--     Postgres RLS has no column granularity: once a row passes ANY ONE permissive policy's
--     USING + WITH CHECK, the whole UPDATE statement — whichever columns it sets — is allowed
--     through for that row, regardless of which policy's NAME implied a narrower intent. These
--     three policies therefore do NOT separate "who may touch capacity_limit" from "who may touch
--     team/profile fields" at the database layer at all — that separation exists only in the
--     application's own TS-typed handlers (handleUpdateUserCapacity vs. the profile-edit path).
--
--   - employee_manageable(target_id, target_role) (20261101700000) includes an unconditional
--     `target_id = app_user_id()` branch — true whenever a caller is editing their OWN row. An
--     ordinary agent role is never in the 6-role list above, so an ordinary agent can never touch
--     this column at all (self or otherwise) — RLS blocks them outright. But a team lead or
--     executive/head_of_technical IS in that list, and so CAN today self-edit their OWN
--     capacity_limit via that branch. No trigger closes this: users_update_guard_trigger
--     (20261030000000_users_update_guard_trigger.sql) only ever inspects id/auth_id/role/team/
--     manager_id — capacity_limit is entirely outside its scope.
--
--   - Conclusion: capacity_limit's real protection is RLS-only, and RLS alone cannot block a
--     self-edit without blocking every other write that same policy enables for that row. The
--     only place in this schema that successfully enforces "no self-edit of this one column, even
--     though the row otherwise qualifies for this caller" is users_update_guard_trigger, via its
--     own per-column NEW/OLD comparisons (its existing Rule 2, for role/team/manager_id).
--
-- Given the owner's explicit requirement — same gate as capacity_limit, but NO self-edit for
-- anyone, including a team lead or executive editing their own row — this migration does two
-- things, not one: (1) a 4th RLS policy with the exact same row-level predicate as the other
-- three (sufficient for "someone else's row", and kept consistent with precedent); (2) extends
-- users_update_guard_trigger with an explicit self-edit block for daily_task_target (new Rule 5
-- below) — the one requirement RLS cannot satisfy on its own. The trigger rule, not the RLS
-- policy, is what actually stops self-edit.
--
-- users_update_guard()'s body below is sourced from the LIVE production definition
-- (pg_get_functiondef('public.users_update_guard'::regproc), captured the same day this
-- migration was written) — NOT from 20261030000000_users_update_guard_trigger.sql in this repo,
-- which had drifted from production: that file still checks password (production does not — the
-- password column write-path changed since), and its seo_dept_roles/SEO error message list only
-- 4 roles where production's live list has 5 (adds store_manager). Only Rule 5 at the end is new
-- here; every rule above it is copied verbatim from the live definition.
begin;

alter table public.users
  add column if not exists daily_task_target integer null;

alter table public.users
  add constraint users_daily_task_target_check
  check (daily_task_target is null or (daily_task_target >= 0 and daily_task_target <= 50));

-- Same row-level predicate as users_update_capacity_rls/users_update_profile_rls/
-- users_deactivate_rls (see header): executive/head_of_technical unrestricted (NOT ai_engineer —
-- matches employee_manageable()'s own role list exactly), the 4 team leads scoped to their own
-- department via employee_manageable(). Self-edit is blocked in the trigger below, not here.
drop policy if exists "users_update_daily_task_target_rls" on public.users;
create policy "users_update_daily_task_target_rls" on public.users
for update to authenticated
using (
  public.app_user_role() = any (array['executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'])
  and public.employee_manageable(id, role)
)
with check (
  public.app_user_role() = any (array['executive', 'head_of_technical', 'am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'])
  and public.employee_manageable(id, role)
);

-- Extends users_update_guard() (20261030000000_users_update_guard_trigger.sql) with one more
-- rule at the end — CREATE OR REPLACE on the same function; the trigger definition itself
-- (before update on public.users, for each row) is untouched and needs no re-creation. Every
-- rule above Rule 5 is a byte-for-byte copy of the LIVE function body (captured via
-- pg_get_functiondef('public.users_update_guard'::regproc) against production on the date this
-- migration was written), not of any file in this repo — repo and production had drifted (no
-- password check live; seo_dept_roles live has 5 roles, including store_manager, and the SEO
-- team lead error message names it too). Only Rule 5 at the end is new.
create or replace function public.users_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id text;
  caller_role text;
  seo_dept_roles text[] := array['seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent', 'store_manager'];
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;

  if new.id is distinct from old.id then
    raise exception 'id cannot be changed.';
  end if;
  if new.auth_id is distinct from old.auth_id then
    raise exception 'auth_id cannot be changed here — it is only ever set once, by the employee invitation/test-account setup process.';
  end if;

  caller_id := public.app_user_id();
  caller_role := public.app_user_role();

  if old.id = caller_id then
    if new.role is distinct from old.role then
      raise exception 'You cannot change your own role.';
    end if;
    if new.team is distinct from old.team then
      raise exception 'You cannot change your own team.';
    end if;
    if new.manager_id is distinct from old.manager_id then
      raise exception 'You cannot change your own manager.';
    end if;
  end if;

  if (new.team is distinct from old.team) or (new.manager_id is distinct from old.manager_id) then
    if caller_role not in ('executive', 'head_of_technical', 'ai_engineer') then
      raise exception 'Only Executive, Head of Technical, or AI Engineer may change team or manager.';
    end if;
  end if;

  if new.role is distinct from old.role then
    if caller_role in ('executive', 'head_of_technical', 'ai_engineer') then
      null;
    elsif caller_role = 'am_team_lead' then
      if old.role is distinct from 'am_agent' or new.role is distinct from 'am_agent' then
        raise exception 'Account Management Team Leads may only change role within am_agent.';
      end if;
    elsif caller_role = 'media_buying_team_lead' then
      if old.role is distinct from 'media_buying_agent' or new.role is distinct from 'media_buying_agent' then
        raise exception 'Media Buying Team Leads may only change role within media_buying_agent.';
      end if;
    elsif caller_role = 'seo_team_lead' then
      if not (old.role = any(seo_dept_roles) and new.role = any(seo_dept_roles)) then
        raise exception 'SEO Team Leads may only change role among SEO department agent roles (seo_agent, programming_agent, seo_content_agent, seo_backlink_agent, store_manager).';
      end if;
    elsif caller_role = 'social_media_team_lead' then
      if old.role is distinct from 'social_media_agent' or new.role is distinct from 'social_media_agent' then
        raise exception 'Social Media Team Leads may only change role within social_media_agent.';
      end if;
    else
      raise exception 'You are not authorized to change role.';
    end if;
  end if;

  -- Rule 5 (new): daily_task_target — no self-edit for anyone, regardless of role (deliberately
  -- narrower than capacity_limit's own current behavior — see this migration's header). Someone
  -- ELSE's row still needs executive/head_of_technical, or employee_manageable() (a team lead
  -- within their own department) — the same scope the RLS policy above already enforces at the
  -- row level; repeated here to produce a clear, specific error message instead of a generic RLS
  -- rejection (and because RLS, as explained in the header, cannot enforce the self-edit block on
  -- its own).
  if new.daily_task_target is distinct from old.daily_task_target then
    if old.id = caller_id then
      raise exception 'You cannot change your own daily task target.';
    end if;
    if not (
      caller_role in ('executive', 'head_of_technical')
      or public.employee_manageable(old.id, old.role)
    ) then
      raise exception 'Only Executive, Head of Technical, or a team lead within their own department may change a daily task target.';
    end if;
  end if;

  return new;
end;
$$;

commit;
