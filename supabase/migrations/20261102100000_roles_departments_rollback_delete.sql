-- Adds the missing DELETE grant + policy on public.departments and public.custom_roles, needed
-- only so rolesAndDepartmentsAdmin.ts's rollback-on-failure path can clean up a parent row it just
-- inserted (with is_active = false) when a later step in the same create fails. This is NOT a
-- general-purpose delete capability: the DELETE policy below only ever matches is_active = false
-- rows, so an active department or custom role can never be deleted through RLS, only retired
-- (is_active = false) and then, if literally nothing else referenced it yet, cleaned up.
--
-- Root cause: 20261101400000_custom_roles_departments_foundation.sql deliberately gave departments
-- and custom_roles SELECT/INSERT/UPDATE only ("retiring ... sets is_active = false instead, so any
-- custom role or data still referencing it keeps a valid reference"). That's correct for the
-- steady state, but the admin UI's create flow inserts the parent row with is_active = false FIRST,
-- then inserts child rows, then flips is_active = true last (see PR 6's write-path design). If a
-- child insert fails, the code tries to delete the still-inactive, not-yet-referenced parent row it
-- just created. Without this migration that delete is a silent zero-rows no-op (RLS/grant blocks
-- it, no error raised), so the row survives as a permanently inactive orphan, and the unique
-- constraint on departments.label / custom_roles.portal_slug then blocks the admin from retrying
-- with the same name.
--
-- The 3 child tables this same rollback path deletes from (department_member_teams,
-- custom_role_modules, custom_role_permissions) already have full DELETE support from the
-- foundation migration (`for all` policy + `grant ... delete` to authenticated, exec/HOT only) —
-- verified by inspection below, nothing to add for them:
--   department_member_teams_write_rls  (for all)      + grant ... delete  — lines ~111-117
--   custom_role_modules_write_rls      (for all)      + grant ... delete  — lines ~226-232
--   custom_role_permissions_write_rls  (for all)      + grant ... delete  — lines ~281-287
-- (custom_role_permissions also has the grantable-permission guard trigger from section 8 of that
-- migration, which only fires on insert/update, so it's irrelevant to delete.)
--
-- Idempotent: safe to run multiple times (drop policy if exists; grant is naturally idempotent).
begin;

-- ----------------------------------------------------------------------------
-- 1. departments — allow deleting only an inactive (is_active = false) row, and only as
--    executive/head_of_technical. An active department can never be deleted, only retired.
-- ----------------------------------------------------------------------------
grant delete on public.departments to authenticated;

drop policy if exists "departments_delete_inactive_rls" on public.departments;
create policy "departments_delete_inactive_rls" on public.departments
for delete to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  and is_active = false
);

-- ----------------------------------------------------------------------------
-- 2. custom_roles — same shape: delete only permitted on an inactive row, exec/HOT only.
-- ----------------------------------------------------------------------------
grant delete on public.custom_roles to authenticated;

drop policy if exists "custom_roles_delete_inactive_rls" on public.custom_roles;
create policy "custom_roles_delete_inactive_rls" on public.custom_roles
for delete to authenticated
using (
  public.app_user_role() in ('executive', 'head_of_technical')
  and is_active = false
);

commit;

-- ----------------------------------------------------------------------------
-- Verification (run manually against a staging/dev project — NOT part of this migration, nothing
-- below is executed automatically):
--
-- As an executive or head_of_technical (i.e. with app_user_role() returning one of those):
--
--   -- (a) An inactive row the caller just inserted can be deleted:
--   insert into public.departments (id, label, is_active) values ('zz_test', 'ZZ Test', false);
--   delete from public.departments where id = 'zz_test';         -- expect: 1 row deleted
--
--   -- (b) An ACTIVE row must NOT be deletable, even as executive/head_of_technical:
--   insert into public.departments (id, label, is_active) values ('zz_test2', 'ZZ Test 2', true);
--   delete from public.departments where id = 'zz_test2';        -- expect: 0 rows deleted
--   delete from public.departments where id = 'zz_test2' and is_active = false; -- same, explicit
--   update public.departments set is_active = false where id = 'zz_test2';
--   delete from public.departments where id = 'zz_test2';        -- now expect: 1 row deleted
--
--   -- (c) Same two checks against custom_roles (needs a department_id that exists, e.g. 'seo'):
--   insert into public.custom_roles
--     (id, english_title, portal_title_en, portal_slug, department_id, is_active)
--     values ('zz_test_role', 'ZZ Test Role', 'ZZ Test Role', 'zz-test-role', 'seo', false);
--   delete from public.custom_roles where id = 'zz_test_role';   -- expect: 1 row deleted
--
-- As any other role (e.g. a seo_agent or any built-in non-exec/HOT role, or a custom role):
--
--   -- (d) Delete must be rejected outright regardless of is_active:
--   delete from public.departments where id = 'seo';             -- expect: 0 rows deleted
--   delete from public.custom_roles where is_active = false;     -- expect: 0 rows deleted
--
-- Also re-run scripts/checkCustomRolesAndCapabilities.ts's rollback tests (fake client) — they
-- don't hit a real database, but they encode the same "rollback delete must be checked for
-- error-or-zero-rows" contract that this migration makes true against a real Supabase project.
-- ----------------------------------------------------------------------------
