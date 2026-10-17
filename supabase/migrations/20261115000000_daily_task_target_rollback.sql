-- ROLLBACK for 20261115000000_daily_task_target.sql.
--
-- Drops the policy and column, and restores users_update_guard() to its exact pre-this-migration
-- body — removes Rule 5 only. That body is the LIVE production definition
-- (pg_get_functiondef('public.users_update_guard'::regproc)), not
-- 20261030000000_users_update_guard_trigger.sql in this repo, which had drifted from production
-- (see 20261115000000_daily_task_target.sql's own header for the exact differences: no password
-- check live, and seo_dept_roles/the SEO error message include store_manager live).
begin;

drop policy if exists "users_update_daily_task_target_rls" on public.users;

alter table public.users drop constraint if exists users_daily_task_target_check;
alter table public.users drop column if exists daily_task_target;

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

  return new;
end;
$$;

commit;
