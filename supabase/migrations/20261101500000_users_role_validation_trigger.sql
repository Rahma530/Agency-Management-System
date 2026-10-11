-- Replaces the static users_role_check CHECK constraint with a trigger-based validator, so an
-- admin-created custom role (public.custom_roles, from 20261101400000_custom_roles_departments_
-- foundation.sql) can be stored in users.role without a migration, while any string that is
-- neither a built-in role nor an active custom role is still rejected.
--
-- A CHECK constraint can't do this on its own — it can't subquery another table — hence the move
-- to a BEFORE INSERT OR UPDATE OF role trigger, which can look up public.custom_roles.
--
-- Built-in role behavior is otherwise unchanged: the 19 UserRole values are still always valid,
-- listed literally below exactly as users_role_check (latest: 20261101300000_sync_role_check_
-- and_employee_visible.sql) enumerated them.
--
-- users_update_guard() (20261030400000_drop_users_password.sql, trigger attached in
-- 20261030000000_users_update_guard_trigger.sql) is NOT changed by this migration — verified
-- against the live DB first:
--   - Its role-change branch for executive/head_of_technical/ai_engineer is already an
--     unconditional `null;` (allow) — unaffected by which role string is being set.
--   - Team leads are already restricted to their own department's agent-level roles via that
--     trigger's own hardcoded seo_dept_roles array / per-role elsif branches — a custom role is
--     not in any of those sets, so a team lead still cannot set a custom role on anyone, exactly
--     as before.
--   - No custom role has any UPDATE or INSERT policy on public.users at all (users_update_profile/
--     capacity/deactivate_rls and users_insert_admin_rls remain closed, hardcoded role lists with
--     no custom-role branch) — so a custom role can never reach users_update_guard() as the
--     caller in the first place. There is nothing for that trigger to additionally validate here.
--
-- Also checked: no file outside supabase/migrations/ references the name users_role_check — this
-- migration only needs to coordinate with other migrations, not with any frontend/scripts code.
begin;

-- ----------------------------------------------------------------------------
-- 1. Drop the static CHECK constraint this trigger replaces.
-- ----------------------------------------------------------------------------
alter table public.users drop constraint if exists users_role_check;

-- ----------------------------------------------------------------------------
-- 2. Trigger function: valid if new.role is one of the 19 built-in roles, OR an active row in
--    public.custom_roles — otherwise rejects the insert/update outright.
-- ----------------------------------------------------------------------------
create or replace function public.users_role_valid_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  -- Only validate on insert or a real role change — an UPDATE that doesn't touch role (the common
  -- case) should never re-check a value that was already valid when it was first set.
  if tg_op = 'UPDATE' and new.role is not distinct from old.role then
    return new;
  end if;

  if new.role = any (array[
    'executive', 'head_of_technical', 'sales', 'am_team_lead', 'am_agent',
    'media_buying_team_lead', 'media_buying_agent', 'seo_team_lead', 'seo_agent',
    'seo_content_agent', 'seo_backlink_agent', 'store_manager', 'programming_agent',
    'social_media_team_lead', 'social_media_agent', 'graphic_designer', 'video_editor',
    'ai_engineer', 'marketing_manager'
  ]) then
    return new;
  end if;

  if exists (select 1 from public.custom_roles cr where cr.id = new.role and cr.is_active) then
    return new;
  end if;

  raise exception 'Role "%" is not a valid role.', new.role;
end;
$$;

revoke execute on function public.users_role_valid_guard() from public;

-- ----------------------------------------------------------------------------
-- 3. Attach the trigger. `of role` means it only fires on an INSERT, or an UPDATE that touches
--    the role column — matching exactly what users_role_check itself ever validated.
-- ----------------------------------------------------------------------------
drop trigger if exists users_role_valid_guard_trigger on public.users;
create trigger users_role_valid_guard_trigger
before insert or update of role on public.users
for each row
execute function public.users_role_valid_guard();

commit;
