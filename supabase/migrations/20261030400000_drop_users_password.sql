-- Drops the real plaintext public.users.password column — the "KNOWN SECURITY DEBT" flagged
-- repeatedly across this migration history (20261011130000_assignable_employees_rpc.sql's header,
-- src/types/database.ts's own UserRecord.password comment) ever since real Supabase Auth (auth_id)
-- became the actual authentication mechanism.
--
-- Confirmed via a full audit of every migration in supabase/migrations/ that the ONLY policy,
-- function, trigger, or index anywhere in this schema's history that references users.password is
-- users_update_guard() (introduced by 20261030000000_users_update_guard_trigger.sql), which blocks
-- any UPDATE from changing it. No RLS policy, view, index, or other RPC ever selects, filters on,
-- or writes this column — the only other "password" hits in supabase/migrations/ are the four
-- `create table public.users (...)` snapshots that merely declare the column
-- (20260916100000/20260919100000/20260926100000/20260928100000_canonical_schema*.sql), plain-text
-- comments, and the entirely unrelated client-facing *_password columns on public.clients
-- (general_email_password/store_platform_password/social_media_password/ad_account_password),
-- which this migration does not touch.
--
-- Order matters: the function is replaced FIRST, with its two `new.password`/`old.password` checks
-- removed, so that by the time `alter table ... drop column` runs immediately after, the trigger
-- body no longer references a column that's about to disappear. Recreating the function (rather
-- than leaving the dead checks in place until the column drop would force the issue) keeps the
-- function always valid instead of relying on drop-column's own cascade behavior to clean it up.
-- No `cascade` is used on the drop — if anything other than this trigger still depended on the
-- column, this migration fails loudly instead of silently dropping that dependent object too.
begin;

-- 1. Recreate the guard trigger function with the password-immutability checks removed — the
-- column they protected no longer exists after this migration. Every other rule (id/auth_id
-- immutability, self-edit restrictions, team-lead role-change scoping) is unchanged, verbatim.
create or replace function public.users_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id text;
  caller_role text;
  seo_dept_roles text[] := array['seo_agent', 'programming_agent', 'seo_content_agent', 'seo_backlink_agent'];
begin
  -- Enforced only for a real browser session (anon key + user JWT). service_role (Edge Functions,
  -- scripts/provisionAuthUsers.ts etc.), the `postgres` role, and the Supabase SQL Editor (which
  -- runs without an authenticated-role JWT) are all unaffected — auth.role() reads the JWT's own
  -- `role` claim via current_setting('request.jwt.claims', ...), which is simply absent/different
  -- in those contexts.
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;

  -- Rule 1: id and auth_id are immutable through this path, for every authenticated caller, with
  -- no exception — including the 7 roles the RLS policies would otherwise let touch this row.
  -- auth_id is exclusively the two service-role Edge Function paths' to set (employee-invitation,
  -- employee-test-account), both already write-once-guarded there; id must never change via an
  -- application UPDATE at all.
  if new.id is distinct from old.id then
    raise exception 'id cannot be changed.';
  end if;
  if new.auth_id is distinct from old.auth_id then
    raise exception 'auth_id cannot be changed here — it is only ever set once, by the employee invitation/test-account setup process.';
  end if;

  caller_id := public.app_user_id();
  caller_role := public.app_user_role();

  -- Rule 2: no authenticated caller — regardless of role, including executive/head_of_technical/
  -- ai_engineer — may change their OWN role, team, or manager_id through this path. Checked before
  -- rules 3/4 so a self-edit gets this specific message rather than the generic role-based one.
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

  -- Rule 3: team / manager_id on someone ELSE's row — executive, head_of_technical, ai_engineer
  -- only. Deliberately narrower than rule 4's role-change allowance: team leads may move their own
  -- department's agents between agent-level roles, but never reassign who manages them or what
  -- team they're counted under.
  if (new.team is distinct from old.team) or (new.manager_id is distinct from old.manager_id) then
    if caller_role not in ('executive', 'head_of_technical', 'ai_engineer') then
      raise exception 'Only Executive, Head of Technical, or AI Engineer may change team or manager.';
    end if;
  end if;

  -- Rule 4: role changes on someone ELSE's row.
  if new.role is distinct from old.role then
    if caller_role in ('executive', 'head_of_technical', 'ai_engineer') then
      null; -- unrestricted, matches users_insert_admin_rls's same three-role tier
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
        raise exception 'SEO Team Leads may only change role among SEO department agent roles (seo_agent, programming_agent, seo_content_agent, seo_backlink_agent).';
      end if;
    elsif caller_role = 'social_media_team_lead' then
      if old.role is distinct from 'social_media_agent' or new.role is distinct from 'social_media_agent' then
        raise exception 'Social Media Team Leads may only change role within social_media_agent.';
      end if;
    else
      raise exception 'You are not authorized to change role.';
    end if;
  end if;

  return new;
end;
$$;

-- Unchanged from the original grant: no one needs direct EXECUTE on this function — it is only
-- ever invoked by the trigger mechanism, and CREATE OR REPLACE does not reset a function's
-- existing grants anyway. Repeated here so this migration documents the function's complete,
-- intended privilege state on its own, the same convention 20261030300000_revoke_excess_privileges.sql
-- used for its own already-applied items.
revoke execute on function public.users_update_guard() from public;

-- 2. Drop the column itself. No cascade: if anything other than users_update_guard() still
-- depended on it, this fails loudly instead of silently dropping that dependent object too.
alter table public.users drop column if exists password;

commit;
