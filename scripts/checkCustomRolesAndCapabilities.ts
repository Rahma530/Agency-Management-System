/**
 * Runtime/unit-style check (unlike the static JSX-prop scans this file sits alongside) for the
 * custom-roles cache (src/data/customRoles.ts) and everything that reads it: getRoleInfo() and
 * isBuiltInRole() (src/data/roles.ts), the can() capability helper (src/lib/capabilities.ts),
 * resolveClientsForSubject()/serviceFilterForRole() (src/lib/reportingEngine.ts), and
 * isEmployeeAccessibleUnderRLS()/getAllowedEmployeeRolesUnderRLS() (src/lib/supabase.ts). It
 * actually registers fabricated department/custom-role/permission rows via
 * registerCustomRoleData() and asserts on the real return values — a text scan can't catch a
 * logic regression here the way it can for a missing JSX prop.
 *
 * Covers:
 *   - getRoleInfo() for: a built-in role, an active custom role, an inactive custom role, and an
 *     unknown role string.
 *   - can() for: executive (always true), a built-in role with no entry in
 *     BUILT_IN_CAPABILITY_GRANTS (false), a custom role granted via its department default, a
 *     custom role with no grant, and every admin-only key — passed via a type-bypassing cast, the
 *     same way a real bug would reach it — which must never be grantable for any caller.
 *   - resolveClientsForSubject()/serviceFilterForRole() for: a custom role in a department mapped
 *     to a real ServiceType (seo), narrowed to clients actually assigned to that user; a custom
 *     role in a department with no mapped ServiceType (creative_design); an inactive custom role;
 *     and a built-in sample (seo_agent), confirming its pre-existing agent-level filter is
 *     unchanged.
 *   - isEmployeeAccessibleUnderRLS()/getAllowedEmployeeRolesUnderRLS() for: a custom viewer with
 *     and without employees.view_department_peers granted; a shared-resource custom role target
 *     visible to a non-sales viewer and hidden from a sales viewer; a custom viewer looking at a
 *     built-in-role target; a viewer's own row (self); and a regression sample of 4 built-in
 *     roles (graphic_designer, seo_team_lead, sales, am_agent) against both functions, to confirm
 *     this PR left their results unchanged.
 *   - PR 6 (lib/rolesAndDepartmentsAdmin.ts, the roles/departments admin UI's write paths):
 *     slugifyToId()/generateUniqueId()/slugifyPortalSlug()/generateUniquePortalSlug() (shape
 *     regex compliance, collision suffixes, an overlong label truncated to a still-valid id);
 *     getNextDepartmentSortOrder() (missing sort_order tolerated, an inactive department's
 *     sort_order still counted); checkCanDeactivateDepartment()/countActiveEmployeesHoldingRole()
 *     (a seeded department always blocked, a non-seeded one blocked only while it has active
 *     roles/employees and allowed once it has none); and the rollback-on-failure path of
 *     createDepartment()/createCustomRole(), exercised against an injected fake DB client (no
 *     real network call) that fails one specific insert/update step at a time.
 *
 * Run via `npm run lint` (chained after tsc --noEmit) or directly: `npx tsx
 * scripts/checkCustomRolesAndCapabilities.ts`.
 */
import {
  registerCustomRoleData,
  resetCustomRoleDataForTesting,
  getCombinedTeamValuesFromCache,
  getNextDepartmentSortOrder,
} from '../src/data/customRoles';
import { getRoleInfo, isBuiltInRole } from '../src/data/roles';
import { can, CapabilityKey } from '../src/lib/capabilities';
import { resolveClientsForSubject, serviceFilterForRole } from '../src/lib/reportingEngine';
import { isEmployeeAccessibleUnderRLS, getAllowedEmployeeRolesUnderRLS } from '../src/lib/supabase';
import { getCombinedDepartmentTeams, getEmployeesByDepartment, getOperationalTeams } from '../src/lib/departmentStaffing';
import {
  SEEDED_DEPARTMENT_IDS,
  slugifyToId,
  generateUniqueId,
  slugifyPortalSlug,
  generateUniquePortalSlug,
  isValidGeneratedId,
  checkCanDeactivateDepartment,
  countActiveEmployeesHoldingRole,
  createDepartment,
  createCustomRole,
  normalizeAllowedModules,
  findReservedTeamValue,
} from '../src/lib/rolesAndDepartmentsAdmin';
import { AssignmentRecord, ClientRecord, DepartmentMemberTeamRecord, DepartmentRecord, UserRecord } from '../src/types/database';

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

