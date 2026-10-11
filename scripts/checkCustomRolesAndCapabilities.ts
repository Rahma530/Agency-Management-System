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
 *
 * Run via `npm run lint` (chained after tsc --noEmit) or directly: `npx tsx
 * scripts/checkCustomRolesAndCapabilities.ts`.
 */
import {
  registerCustomRoleData,
  resetCustomRoleDataForTesting,
  getCombinedTeamValuesFromCache,
} from '../src/data/customRoles';
import { getRoleInfo, isBuiltInRole } from '../src/data/roles';
import { can, CapabilityKey } from '../src/lib/capabilities';
import { resolveClientsForSubject, serviceFilterForRole } from '../src/lib/reportingEngine';
import { isEmployeeAccessibleUnderRLS, getAllowedEmployeeRolesUnderRLS } from '../src/lib/supabase';
import { getCombinedDepartmentTeams, getEmployeesByDepartment, getOperationalTeams } from '../src/lib/departmentStaffing';
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

// --- Fail-closed-before-load sanity check ------------------------------------------------------

function testFailClosedBeforeLoad(): void {
  resetCustomRoleDataForTesting();

  assertEqual(getRoleInfo(ACTIVE_CUSTOM_ROLE.id).portalSlug, 'unconfigured', 'getRoleInfo before any registerCustomRoleData() call fails closed');
  assertFalse(can({ role: ACTIVE_CUSTOM_ROLE.id }, 'tasks.view_cross_team'), 'can() before any registerCustomRoleData() call fails closed');
}

function main(): void {
  testGetRoleInfo();
  testCan();
  testReportingEngine();
  testEmployeeVisibility();
  testOperationalTeams();
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

main();
