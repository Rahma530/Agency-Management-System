-- BEFORE UPDATE trigger on public.users enforcing who may change which columns, at the database
-- layer, independent of (and in addition to) the row-level users_update_* RLS policies. RLS alone
-- is row-level, not column-level: users_update_profile_rls/users_update_capacity_rls/
-- users_deactivate_rls all share the same 7-role USING/WITH CHECK predicate
-- (executive/head_of_technical/ai_engineer/the 4 team leads, scoped by employee_visible(id, role)),
-- which means any of those 7 roles can currently set ANY column — including role, auth_id,
-- manager_id, team, or (if it were ever populated) password — on any row employee_visible() lets
-- them touch, via a raw .update({...}) call that bypasses the app's own TS-typed
-- handleUpdateEmployee wrapper entirely (e.g. from browser devtools). This trigger closes that gap
-- at the one place no RLS policy can reach: per-column enforcement within a single UPDATE.
--
-- Audited role list used below (confirmed from the live schema, not assumed):
--   - users_role_check (20260928100000_canonical_schema_v4.sql) currently permits 16 values:
--     executive, head_of_technical, sales, am_team_lead, am_agent, media_buying_team_lead,
--     media_buying_agent, seo_team_lead, seo_agent, programming_agent, social_media_team_lead,
--     social_media_agent, graphic_designer, video_editor, ai_engineer, marketing_manager.
--   - src/types/database.ts's UserRole union additionally includes seo_content_agent and
--     seo_backlink_agent (18 values total) — used throughout the frontend (roles.ts,
--     CapacityManagement.tsx) as full SEO department members, but users_role_check was never
--     widened to admit them. Two separate, pre-existing bugs, NOT fixed by this migration:
--       1. A user cannot actually be inserted/updated to role = 'seo_content_agent' or
--          'seo_backlink_agent' today — Postgres rejects it at the check constraint.
--       2. employee_visible() (20261019000000_ai_engineer_full_application_authorization.sql)
--          grants seo_team_lead visibility into 'seo_agent'/'programming_agent' only — it does not
--          list seo_content_agent/seo_backlink_agent, so even once bug 1 is fixed, a seo_team_lead
--          still wouldn't be able to see those rows without a separate employee_visible() change.
--   This trigger's seo_team_lead agent-set below is written to be correct once both of those are
--   fixed (it lists all four SEO agent-level roles), rather than silently reinforcing bug 1/2 by
--   only allowing what happens to work today.
--
-- Department team-lead -> agent-level-role mapping used below, cross-checked against
-- src/data/roles.ts's TEAM_LEAD_TO_AGENT_ROLE (the frontend's own "single source of truth" for
-- this), employee_visible(), and this request's explicit instruction:
--   am_team_lead            -> am_agent
--   media_buying_team_lead  -> media_buying_agent
--   seo_team_lead           -> seo_agent, programming_agent, seo_content_agent, seo_backlink_agent
--   social_media_team_lead  -> social_media_agent
-- (Note TEAM_LEAD_TO_AGENT_ROLE itself omits programming_agent from seo_team_lead's set, while
-- employee_visible() includes it — an existing inconsistency between the two, not resolved here;
-- this trigger follows the explicit instruction for this migration, which includes it.)
-- executive/head_of_technical/sales/ai_engineer/graphic_designer/video_editor/marketing_manager
-- have no team-lead-held agent-level set of their own (sales/graphic_designer/video_editor have no
-- dedicated lead at all; executive/head_of_technical/ai_engineer sit above every team lead) — a
-- team lead can never move anyone into or out of these roles under rule 4 below.
begin;

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

  -- Rule 1: id, auth_id, password are immutable through this path, for every authenticated caller,
  -- with no exception — including the 7 roles the RLS policies would otherwise let touch this row.
  -- auth_id is exclusively the two service-role Edge Function paths' to set (employee-invitation,
  -- employee-test-account), both already write-once-guarded there; id and password must never
  -- change via an application UPDATE at all.
  if new.id is distinct from old.id then
    raise exception 'id cannot be changed.';
  end if;
  if new.auth_id is distinct from old.auth_id then
    raise exception 'auth_id cannot be changed here — it is only ever set once, by the employee invitation/test-account setup process.';
  end if;
  if new.password is distinct from old.password then
    raise exception 'password cannot be changed here.';
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

-- No one needs direct EXECUTE on this function — it is only ever invoked by the trigger mechanism
-- below (controlled by TRIGGER privilege on the table, not EXECUTE on the function, for the role
-- performing the UPDATE), and SECURITY DEFINER means it runs with its owner's rights regardless.
-- Revoking from PUBLIC (which anon/authenticated otherwise inherit by Postgres's default) removes
-- any ability to call it directly as an RPC; nothing needs it granted back, including service_role
-- (the early auth.role() return already makes it a no-op for that context, with or without
-- EXECUTE).
revoke execute on function public.users_update_guard() from public;

drop trigger if exists users_update_guard_trigger on public.users;
create trigger users_update_guard_trigger
before update on public.users
for each row
execute function public.users_update_guard();

commit;