function assertSameMembers(actual: string[], expected: string[], label: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length !== e.length || a.some((v, i) => v !== e[i])) {
    failures.push(`${label}: expected members ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  }
}

// --- Fixtures -------------------------------------------------------------------------------

const DEPT_SEO = { id: 'seo', label: 'SEO', is_shared_resource: false, is_active: true, sort_order: 0 };
const DEPT_CREATIVE = { id: 'creative_design', label: 'Creative & Design', is_shared_resource: true, is_active: true, sort_order: 1 };

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

// A second active role in the same department as ACTIVE_CUSTOM_ROLE, with no permission override
// of its own — lets department-peers tests compare a role that has employees.view_department_peers
// (via an override) against one that doesn't (department default alone doesn't grant it either).
const SEO_PEER_ROLE = {
  id: 'seo_peer_specialist',
  english_title: 'SEO Peer Specialist',
  portal_title_en: 'SEO Peer Portal',
  portal_slug: 'seo-peer',
  department_id: DEPT_SEO.id,
  default_module: 'my_work',
  is_active: true,
};

// Active role in the shared-resource Creative & Design department — has no department-mapped
// ServiceType (unlike seo/media_buying/social_media), and is the shared-resource visibility case.
const CREATIVE_ROLE = {
  id: 'creative_coordinator',
  english_title: 'Creative Coordinator',
  portal_title_en: 'Creative Portal',
  portal_slug: 'creative-coordinator',
  department_id: DEPT_CREATIVE.id,
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
    [ACTIVE_CUSTOM_ROLE, SEO_PEER_ROLE, CREATIVE_ROLE, INACTIVE_CUSTOM_ROLE],
    [{ role_id: ACTIVE_CUSTOM_ROLE.id, module_id: 'my_work' }],
    // Per-role override: only ACTIVE_CUSTOM_ROLE (not SEO_PEER_ROLE) is granted
    // employees.view_department_peers — the department default below does not grant it, so
    // SEO_PEER_ROLE has no path to it at all.
    [{ role_id: ACTIVE_CUSTOM_ROLE.id, permission_key: 'employees.view_department_peers', granted: true }],
    [{ department_id: DEPT_SEO.id, permission_key: 'tasks.view_cross_team' }],
    // department_member_teams: irrelevant to the role/capability tests below, left empty —
    // testOperationalTeams() registers its own dedicated department_member_teams fixture.
    []
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
  // The same role was never granted employees.view_department_peers via the department default —
  // it only has it through its own override (asserted separately below).
  assertTrue(
    can({ role: ACTIVE_CUSTOM_ROLE.id }, 'employees.view_department_peers'),
    'can(custom role, capability granted via per-role override) is true'
  );
  // SEO_PEER_ROLE has neither an override nor a department default for this capability.
  assertFalse(
    can({ role: SEO_PEER_ROLE.id }, 'employees.view_department_peers'),
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

// --- resolveClientsForSubject() / serviceFilterForRole() ----------------------------------------

function testReportingEngine(): void {
  resetCustomRoleDataForTesting();
  setUpFixtures();

  const seoClientAssigned = { id: 'client-seo-assigned', services: ['seo'] } as unknown as ClientRecord;
  const seoClientNotAssigned = { id: 'client-seo-not-assigned', services: ['seo'] } as unknown as ClientRecord;
  const creativeClient = { id: 'client-creative', services: ['creation'] } as unknown as ClientRecord;
  const clients = [seoClientAssigned, seoClientNotAssigned, creativeClient];

  const agentId = 'agent-1';
  const assignments = [
    { id: 'a1', client_id: seoClientAssigned.id, service_type: 'seo', team_lead_id: 'tl', agent_id: agentId, assigned_at: '2026-01-01' },
  ] as unknown as AssignmentRecord[];

  // Custom role in the seo department (mapped ServiceType): narrowed to clients assigned to this
  // specific user, exactly like a built-in seo_agent — not every seo client in the pool.
  const seoCustomSubject = { id: agentId, role: ACTIVE_CUSTOM_ROLE.id };
  assertSameMembers(
    resolveClientsForSubject(seoCustomSubject, clients, assignments).map((c) => c.id),
    [seoClientAssigned.id],
    'resolveClientsForSubject(custom role in seo dept) only returns clients assigned to this user'
  );
  assertSameMembers(
    serviceFilterForRole(ACTIVE_CUSTOM_ROLE.id) || [],
    ['seo'],
    'serviceFilterForRole(custom role in seo dept) is ["seo"]'
  );

  // Custom role in the creative_design department: no department-mapped ServiceType, so no
  // report-able client pool at all, by design — not a guess.
  const creativeCustomSubject = { id: agentId, role: CREATIVE_ROLE.id };
  assertSameMembers(
    resolveClientsForSubject(creativeCustomSubject, clients, assignments).map((c) => c.id),
    [],
    'resolveClientsForSubject(custom role in creative_design dept, no mapped service) is []'
  );
  assertSameMembers(
    serviceFilterForRole(CREATIVE_ROLE.id) || [],
    [],
    'serviceFilterForRole(custom role in creative_design dept) is [] (matches nothing), not undefined'
  );
  assertTrue(serviceFilterForRole(CREATIVE_ROLE.id) !== undefined, 'serviceFilterForRole(custom role with no mapped service) is never undefined');

  // Inactive custom role: fails closed exactly like an unknown role — no department resolves.
  const inactiveSubject = { id: agentId, role: INACTIVE_CUSTOM_ROLE.id };
  assertSameMembers(
    resolveClientsForSubject(inactiveSubject, clients, assignments).map((c) => c.id),
    [],
    'resolveClientsForSubject(inactive custom role) is []'
  );
  assertSameMembers(serviceFilterForRole(INACTIVE_CUSTOM_ROLE.id) || [], [], 'serviceFilterForRole(inactive custom role) is []');

  // Built-in regression sample: seo_agent's own pre-existing agent-level filter is unaffected by
  // this PR's custom-role branch.
  const builtInSubject = { id: agentId, role: 'seo_agent' as const };
  assertSameMembers(
    resolveClientsForSubject(builtInSubject, clients, assignments).map((c) => c.id),
    [seoClientAssigned.id],
    'resolveClientsForSubject(seo_agent) regression: unchanged agent-level filter'
  );
  assertSameMembers(serviceFilterForRole('seo_agent') || [], ['seo'], 'serviceFilterForRole(seo_agent) regression: unchanged');
}

// --- isEmployeeAccessibleUnderRLS() / getAllowedEmployeeRolesUnderRLS() -------------------------

function employee(id: string, role: string): UserRecord {
  return { id, role } as unknown as UserRecord;
}

function testEmployeeVisibility(): void {
  resetCustomRoleDataForTesting();
  setUpFixtures();

  // Self: always visible, even with no permission at all and before any other branch runs.
  const self = employee('same-id', ACTIVE_CUSTOM_ROLE.id);
  assertTrue(isEmployeeAccessibleUnderRLS(self, self), 'isEmployeeAccessibleUnderRLS: a custom-role viewer always sees their own row');

  // Department peers: granted (via override) vs. not granted, same department both times.
  const peerViewerWithGrant = employee('v1', ACTIVE_CUSTOM_ROLE.id);
  const peerTargetNoGrant = employee('t1', SEO_PEER_ROLE.id);
  assertTrue(
    isEmployeeAccessibleUnderRLS(peerViewerWithGrant, peerTargetNoGrant),
    'isEmployeeAccessibleUnderRLS: custom viewer WITH employees.view_department_peers sees a same-department peer'
  );

  const peerViewerNoGrant = employee('v2', SEO_PEER_ROLE.id);
  const peerTargetWithGrant = employee('t2', ACTIVE_CUSTOM_ROLE.id);
  assertFalse(
    isEmployeeAccessibleUnderRLS(peerViewerNoGrant, peerTargetWithGrant),
    'isEmployeeAccessibleUnderRLS: custom viewer WITHOUT employees.view_department_peers does not see a same-department peer'
  );

  // Shared-resource custom role target: visible to any non-sales viewer, hidden from sales.
  const creativeTarget = employee('t3', CREATIVE_ROLE.id);
  assertTrue(
    isEmployeeAccessibleUnderRLS(employee('v3', 'am_agent'), creativeTarget),
    'isEmployeeAccessibleUnderRLS: shared-resource custom role visible to a non-sales built-in viewer'
  );
  assertFalse(
    isEmployeeAccessibleUnderRLS(employee('v4', 'sales'), creativeTarget),
    'isEmployeeAccessibleUnderRLS: shared-resource custom role hidden from sales'
  );

  // Custom viewer vs. a built-in-role target that is not a shared resource: no path grants this.
  assertFalse(
    isEmployeeAccessibleUnderRLS(employee('v5', ACTIVE_CUSTOM_ROLE.id), employee('t5', 'sales')),
    'isEmployeeAccessibleUnderRLS: custom viewer does not see an unrelated built-in-role target'
  );

  // getAllowedEmployeeRolesUnderRLS for a custom viewer: includes self, the shared-resource pool,
  // graphic_designer/video_editor, and (only because it's granted) its department peer — but a
  // peer role with no grant does not pull in ITS peers.
  assertSameMembers(
    getAllowedEmployeeRolesUnderRLS(ACTIVE_CUSTOM_ROLE.id),
    [ACTIVE_CUSTOM_ROLE.id, 'graphic_designer', 'video_editor', CREATIVE_ROLE.id, SEO_PEER_ROLE.id],
    'getAllowedEmployeeRolesUnderRLS(custom role WITH department-peers grant)'
  );
  assertSameMembers(
    getAllowedEmployeeRolesUnderRLS(SEO_PEER_ROLE.id),
    [SEO_PEER_ROLE.id, 'graphic_designer', 'video_editor', CREATIVE_ROLE.id],
    'getAllowedEmployeeRolesUnderRLS(custom role WITHOUT department-peers grant) excludes its peer'
  );

  // Regression sample: 4 built-in roles, both functions, same results as before this PR.
  assertTrue(isEmployeeAccessibleUnderRLS(employee('v', 'seo_team_lead'), employee('t', 'seo_agent')), 'regression: seo_team_lead sees seo_agent');
  assertFalse(isEmployeeAccessibleUnderRLS(employee('v', 'seo_team_lead'), employee('t', 'sales')), 'regression: seo_team_lead does not see sales');
  assertTrue(isEmployeeAccessibleUnderRLS(employee('v', 'sales'), employee('t', 'sales')), 'regression: sales sees sales');
  assertFalse(isEmployeeAccessibleUnderRLS(employee('v', 'sales'), employee('t', 'am_agent')), 'regression: sales does not see am_agent');
  assertTrue(isEmployeeAccessibleUnderRLS(employee('v', 'am_agent'), employee('t', 'am_team_lead')), 'regression: am_agent sees am_team_lead');
  assertFalse(isEmployeeAccessibleUnderRLS(employee('v', 'am_agent'), employee('t', 'media_buying_agent')), 'regression: am_agent does not see media_buying_agent');
  assertFalse(isEmployeeAccessibleUnderRLS(employee('v', 'graphic_designer'), employee('t', 'seo_agent')), 'regression: graphic_designer does not gain blanket visibility');
  assertTrue(isEmployeeAccessibleUnderRLS(employee('v', 'graphic_designer'), employee('t', 'video_editor')), 'regression: graphic_designer still sees the shared creative pool');

  assertSameMembers(getAllowedEmployeeRolesUnderRLS('graphic_designer'), ['graphic_designer', 'video_editor'], 'regression: getAllowedEmployeeRolesUnderRLS(graphic_designer)');
  assertSameMembers(
    getAllowedEmployeeRolesUnderRLS('seo_team_lead'),
    ['seo_team_lead', 'seo_agent', 'store_manager', 'seo_content_agent', 'seo_backlink_agent', 'graphic_designer', 'video_editor'],
    'regression: getAllowedEmployeeRolesUnderRLS(seo_team_lead)'
  );
  assertSameMembers(getAllowedEmployeeRolesUnderRLS('sales'), ['sales'], 'regression: getAllowedEmployeeRolesUnderRLS(sales)');
  assertSameMembers(
    getAllowedEmployeeRolesUnderRLS('am_agent'),
    ['am_agent', 'am_team_lead', 'graphic_designer', 'video_editor'],
    'regression: getAllowedEmployeeRolesUnderRLS(am_agent)'
  );
}

// --- getOperationalTeams() / getCombinedDepartmentTeams() -----------------------------------

// The exact hardcoded order departmentStaffing.ts's old module-level OPERATIONAL_TEAMS constant
// held, and what getOperationalTeams() must still return before the cache loads (or on fetch
// failure) — the one and only reason this literal exists in two places (the other is the
// FALLBACK_OPERATIONAL_TEAMS constant inside departmentStaffing.ts itself, kept private there).
// Duplicated here deliberately: this test must not import that private fallback and compare it
// against itself — it has to pin down the actual expected sequence a human can review.
const EXPECTED_OPERATIONAL_TEAMS = [
  'SEO',
  'Social Media',
  'Media Buying',
  'Creative & Design',
  'Video Production',
  'Programming',
  'Account Management',
  'AI Engineering',
];

// The 7 departments actually seeded by 20261101400000_custom_roles_departments_foundation.sql,
// with sort_order values matching EXPECTED_OPERATIONAL_TEAMS's order exactly (seo=0 ... ai_engineering=6)
// — the PR 5 migration's backfill is expected to assign these same values.
const SEEDED_DEPARTMENTS: DepartmentRecord[] = [
  { id: 'seo', label: 'Search Engine Optimization (SEO)', is_shared_resource: false, is_active: true, sort_order: 0 },
  { id: 'social_media', label: 'Social Media', is_shared_resource: false, is_active: true, sort_order: 1 },
  { id: 'media_buying', label: 'Media Buying', is_shared_resource: false, is_active: true, sort_order: 2 },
  { id: 'creative_design', label: 'Creative & Design', is_shared_resource: true, is_active: true, sort_order: 3 },
  { id: 'programming', label: 'Programming', is_shared_resource: false, is_active: true, sort_order: 4 },
  { id: 'account_management', label: 'Account Management (AM)', is_shared_resource: false, is_active: true, sort_order: 5 },
  { id: 'ai_engineering', label: 'AI Engineering', is_shared_resource: false, is_active: true, sort_order: 6 },
];

// Mirrors the 20261101400000 migration's department_member_teams seed rows exactly, including
// creative_design's two team values ordered so 'Creative & Design' precedes 'Video Production' —
// matching EXPECTED_OPERATIONAL_TEAMS's flat sequence.
const SEEDED_DEPARTMENT_MEMBER_TEAMS: DepartmentMemberTeamRecord[] = [
  { department_id: 'seo', team_value: 'SEO', sort_order: 0 },
  { department_id: 'social_media', team_value: 'Social Media', sort_order: 0 },
  { department_id: 'media_buying', team_value: 'Media Buying', sort_order: 0 },
  { department_id: 'creative_design', team_value: 'Creative & Design', sort_order: 0 },
  { department_id: 'creative_design', team_value: 'Video Production', sort_order: 1 },
  { department_id: 'programming', team_value: 'Programming', sort_order: 0 },
  { department_id: 'account_management', team_value: 'Account Management', sort_order: 0 },
  { department_id: 'ai_engineering', team_value: 'AI Engineering', sort_order: 0 },
];

function testOperationalTeams(): void {
  // 1. Pre-load fallback: before any registerCustomRoleData() call, getOperationalTeams()/
  // getCombinedDepartmentTeams() must equal today's hardcoded values exactly, order included.
  resetCustomRoleDataForTesting();
  assertEqual(
    JSON.stringify(getOperationalTeams()),
    JSON.stringify(EXPECTED_OPERATIONAL_TEAMS),
    'getOperationalTeams() before cache load equals the hardcoded fallback, in order'
  );
  assertEqual(
    JSON.stringify(getCombinedDepartmentTeams()),
    JSON.stringify({ 'Creative & Design': ['Creative & Design', 'Video Production'] }),
    'getCombinedDepartmentTeams() before cache load equals the hardcoded fallback'
  );

  // 2. Regression: once loaded with exactly today's 7 seeded departments, the derived flat list
  // must equal EXPECTED_OPERATIONAL_TEAMS exactly, in the same order — proving the DB-backed path
  // reproduces today's hardcoded behavior, not just "some list with the same members."
  registerCustomRoleData(SEEDED_DEPARTMENTS, [], [], [], [], SEEDED_DEPARTMENT_MEMBER_TEAMS);
  assertEqual(
    JSON.stringify(getOperationalTeams()),
    JSON.stringify(EXPECTED_OPERATIONAL_TEAMS),
    'getOperationalTeams() with the 7 seeded departments equals today\'s hardcoded order exactly'
  );
  assertEqual(
    JSON.stringify(getCombinedDepartmentTeams()),
    JSON.stringify({ 'Creative & Design': ['Creative & Design', 'Video Production'] }),
    'getCombinedDepartmentTeams() with the 7 seeded departments contains exactly the one Creative & Design entry (keyed by the primary team) — no entry for Video Production, and no single-entry entries for any single-team department'
  );

  // 2b. Expansion is asymmetric: only the PRIMARY team ('Creative & Design', lower sort_order)
  // expands to both; selecting the non-primary team ('Video Production') on its own returns only
  // itself — exactly today's hardcoded behavior, not a new "every team in a multi-team department
  // expands" rule.
  assertSameMembers(
    getCombinedTeamValuesFromCache('Creative & Design'),
    ['Creative & Design', 'Video Production'],
    'getCombinedTeamValuesFromCache("Creative & Design") (the primary team) expands to both'
  );
  assertSameMembers(
    getCombinedTeamValuesFromCache('Video Production'),
    ['Video Production'],
    'getCombinedTeamValuesFromCache("Video Production") (not the primary team) returns only itself'
  );

  // 2c. Frontend-level regression: getEmployeesByDepartment() (departmentStaffing.ts — used by
  // AMQueue/task-assignment-style department pickers) must show the same asymmetry: selecting
  // 'Video Production' returns only Video Production employees; only 'Creative & Design' pulls
  // in both.
  const graphicDesigner = {
    id: 'gd1', name: 'GD', role: 'graphic_designer', team: 'Creative & Design', auth_id: 'auth-gd1', deactivated_at: null,
  } as unknown as UserRecord;
  const videoEditor = {
    id: 've1', name: 'VE', role: 'video_editor', team: 'Video Production', auth_id: 'auth-ve1', deactivated_at: null,
  } as unknown as UserRecord;
  const creativeEmployees = [graphicDesigner, videoEditor];
  assertSameMembers(
    getEmployeesByDepartment(creativeEmployees, 'Video Production').map((u) => u.id),
    [videoEditor.id],
    'getEmployeesByDepartment("Video Production") returns only Video Production employees'
  );
  assertSameMembers(
    getEmployeesByDepartment(creativeEmployees, 'Creative & Design').map((u) => u.id),
    [graphicDesigner.id, videoEditor.id],
    'getEmployeesByDepartment("Creative & Design") returns both Creative & Design and Video Production employees'
  );

  // 3. A fabricated 8th department round-trips correctly: appears at the end (sort_order=7),
  // and an inactive department (is_active=false) is excluded entirely, same as a department that
  // was never seeded.
  const eighthDept: DepartmentRecord = { id: 'customer_support', label: 'Customer Support', is_shared_resource: false, is_active: true, sort_order: 7 };
  const retiredDept: DepartmentRecord = { id: 'retired_dept', label: 'Retired Department', is_shared_resource: false, is_active: false, sort_order: 8 };
  registerCustomRoleData(
    [...SEEDED_DEPARTMENTS, eighthDept, retiredDept],
    [],
    [],
    [],
    [],
    [
      ...SEEDED_DEPARTMENT_MEMBER_TEAMS,
      { department_id: 'customer_support', team_value: 'Customer Support', sort_order: 0 },
      { department_id: 'retired_dept', team_value: 'Retired Team', sort_order: 0 },
    ]
  );
  assertEqual(
    JSON.stringify(getOperationalTeams()),
    JSON.stringify([...EXPECTED_OPERATIONAL_TEAMS, 'Customer Support']),
    'a fabricated 8th (active) department round-trips to the end of getOperationalTeams(), and an inactive 9th is excluded'
  );

  // 4. Empty-cache hazard: a successful fetch with ZERO department_member_teams rows is not the
  // same as "not loaded", but must still fall back to the hardcoded arrays rather than returning
  // an empty list — registerCustomRoleData() marks the cache loaded=true regardless of whether
  // the arrays it was given are empty, and getOperationalTeams()/getCombinedDepartmentTeams()
  // must not let a real, successful, merely-empty join silently empty out every team picker in
  // the app. Departments themselves are present and non-empty here — only the join table is
  // empty — to isolate this from the "nothing loaded at all" case already covered by step 1.
  registerCustomRoleData(SEEDED_DEPARTMENTS, [], [], [], [], []);
  assertEqual(
    JSON.stringify(getOperationalTeams()),
    JSON.stringify(EXPECTED_OPERATIONAL_TEAMS),
    'getOperationalTeams() falls back to the hardcoded list when department_member_teams loads successfully but empty'
  );
  assertEqual(
    JSON.stringify(getCombinedDepartmentTeams()),
    JSON.stringify({ 'Creative & Design': ['Creative & Design', 'Video Production'] }),
    'getCombinedDepartmentTeams() falls back to the hardcoded map when department_member_teams loads successfully but empty'
  );

  // 5. sort_order tolerance: rows missing sort_order entirely (the shape a pre-migration
  // production deploy would actually see, since the column wouldn't exist yet) must not throw,
  // must not duplicate or drop any team, and must still resolve every department's own
  // Creative & Design-style grouping correctly. This does NOT assert a specific order against
  // EXPECTED_OPERATIONAL_TEAMS — without sort_order, deterministic order falls back to
  // created_at then label (see compareDepartments/compareDepartmentMemberTeams in
  // data/customRoles.ts), which only reproduces today's exact sequence once the migration's
  // sort_order backfill has actually run.
  const departmentsMissingSortOrder = SEEDED_DEPARTMENTS.map((d) => ({ ...d, sort_order: undefined as unknown as number }));
  const teamsMissingSortOrder = SEEDED_DEPARTMENT_MEMBER_TEAMS.map((t) => ({ ...t, sort_order: undefined as unknown as number }));
  registerCustomRoleData(departmentsMissingSortOrder, [], [], [], [], teamsMissingSortOrder);
  const resultWithMissingSortOrder = getOperationalTeams();
  assertEqual(resultWithMissingSortOrder.length, EXPECTED_OPERATIONAL_TEAMS.length, 'getOperationalTeams() with no sort_order on any row still returns every team exactly once (no crash, no drop, no duplicate)');
  assertSameMembers(resultWithMissingSortOrder, EXPECTED_OPERATIONAL_TEAMS, 'getOperationalTeams() with no sort_order on any row still contains every expected team value');
  assertSameMembers(
    getCombinedDepartmentTeams()['Creative & Design'] || [],
    ['Creative & Design', 'Video Production'],
    'getCombinedDepartmentTeams() with no sort_order still groups Creative & Design with Video Production'
  );
}

// --- PR 6 (roles/departments admin UI): id/slug generators --------------------------------------

function testIdAndSlugGenerators(): void {
  // slugifyToId: lowercase, non-letters collapsed to '_', letter-first guaranteed, 3-41 chars.
  assertEqual(slugifyToId('UI Designer'), 'ui_designer', 'slugifyToId("UI Designer")');
  assertEqual(slugifyToId('  Social Media (Backup)  '), 'social_media_backup', 'slugifyToId trims punctuation/whitespace to single underscores');
  assertTrue(isValidGeneratedId(slugifyToId('UI Designer')), 'slugifyToId output always satisfies the id shape regex');
  assertTrue(/^[a-z]/.test(slugifyToId('123 Numbers First')), 'slugifyToId prefixes a letter when the label starts with a digit');
  assertTrue(isValidGeneratedId(slugifyToId('123 Numbers First')), 'slugifyToId("123 Numbers First") still satisfies the id shape regex');
  assertTrue(slugifyToId('ab').length >= 3, 'slugifyToId pads a too-short result up to the 3-character minimum');
  assertTrue(isValidGeneratedId(slugifyToId('ab')), 'slugifyToId("ab") (padded) satisfies the id shape regex');
  const veryLongLabel = 'a'.repeat(80);
  assertTrue(isValidGeneratedId(slugifyToId(veryLongLabel)), 'slugifyToId truncates an overlong label to a still-valid id');

  // generateUniqueId: collision handling.
  const existingIds = new Set(['ui_designer']);
  const generated = generateUniqueId('UI Designer', existingIds);
  assertEqual(generated, 'ui_designer_2', 'generateUniqueId appends _2 on a first collision');
  assertTrue(isValidGeneratedId(generated), 'generateUniqueId\'s collision-suffixed id still satisfies the id shape regex');
  const existingIdsWithBothSuffixes = new Set(['ui_designer', 'ui_designer_2']);
  assertEqual(generateUniqueId('UI Designer', existingIdsWithBothSuffixes), 'ui_designer_3', 'generateUniqueId tries _3 when _2 is also taken');
  // A base id that is already at the 41-char limit must still produce a valid, non-colliding id
  // once a numeric suffix is appended (truncating the base to make room, not exceeding 41 chars).
  const maxLengthBase = slugifyToId('a'.repeat(80));
  const collidedMaxLength = generateUniqueId('a'.repeat(80), new Set([maxLengthBase]));
  assertTrue(isValidGeneratedId(collidedMaxLength), 'generateUniqueId keeps a max-length id valid after appending a collision suffix');
  assertTrue(collidedMaxLength !== maxLengthBase, 'generateUniqueId\'s collision-suffixed max-length id differs from the original');

  // slugifyPortalSlug / generateUniquePortalSlug: hyphenated, collision handling via -2, -3, ...
  assertEqual(slugifyPortalSlug('UI Designer'), 'ui-designer', 'slugifyPortalSlug("UI Designer")');
  const existingSlugs = new Set(['ui-designer']);
  assertEqual(generateUniquePortalSlug('UI Designer', existingSlugs), 'ui-designer-2', 'generateUniquePortalSlug appends -2 on a first collision');
  const existingSlugsBoth = new Set(['ui-designer', 'ui-designer-2']);
  assertEqual(generateUniquePortalSlug('UI Designer', existingSlugsBoth), 'ui-designer-3', 'generateUniquePortalSlug tries -3 when -2 is also taken');
}

// --- PR 6: sort_order calculation ----------------------------------------------------------------

function testSortOrderCalculation(): void {
  resetCustomRoleDataForTesting();
  registerCustomRoleData(SEEDED_DEPARTMENTS, [], [], [], [], SEEDED_DEPARTMENT_MEMBER_TEAMS);
  assertEqual(getNextDepartmentSortOrder(), 7, 'getNextDepartmentSortOrder() after the 7 seeded departments (sort_order 0-6) is 7');

  // Tolerates a department with a missing/non-finite sort_order (same transitional concern as
  // compareDepartments' own sort stability) — it must not corrupt the max (e.g. become NaN).
  const withOneMissing = [...SEEDED_DEPARTMENTS, { id: 'bad_dept', label: 'Bad', is_shared_resource: false, is_active: true, sort_order: undefined as unknown as number }];
  registerCustomRoleData(withOneMissing, [], [], [], [], SEEDED_DEPARTMENT_MEMBER_TEAMS);
  assertEqual(getNextDepartmentSortOrder(), 7, 'getNextDepartmentSortOrder() ignores a department with a missing sort_order rather than corrupting the max');

  // An inactive department's sort_order still counts toward the max (deactivating a department
  // should never free up its sort_order for reuse by a brand new one).
  const withInactiveHighest = [...SEEDED_DEPARTMENTS, { id: 'retired_dept', label: 'Retired', is_shared_resource: false, is_active: false, sort_order: 50 }];
  registerCustomRoleData(withInactiveHighest, [], [], [], [], SEEDED_DEPARTMENT_MEMBER_TEAMS);
  assertEqual(getNextDepartmentSortOrder(), 51, 'getNextDepartmentSortOrder() counts an inactive department\'s sort_order toward the max too');
}

// --- PR 6: deactivation guards -------------------------------------------------------------------

function testDeactivationGuards(): void {
  resetCustomRoleDataForTesting();
  setUpFixtures();

  // A seeded department can never be deactivated, regardless of whether it has any active
  // roles/employees — checked first, before the member-count guard.
  const seededGuard = checkCanDeactivateDepartment('seo', []);
  assertFalse(seededGuard.allowed, 'checkCanDeactivateDepartment("seo") (a seeded department) is never allowed');

  // A non-seeded department (CREATIVE_ROLE/ACTIVE_CUSTOM_ROLE etc. all live under seo/
  // creative_design from setUpFixtures()) with no active roles or employees IS allowed.
  const emptyNonSeededDeptId = 'customer_support_dept';
  registerCustomRoleData(
    [...SEEDED_DEPARTMENTS, { id: emptyNonSeededDeptId, label: 'Customer Support', is_shared_resource: false, is_active: true, sort_order: 7 }],
    [],
    [],
    [],
    [],
    [...SEEDED_DEPARTMENT_MEMBER_TEAMS, { department_id: emptyNonSeededDeptId, team_value: 'Customer Support', sort_order: 0 }]
  );
  const emptyGuard = checkCanDeactivateDepartment(emptyNonSeededDeptId, []);
  assertTrue(emptyGuard.allowed, 'checkCanDeactivateDepartment() on a non-seeded department with zero active roles/employees is allowed');

  // The same department, but now with an active custom role assigned to it, is blocked — and the
  // guard reports the count. setUpFixtures() itself registers an empty department_member_teams
  // array (it's designed for the role/capability tests above, which don't need team data) — this
  // re-registers the same custom-role fixtures directly, ADDING a department_member_teams row for
  // DEPT_SEO, so the employee-count check right after this also has real team data to match against.
  registerCustomRoleData(
    [DEPT_SEO, DEPT_CREATIVE],
    [ACTIVE_CUSTOM_ROLE, SEO_PEER_ROLE, CREATIVE_ROLE, INACTIVE_CUSTOM_ROLE],
    [{ role_id: ACTIVE_CUSTOM_ROLE.id, module_id: 'my_work' }],
    [{ role_id: ACTIVE_CUSTOM_ROLE.id, permission_key: 'employees.view_department_peers', granted: true }],
    [{ department_id: DEPT_SEO.id, permission_key: 'tasks.view_cross_team' }],
    [{ department_id: DEPT_SEO.id, team_value: 'SEO', sort_order: 0 }]
  );
  const deptWithActiveRoleGuard = checkCanDeactivateDepartment(DEPT_SEO.id, []);
  assertFalse(deptWithActiveRoleGuard.allowed, 'checkCanDeactivateDepartment() is blocked when the department has an active custom role');
  assertTrue(deptWithActiveRoleGuard.activeCustomRoleCount > 0, 'checkCanDeactivateDepartment() reports a nonzero active-role count when blocked by one');

  // A department with an active EMPLOYEE (not a role) is also blocked, with the employee counted.
  // DEPT_SEO's own team value ('SEO') was just registered above.
  const employeeOnSeoTeam = { id: 'emp1', role: 'am_agent', team: 'SEO', auth_id: 'auth-emp1', deactivated_at: null } as unknown as UserRecord;
  const deptWithEmployeeGuard = checkCanDeactivateDepartment(DEPT_SEO.id, [employeeOnSeoTeam]);
  assertFalse(deptWithEmployeeGuard.allowed, 'checkCanDeactivateDepartment() is blocked when the department has an active employee');
  assertTrue(deptWithEmployeeGuard.activeEmployeeCount > 0, 'checkCanDeactivateDepartment() reports a nonzero active-employee count when blocked by one');

  // countActiveEmployeesHoldingRole: the count the role-deactivation confirmation shows.
  const roleHolder = { id: 'emp2', role: ACTIVE_CUSTOM_ROLE.id, auth_id: 'auth-emp2', deactivated_at: null } as unknown as UserRecord;
  const nonHolder = { id: 'emp3', role: 'sales', auth_id: 'auth-emp3', deactivated_at: null } as unknown as UserRecord;
  assertEqual(
    countActiveEmployeesHoldingRole(ACTIVE_CUSTOM_ROLE.id, [roleHolder, nonHolder]),
    1,
    'countActiveEmployeesHoldingRole() counts only active employees actually holding that role'
  );
}

// --- PR 6: rollback-on-failure (via an injected fake DB client — no real network call) -----------

// A minimal fake standing in for the one chain shape lib/rolesAndDepartmentsAdmin.ts's write
// functions actually use: .from(table).insert(rows).select() / .update(patch).eq(col,val).select()
// / .delete().eq(col,val).select(). `failOn` names the exact "op:table" steps that should come
// back as a Supabase-shaped error (data: null, error: {message}) — every other step succeeds and
// echoes back what was written, so each test can target exactly one failure point. `zeroRowsOn`
// names "delete:table" steps that should come back as a SUCCESSFUL delete that nonetheless
// removed no rows (data: [], error: null) — the exact shape an RLS policy silently blocking a
// delete produces, distinct from an outright error.
function makeFakeDbClient(failOn: ReadonlySet<string>, zeroRowsOn: ReadonlySet<string> = new Set()) {
  const calls: { op: 'insert' | 'update' | 'delete'; table: string }[] = [];
  return {
    calls,
    from(table: string) {
      return {
        insert(rows: any[]) {
          calls.push({ op: 'insert', table });
          return {
            async select() {
              if (failOn.has(`insert:${table}`)) return { data: null, error: { message: `simulated insert failure on ${table}` } };
              return { data: rows, error: null };
            },
          };
        },
        update(patch: any) {
          calls.push({ op: 'update', table });
          return {
            eq(_col: string, _val: string) {
              return {
                async select() {
                  if (failOn.has(`update:${table}`)) return { data: null, error: { message: `simulated update failure on ${table}` } };
                  return { data: [{ ...patch }], error: null };
                },
              };
            },
          };
        },
        delete() {
          return {
            eq(_col: string, val: string) {
              calls.push({ op: 'delete', table });
              return {
                async select() {
                  if (failOn.has(`delete:${table}`)) return { data: null, error: { message: `simulated delete failure on ${table}` } };
                  if (zeroRowsOn.has(`delete:${table}`)) return { data: [], error: null };
                  return { data: [{ id: val }], error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

async function testRollbackOnFailure(): Promise<void> {
  resetCustomRoleDataForTesting();
  registerCustomRoleData(SEEDED_DEPARTMENTS, [], [], [], [], SEEDED_DEPARTMENT_MEMBER_TEAMS);

  // createDepartment: failure inserting department_member_teams must delete BOTH the just-created
  // department_member_teams rows (a no-op here since none were created, but still called — see
  // below) AND the parent departments row, never leaving an is_active=false orphan.
  {
    const fake = makeFakeDbClient(new Set(['insert:department_member_teams']));
    const result = await createDepartment({ label: 'Rollback Dept', teamValues: ['Rollback Team'], isSharedResource: false }, fake);
    assertFalse(result.success, 'createDepartment() reports failure when the department_member_teams insert fails');
    assertTrue(!!result.error, 'createDepartment() returns an error message on failure');
    const deleteCalls = fake.calls.filter((c) => c.op === 'delete').map((c) => c.table);
    assertSameMembers(deleteCalls, ['department_member_teams', 'departments'], 'createDepartment() rolls back both tables when the team-values insert fails');
  }

  // createDepartment: failure on the final activate (update is_active=true) step must ALSO roll
  // back both tables — it's not just the insert steps that need cleanup.
  {
    const fake = makeFakeDbClient(new Set(['update:departments']));
    const result = await createDepartment({ label: 'Rollback Dept 2', teamValues: ['Rollback Team 2'], isSharedResource: false }, fake);
    assertFalse(result.success, 'createDepartment() reports failure when the final activate step fails');
    const deleteCalls = fake.calls.filter((c) => c.op === 'delete').map((c) => c.table);
    assertSameMembers(deleteCalls, ['department_member_teams', 'departments'], 'createDepartment() rolls back both tables when the activate step fails');
  }

  // createDepartment: no failure at all must mean no rollback deletes whatsoever.
  {
    const fake = makeFakeDbClient(new Set());
    const result = await createDepartment({ label: 'Clean Dept', teamValues: ['Clean Team'], isSharedResource: false }, fake);
    assertTrue(result.success, 'createDepartment() succeeds when every step succeeds');
    assertEqual(fake.calls.filter((c) => c.op === 'delete').length, 0, 'createDepartment() issues zero rollback deletes on a clean success');
  }

  // createCustomRole: failure inserting custom_role_permissions (the last child table, inserted
  // only when there's at least one real override) must roll back all 3 tables, in a single
  // failure path that reaches every one of them.
  {
    const fake = makeFakeDbClient(new Set(['insert:custom_role_permissions']));
    const result = await createCustomRole(
      {
        englishTitle: 'Rollback Role',
        departmentId: 'seo',
        defaultModule: 'my_work',
        allowedModules: ['my_work'],
        permissionOverrides: { 'employees.view_department_peers': 'grant' },
        isActive: true,
      },
      fake
    );
    assertFalse(result.success, 'createCustomRole() reports failure when the custom_role_permissions insert fails');
    const deleteCalls = fake.calls.filter((c) => c.op === 'delete').map((c) => c.table);
    assertSameMembers(
      deleteCalls,
      ['custom_role_permissions', 'custom_role_modules', 'custom_roles'],
      'createCustomRole() rolls back all 3 tables when the permission-overrides insert fails'
    );
  }

  // createCustomRole: failure on the final activate step, with NO permission overrides supplied
  // (so custom_role_permissions is never inserted at all) — the activate-failure cleanup
  // unconditionally attempts a delete on all 3 child/parent tables regardless of which ones
  // actually got an insert; a DELETE matching zero rows is a harmless no-op, so this is simpler
  // than tracking exactly which inserts happened and still always correct.
  {
    const fake = makeFakeDbClient(new Set(['update:custom_roles']));
    const result = await createCustomRole(
      {
        englishTitle: 'Rollback Role 2',
        departmentId: 'seo',
        defaultModule: 'my_work',
        allowedModules: ['my_work'],
        permissionOverrides: {},
        isActive: true,
      },
      fake
    );
    assertFalse(result.success, 'createCustomRole() reports failure when the final activate step fails');
    const deleteCalls = fake.calls.filter((c) => c.op === 'delete').map((c) => c.table);
    assertSameMembers(
      deleteCalls,
      ['custom_role_permissions', 'custom_role_modules', 'custom_roles'],
      'createCustomRole() rolls back all 3 tables (even ones with nothing to delete) when the activate step fails, no overrides given'
    );
  }

  // --- Rollback-itself-failed reporting: the parent row's own delete either errors outright or
  // succeeds but removes zero rows (the shape a missing/too-narrow DELETE RLS policy on
  // departments/custom_roles actually produces) — the returned error must name the table left
  // behind, not just repeat the original failure as if cleanup had quietly succeeded.

  // createDepartment: team-values insert fails, AND the departments rollback delete itself
  // errors outright.
  {
    const fake = makeFakeDbClient(new Set(['insert:department_member_teams', 'delete:departments']));
    const result = await createDepartment({ label: 'Rollback Dept 3', teamValues: ['Rollback Team 3'], isSharedResource: false }, fake);
    assertFalse(result.success, 'createDepartment() reports failure when both the insert and the departments rollback delete fail');
    assertTrue(!!result.error && result.error.includes('departments'), 'createDepartment() names "departments" as left behind when its rollback delete errors outright');
  }

  // createDepartment: team-values insert fails, AND the departments rollback delete "succeeds"
  // but removes zero rows (silently blocked by RLS, no error at all).
  {
    const fake = makeFakeDbClient(new Set(['insert:department_member_teams']), new Set(['delete:departments']));
    const result = await createDepartment({ label: 'Rollback Dept 4', teamValues: ['Rollback Team 4'], isSharedResource: false }, fake);
    assertFalse(result.success, 'createDepartment() reports failure when its rollback delete removes zero rows');
    assertTrue(
      !!result.error && result.error.includes('departments'),
      'createDepartment() names "departments" as left behind when its rollback delete silently removes zero rows'
    );
  }

  // createCustomRole: the final activate step fails, AND the custom_roles rollback delete itself
  // errors outright.
  {
    const fake = makeFakeDbClient(new Set(['update:custom_roles', 'delete:custom_roles']));
    const result = await createCustomRole(
      {
        englishTitle: 'Rollback Role 3',
        departmentId: 'seo',
        defaultModule: 'my_work',
        allowedModules: ['my_work'],
        permissionOverrides: {},
        isActive: true,
      },
      fake
    );
    assertFalse(result.success, 'createCustomRole() reports failure when both activation and the custom_roles rollback delete fail');
    assertTrue(!!result.error && result.error.includes('custom_roles'), 'createCustomRole() names "custom_roles" as left behind when its rollback delete errors outright');
  }

  // createCustomRole: the final activate step fails, AND the custom_roles rollback delete
  // removes zero rows.
  {
    const fake = makeFakeDbClient(new Set(['update:custom_roles']), new Set(['delete:custom_roles']));
    const result = await createCustomRole(
      {
        englishTitle: 'Rollback Role 4',
        departmentId: 'seo',
        defaultModule: 'my_work',
        allowedModules: ['my_work'],
        permissionOverrides: {},
        isActive: true,
      },
      fake
    );
    assertFalse(result.success, 'createCustomRole() reports failure when its rollback delete removes zero rows');
    assertTrue(
      !!result.error && result.error.includes('custom_roles'),
      'createCustomRole() names "custom_roles" as left behind when its rollback delete silently removes zero rows'
    );
  }

  // A clean rollback (both steps actually remove their rows) must NOT mention anything being
  // left behind — only the original failure reason.
  {
    const fake = makeFakeDbClient(new Set(['insert:department_member_teams']));
    const result = await createDepartment({ label: 'Rollback Dept 5', teamValues: ['Rollback Team 5'], isSharedResource: false }, fake);
    assertFalse(result.success, 'createDepartment() still reports the original failure on a clean rollback');
    assertTrue(!!result.error && !result.error.includes('rollback could not remove'), 'createDepartment() does not mention a failed rollback when the rollback itself succeeded');
  }

  resetCustomRoleDataForTesting();
}

// --- PR 6 review fixes: form validation ----------------------------------------------------------

function testFormValidation(): void {
  // normalizeAllowedModules: defaultModule is always added if missing, guaranteeing the result
  // is never empty; already-present defaultModule leaves the list untouched (same array contents).
  assertSameMembers(
    normalizeAllowedModules([], 'my_work'),
    ['my_work'],
    'normalizeAllowedModules([]) adds the default module, never leaving an empty list'
  );
  assertSameMembers(
    normalizeAllowedModules(['dashboard'], 'my_work'),
    ['dashboard', 'my_work'],
    'normalizeAllowedModules() adds a missing default module alongside whatever was already checked'
  );
  assertSameMembers(
    normalizeAllowedModules(['dashboard', 'my_work'], 'my_work'),
    ['dashboard', 'my_work'],
    'normalizeAllowedModules() is a no-op when the default module is already included'
  );

  // findReservedTeamValue: case-insensitive, trimmed match against the 5 reserved values; a
  // real, non-reserved team value is never flagged.
  for (const reserved of ['Marketing', 'technical', '  Executive  ', 'SALES', 'Creative']) {
    assertEqual(
      findReservedTeamValue(['Some Real Team', reserved]),
      reserved,
      `findReservedTeamValue() flags "${reserved}" as reserved (case-insensitive, trimmed)`
    );
  }
  assertEqual(findReservedTeamValue(['Customer Support', 'Billing']), null, 'findReservedTeamValue() does not flag ordinary team values');
}

async function testReservedTeamValueRejection(): Promise<void> {
  resetCustomRoleDataForTesting();
  registerCustomRoleData(SEEDED_DEPARTMENTS, [], [], [], [], SEEDED_DEPARTMENT_MEMBER_TEAMS);

  const fake = makeFakeDbClient(new Set());
  const result = await createDepartment({ label: 'New Dept', teamValues: ['Real Team', 'Marketing'], isSharedResource: false }, fake);
  assertFalse(result.success, 'createDepartment() rejects a department whose team values include a reserved one');
  assertTrue(!!result.error && /reserved/i.test(result.error), 'createDepartment()\'s rejection error mentions "reserved"');
  assertEqual(fake.calls.length, 0, 'createDepartment() rejects a reserved team value before making any DB call at all');

  resetCustomRoleDataForTesting();
}

// --- Fail-closed-before-load sanity check ------------------------------------------------------

function testFailClosedBeforeLoad(): void {
  resetCustomRoleDataForTesting();

  assertEqual(getRoleInfo(ACTIVE_CUSTOM_ROLE.id).portalSlug, 'unconfigured', 'getRoleInfo before any registerCustomRoleData() call fails closed');
  assertFalse(can({ role: ACTIVE_CUSTOM_ROLE.id }, 'tasks.view_cross_team'), 'can() before any registerCustomRoleData() call fails closed');
}

async function main(): Promise<void> {
  testGetRoleInfo();
  testCan();
  testReportingEngine();
  testEmployeeVisibility();
  testOperationalTeams();
  testIdAndSlugGenerators();
  testSortOrderCalculation();
  testDeactivationGuards();
  await testRollbackOnFailure();
  testFormValidation();
  await testReservedTeamValueRejection();
  testFailClosedBeforeLoad();
  resetCustomRoleDataForTesting();

  if (failures.length > 0) {
    console.error('Found custom-roles/capabilities regression(s):\n');
    for (const f of failures) {
      console.error(`  ${f}`);
    }
    process.exit(1);
  }

  console.log('OK: getRoleInfo()/can()/resolveClientsForSubject()/serviceFilterForRole()/isEmployeeAccessibleUnderRLS()/getAllowedEmployeeRolesUnderRLS() behave correctly.');
}

main().catch((err) => {
  console.error('Unexpected error while running checks:', err);
  process.exit(1);
});
