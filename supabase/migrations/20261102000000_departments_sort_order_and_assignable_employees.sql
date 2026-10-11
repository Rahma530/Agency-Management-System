-- PR 5 (frontend: table-driven OPERATIONAL_TEAMS/COMBINED_DEPARTMENT_TEAMS) companion migration.
-- Four independent changes, all additive — no existing column, policy, grant, or trigger is
-- touched except assignable_employees()'s own CASE expression (see section 4):
--
--   1. departments.sort_order / department_member_teams.sort_order — lets the frontend
--      (data/customRoles.ts, departmentStaffing.ts) derive OPERATIONAL_TEAMS/
--      COMBINED_DEPARTMENT_TEAMS from these tables in today's exact order instead of a hardcoded
--      array. Backfilled below to the exact order departmentStaffing.ts's OPERATIONAL_TEAMS
--      constant already held, using the live department_member_teams rows confirmed before
--      writing this migration (no duplicate team_value rows exist).
--   2. department_member_teams: add unique (team_value) — assignable_employees()'s replacement
--      CASE (section 4) looks up a department by team_value via a subquery that assumes at most
--      one department per team_value; this constraint makes that assumption structurally
--      guaranteed rather than merely true today by coincidence. Verified safe to add (no existing
--      duplicates) before writing this migration.
--   3. departments: add a CHECK on id's shape, mirroring custom_roles_id_shape_check exactly
--      (20261101400000_custom_roles_departments_foundation.sql) — the 7 seeded ids already match.
--   4. assignable_employees(p_department): replaces ONLY the hardcoded
--      `case p_department when 'Creative & Design' then array[...] else array[p_department] end`
--      with a department_member_teams lookup, so a department created later through the (not yet
--      built) admin UI works here without a further migration. Every other line — signature,
--      language, STABLE, SECURITY DEFINER, search_path, and every filter in the WHERE clause — is
--      unchanged from the live function body. `create or replace` preserves existing grants.
begin;

-- ----------------------------------------------------------------------------
-- 1. sort_order columns
-- ----------------------------------------------------------------------------
alter table public.departments add column if not exists sort_order integer not null default 0;
alter table public.department_member_teams add column if not exists sort_order integer not null default 0;

-- Backfill to departmentStaffing.ts's current OPERATIONAL_TEAMS order exactly:
--   SEO, Social Media, Media Buying, Creative & Design, Video Production, Programming,
--   Account Management, AI Engineering.
-- Department-level sort_order is each department's first appearance in that sequence.
update public.departments set sort_order = 0 where id = 'seo';
update public.departments set sort_order = 1 where id = 'social_media';
update public.departments set sort_order = 2 where id = 'media_buying';
update public.departments set sort_order = 3 where id = 'creative_design';
update public.departments set sort_order = 4 where id = 'programming';
update public.departments set sort_order = 5 where id = 'account_management';
update public.departments set sort_order = 6 where id = 'ai_engineering';

-- department_member_teams-level sort_order: 0 for every department's only team value, except
-- creative_design's two rows, ordered so 'Creative & Design' precedes 'Video Production' —
-- matching the flat OPERATIONAL_TEAMS sequence exactly.
update public.department_member_teams set sort_order = 0 where department_id = 'seo' and team_value = 'SEO';
update public.department_member_teams set sort_order = 0 where department_id = 'social_media' and team_value = 'Social Media';
update public.department_member_teams set sort_order = 0 where department_id = 'media_buying' and team_value = 'Media Buying';
update public.department_member_teams set sort_order = 0 where department_id = 'creative_design' and team_value = 'Creative & Design';
update public.department_member_teams set sort_order = 1 where department_id = 'creative_design' and team_value = 'Video Production';
update public.department_member_teams set sort_order = 0 where department_id = 'programming' and team_value = 'Programming';
update public.department_member_teams set sort_order = 0 where department_id = 'account_management' and team_value = 'Account Management';
update public.department_member_teams set sort_order = 0 where department_id = 'ai_engineering' and team_value = 'AI Engineering';

-- ----------------------------------------------------------------------------
-- 2. department_member_teams: team_value must be unique across departments — confirmed safe
--    (no existing duplicates) before writing this migration. Required so
--    assignable_employees()'s replacement lookup below (department by team_value) is
--    structurally unambiguous, not merely true today by coincidence.
-- ----------------------------------------------------------------------------
alter table public.department_member_teams add constraint department_member_teams_team_value_unique unique (team_value);

-- ----------------------------------------------------------------------------
-- 3. departments: id shape — mirrors custom_roles_id_shape_check exactly
--    (20261101400000_custom_roles_departments_foundation.sql). The 7 seeded ids already match.
-- ----------------------------------------------------------------------------
alter table public.departments add constraint departments_id_shape_check check (id ~ '^[a-z][a-z0-9_]{2,40}$');

-- ----------------------------------------------------------------------------
-- 4. assignable_employees(): only the CASE expression changes. Every other line is copied
--    verbatim from the live function body. A team_value with no department_member_teams row at
--    all (e.g. 'Marketing', 'Technical' — never seeded there, matching departmentStaffing.ts's
--    own FALLBACK_OPERATIONAL_TEAMS comment that those two were deliberately never real
--    departments) falls through the inner subquery to NULL, and coalesce() restores exactly
--    today's `else array[p_department]` behavior for it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assignable_employees(p_department text)
 RETURNS TABLE(id text, name text, role text, team text, capacity_limit integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select u.id, u.name, u.role, u.team, u.capacity_limit
  from public.users u
  where u.auth_id is not null
    and u.deactivated_at is null
    and u.role <> 'sales'
    and (
      u.role not in ('executive', 'head_of_technical')
      or (u.role = 'head_of_technical' and public.app_user_role() = 'executive')
    )
    and u.team = any(
      coalesce(
        (
          select array_agg(m.team_value)
          from public.department_member_teams m
          where m.department_id = (
            select m2.department_id
            from public.department_member_teams m2
            where m2.team_value = p_department
            limit 1
          )
        ),
        array[p_department]
      )
    );
$function$;

commit;
