/**
 * Runtime/unit-style check (unlike the static JSX-prop scans this file sits alongside) for the
 * custom-roles cache (src/data/customRoles.ts), its consumption in getRoleInfo() (src/data/
 * roles.ts), and the can() capability helper (src/lib/capabilities.ts). It actually registers
 * fabricated department/custom-role/permission rows via registerCustomRoleData() and asserts on
 * the real return values — a text scan can't catch a logic regression here the way it can for a
 * missing JSX prop.
 *
 * Covers:
 *   - getRoleInfo() for: a built-in role, an active custom role, an inactive custom role, and an
 *     unknown role string.
 *   - can() for: executive (always true), a built-in role with no entry in
 *     BUILT_IN_CAPABILITY_GRANTS (false), a custom role granted via its department default, a
 *     custom role with no grant, and every admin-only key — passed via a type-bypassing cast, the
 *     same way a real bug would reach it — which must never be grantable for any caller.
 *
 * Run via `npm run lint` (chained after tsc --noEmit) or directly: `npx tsx
 * scripts/checkCustomRolesAndCapabilities.ts`.
 */
import {
  registerCustomRoleData,
  resetCustomRoleDataForTesting,
} from '../src/data/customRoles';
import { getRoleInfo, isBuiltInRole } from '../src/data/roles';
import { can, CapabilityKey } from '../src/lib/capabilities';

const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  assertEqual(value, true, label);
}

function assertFalse(value: boolean, label: string): void {
  assertEqual(value, false, label);
}

// --- Fixtures -------------------------------------------------------------------------------

const DEPT_SEO = { id: 'seo', label: 'SEO', is_shared_resource: false, is_active: true };
const DEPT_CREATIVE = { id: 'creative_design', label: 'Creative & Design', is_shared_resource: true, is_active: true };

const ACTIVE_CUSTOM_ROLE = {
  id: 'seo_outreach_specialist',
  english_title: 'SEO Outreach Specialist',
  portal_title_en: 'SEO Outreach Portal',
  portal_slug: 'seo-outreach',
  team: 'SEO',
  department_id: DEPT_SEO.id,
  default_module: 'my_work',
  is_active: true,
};

const INACTIVE_CUSTOM_ROLE = {
  id: 'retired_role',
  english_title: 'Retired Role',
  portal_title_en: 'Retired Portal',
  portal_slug: 'retired',
  department_id: DEPT_SEO.id,
  default_module: 'my_work',
  is_active: false,
};

function setUpFixtures(): void {
  registerCustomRoleData(
    [DEPT_SEO, DEPT_CREATIVE],
    [ACTIVE_CUSTOM_ROLE, INACTIVE_CUSTOM_ROLE],
    [{ role_id: ACTIVE_CUSTOM_ROLE.id, module_id: 'my_work' }],
    [],
    [{ department_id: DEPT_SEO.id, permission_key: 'tasks.view_cross_team' }]
  );
}

// --- getRoleInfo() ----------------------------------------------------------------------------

function testGetRoleInfo(): void {
  resetCustomRoleDataForTesting();
  setUpFixtures();

  assertTrue(isBuiltInRole('executive'), 'isBuiltInRole("executive")');
  assertEqual(getRoleInfo('executive').englishTitle, 'Executive Management (C-Level)', 'getRoleInfo(built-in role)');

  const activeInfo = getRoleInfo(ACTIVE_CUSTOM_ROLE.id);
  assertEqual(activeInfo.englishTitle, ACTIVE_CUSTOM_ROLE.english_title, 'getRoleInfo(active custom role).englishTitle');
  assertTrue(activeInfo.allowedModules.includes('my_work'), 'getRoleInfo(active custom role).allowedModules includes my_work');

  const inactiveInfo = getRoleInfo(INACTIVE_CUSTOM_ROLE.id);
  assertEqual(inactiveInfo.portalSlug, 'unconfigured', 'getRoleInfo(inactive custom role) falls back to unconfigured');
  assertEqual(inactiveInfo.allowedModules.length, 0, 'getRoleInfo(inactive custom role).allowedModules is empty');

  const unknownInfo = getRoleInfo('this_role_does_not_exist');
  assertEqual(unknownInfo.portalSlug, 'unconfigured', 'getRoleInfo(unknown role) falls back to unconfigured');
  assertEqual(unknownInfo.allowedModules.length, 0, 'getRoleInfo(unknown role).allowedModules is empty');
}

// --- can() --------------------------------------------------------------------------------------

function testCan(): void {
  resetCustomRoleDataForTesting();
  setUpFixtures();

  assertTrue(can({ role: 'executive' }, 'tasks.view_cross_team'), 'can(executive, any capability) is always true');
  assertTrue(can({ role: 'head_of_technical' }, 'employees.view_department_peers'), 'can(head_of_technical, any capability) is always true');

  // A built-in role with no entry in BUILT_IN_CAPABILITY_GRANTS never gets a capability through
  // can() — built-in roles get their access from their own existing hardcoded checks instead.
  assertFalse(can({ role: 'sales' }, 'tasks.view_cross_team'), 'can(built-in role with no grant) is false');

  // The active custom role's department (seo) defaults tasks.view_cross_team to granted.
  assertTrue(
    can({ role: ACTIVE_CUSTOM_ROLE.id }, 'tasks.view_cross_team'),
    'can(custom role, department-granted capability) is true'
  );
  // The same role was never granted employees.view_department_peers (no override, not a
  // department default either).
  assertFalse(
    can({ role: ACTIVE_CUSTOM_ROLE.id }, 'employees.view_department_peers'),
    'can(custom role, ungranted capability) is false'
  );

  // An inactive custom role is indistinguishable from an unknown role to can() — it must never
  // inherit its old department's grants once deactivated.
  assertFalse(
    can({ role: INACTIVE_CUSTOM_ROLE.id }, 'tasks.view_cross_team'),
    'can(inactive custom role) is false even though its department grants this to active roles'
  );

  // Admin keys must never be grantable, for any caller, even via a cast that bypasses
  // CapabilityKey's type-level exclusion — the same way a real bug would reach this function.
  const adminKeys = [
    'users.manage',
    'users.create',
    'users.manage_role_team_department',
    'admin.impersonation',
    'admin.roles_departments',
  ] as unknown as CapabilityKey[];
  for (const key of adminKeys) {
    assertFalse(can({ role: 'executive' }, key), `can(executive, ${key}) is never grantable`);
    assertFalse(can({ role: ACTIVE_CUSTOM_ROLE.id }, key), `can(custom role, ${key}) is never grantable`);
  }
}

// --- Fail-closed-before-load sanity check ------------------------------------------------------

function testFailClosedBeforeLoad(): void {
  resetCustomRoleDataForTesting();

  assertEqual(getRoleInfo(ACTIVE_CUSTOM_ROLE.id).portalSlug, 'unconfigured', 'getRoleInfo before any registerCustomRoleData() call fails closed');
  assertFalse(can({ role: ACTIVE_CUSTOM_ROLE.id }, 'tasks.view_cross_team'), 'can() before any registerCustomRoleData() call fails closed');
}

function main(): void {
  testGetRoleInfo();
  testCan();
  testFailClosedBeforeLoad();
  resetCustomRoleDataForTesting();

  if (failures.length > 0) {
    console.error('Found custom-roles/capabilities regression(s):\n');
    for (const f of failures) {
      console.error(`  ${f}`);
    }
    process.exit(1);
  }

  console.log('OK: getRoleInfo()/can() behave correctly for built-in, active custom, inactive custom, and unknown roles.');
}

main();
