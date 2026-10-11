// In-memory cache for admin-managed custom roles/departments (public.departments,
// public.custom_roles, public.custom_role_modules, public.custom_role_permissions,
// public.department_permissions — 20261101400000_custom_roles_departments_foundation.sql).
//
// Populated ONCE at app bootstrap by App.tsx's loadData() calling registerCustomRoleData() with
// the result of a single fetch of all five tables, so every reader below (getRoleInfo(), can(),
// the employee-visibility mirrors in lib/supabase.ts) stays fully synchronous — no call site
// needs to become async just because a role might now live in the database instead of in code.
//
// registerCustomRoleData() is safe to call repeatedly (a manual refresh, a re-login): each call
// reassigns the whole cache object atomically, so a concurrent reader never sees a half-updated
// mix of old and new rows, and nothing accumulates across calls.
//
// Fail-closed by construction: before the first successful registerCustomRoleData() call, every
// lookup below returns the same "not found" result it would for a role that genuinely doesn't
// exist. There is no role-string pattern that sneaks past this — only a row literally present in
// the cache (and, for CustomRoleRecord, literally is_active) resolves to anything.
import {
  CustomRoleModuleRecord,
  CustomRolePermissionRecord,
  CustomRoleRecord,
  DepartmentMemberTeamRecord,
  DepartmentPermissionRecord,
  DepartmentRecord,
} from '../types/database';

interface CustomRoleCache {
  loaded: boolean;
  departmentsById: Map<string, DepartmentRecord>;
  customRolesById: Map<string, CustomRoleRecord>;
  modulesByRoleId: Map<string, Set<string>>;
  permissionOverridesByRoleId: Map<string, Map<string, boolean>>;
  departmentPermissionsByDeptId: Map<string, Set<string>>;
  // Ordered (by department.sort_order, then department_member_teams.sort_order) team_value lists
  // per active department — the table-driven replacement for departmentStaffing.ts's hardcoded
  // OPERATIONAL_TEAMS/COMBINED_DEPARTMENT_TEAMS (PR 5). Built only from ACTIVE departments, same
  // "currently selectable" semantics OPERATIONAL_TEAMS already had by only ever listing real,
  // live departments.
  operationalTeamValues: string[];
  deptIdByTeamValue: Map<string, string>;
  teamValuesByDeptId: Map<string, string[]>;
}

const emptyCache = (): CustomRoleCache => ({
  loaded: false,
  departmentsById: new Map(),
  customRolesById: new Map(),
  modulesByRoleId: new Map(),
  permissionOverridesByRoleId: new Map(),
  departmentPermissionsByDeptId: new Map(),
  operationalTeamValues: [],
  deptIdByTeamValue: new Map(),
  teamValuesByDeptId: new Map(),
});

let cache: CustomRoleCache = emptyCache();

// A missing/non-finite sort_order sorts last (not first) — an explicit sort_order should always
// win over "no preference", and treating every such row as tied with every other such row lets
// Array.sort's stability (guaranteed since ES2019) resolve them deterministically by the
// secondary/tertiary keys below rather than by an unspecified NaN comparator result.
const UNORDERED_SORT_ORDER = Number.MAX_SAFE_INTEGER;

const normalizedSortOrder = (value: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : UNORDERED_SORT_ORDER;

function compareDepartments(a: DepartmentRecord, b: DepartmentRecord): number {
  const bySortOrder = normalizedSortOrder(a.sort_order) - normalizedSortOrder(b.sort_order);
  if (bySortOrder !== 0) return bySortOrder;
  const aCreatedAt = a.created_at ?? '';
  const bCreatedAt = b.created_at ?? '';
  if (aCreatedAt !== bCreatedAt) return aCreatedAt < bCreatedAt ? -1 : 1;
  return a.label.localeCompare(b.label);
}

function compareDepartmentMemberTeams(a: DepartmentMemberTeamRecord, b: DepartmentMemberTeamRecord): number {
  const bySortOrder = normalizedSortOrder(a.sort_order) - normalizedSortOrder(b.sort_order);
  if (bySortOrder !== 0) return bySortOrder;
  return a.team_value.localeCompare(b.team_value);
}

export function registerCustomRoleData(
  departments: DepartmentRecord[],
  customRoles: CustomRoleRecord[],
  customRoleModules: CustomRoleModuleRecord[],
  customRolePermissions: CustomRolePermissionRecord[],
  departmentPermissions: DepartmentPermissionRecord[],
  departmentMemberTeams: DepartmentMemberTeamRecord[]
): void {
  const departmentsById = new Map(departments.map((d) => [d.id, d]));
  const customRolesById = new Map(customRoles.map((r) => [r.id, r]));

  const modulesByRoleId = new Map<string, Set<string>>();
  for (const m of customRoleModules) {
    if (!modulesByRoleId.has(m.role_id)) modulesByRoleId.set(m.role_id, new Set());
    modulesByRoleId.get(m.role_id)!.add(m.module_id);
  }

  const permissionOverridesByRoleId = new Map<string, Map<string, boolean>>();
  for (const p of customRolePermissions) {
    if (!permissionOverridesByRoleId.has(p.role_id)) permissionOverridesByRoleId.set(p.role_id, new Map());
    permissionOverridesByRoleId.get(p.role_id)!.set(p.permission_key, p.granted);
  }

  const departmentPermissionsByDeptId = new Map<string, Set<string>>();
  for (const dp of departmentPermissions) {
    if (!departmentPermissionsByDeptId.has(dp.department_id)) departmentPermissionsByDeptId.set(dp.department_id, new Set());
    departmentPermissionsByDeptId.get(dp.department_id)!.add(dp.permission_key);
  }

  // Active departments only, ordered by sort_order — the flat list's department-level ordering.
  // sort_order may be missing/NaN if this code ever runs against a live DB before the migration
  // that adds the column has shipped (a frontend/migration deploy-ordering race, not something
  // that should ever crash or produce an inconsistent result): compareBySortOrder below treats
  // a missing/invalid value as "no preference" rather than feeding NaN into Array.sort, whose
  // result for a NaN-returning comparator is unspecified by the language.
  const activeDepartmentsSorted = departments.filter((d) => d.is_active).sort(compareDepartments);
  const activeDeptIds = new Set(activeDepartmentsSorted.map((d) => d.id));

  const teamsByDept = new Map<string, DepartmentMemberTeamRecord[]>();
  for (const t of departmentMemberTeams) {
    if (!activeDeptIds.has(t.department_id)) continue;
    if (!teamsByDept.has(t.department_id)) teamsByDept.set(t.department_id, []);
    teamsByDept.get(t.department_id)!.push(t);
  }

  const deptIdByTeamValue = new Map<string, string>();
  const teamValuesByDeptId = new Map<string, string[]>();
  const operationalTeamValues: string[] = [];
  for (const dept of activeDepartmentsSorted) {
    const teamsInDept = (teamsByDept.get(dept.id) ?? []).slice().sort(compareDepartmentMemberTeams);
    const values = teamsInDept.map((t) => t.team_value);
    teamValuesByDeptId.set(dept.id, values);
    for (const value of values) {
      deptIdByTeamValue.set(value, dept.id);
      operationalTeamValues.push(value);
    }
  }

  cache = {
    loaded: true,
    departmentsById,
    customRolesById,
    modulesByRoleId,
    permissionOverridesByRoleId,
    departmentPermissionsByDeptId,
    operationalTeamValues,
    deptIdByTeamValue,
    teamValuesByDeptId,
  };
}

// Resets to the pre-load (fail-closed) state. Exported only for the unit-style check script
// (scripts/checkCustomRolesAndCapabilities.ts) to isolate scenarios — never called from app code.
export function resetCustomRoleDataForTesting(): void {
  cache = emptyCache();
}

export function isCustomRoleCacheLoaded(): boolean {
  return cache.loaded;
}

export function getActiveCustomRole(roleId: string): CustomRoleRecord | null {
  const row = cache.customRolesById.get(roleId);
  return row && row.is_active ? row : null;
}

export function getCustomRoleModules(roleId: string): string[] {
  return Array.from(cache.modulesByRoleId.get(roleId) ?? []);
}

export function isSharedResourceCustomRole(roleId: string): boolean {
  const role = getActiveCustomRole(roleId);
  if (!role || !role.department_id) return false;
  return !!cache.departmentsById.get(role.department_id)?.is_shared_resource;
}

export function getCustomRoleDepartmentId(roleId: string): string | null {
  return getActiveCustomRole(roleId)?.department_id ?? null;
}

// Every OTHER active custom role in the same department as `roleId` — never includes roleId
// itself (mirrors employee_visible()'s department-peers arm, which is about PEERS, not self;
// self-visibility is unconditional elsewhere and doesn't need this list).
export function getCustomRoleDepartmentPeerIds(roleId: string): string[] {
  const deptId = getCustomRoleDepartmentId(roleId);
  if (!deptId) return [];
  const peers: string[] = [];
  for (const [id, role] of cache.customRolesById) {
    if (id !== roleId && role.is_active && role.department_id === deptId) peers.push(id);
  }
  return peers;
}

// Every active custom role id — used to widen the set of ids EmployeeAdminHub treats as
// assignable/valid (VALID_ROLES) without touching canManageEmployee/assignableRolesFor, which
// already correctly gate WHO can pick from that widened set.
export function getAllActiveCustomRoleIds(): string[] {
  const ids: string[] = [];
  for (const [id, role] of cache.customRolesById) {
    if (role.is_active) ids.push(id);
  }
  return ids;
}

// Every active custom role whose department is a shared resource (e.g. Creative & Design) —
// mirrors employee_visible()'s "target_role is a shared-resource custom role, visible to every
// non-sales caller" arm (20261101600000_custom_roles_employee_visibility.sql).
export function getSharedResourceCustomRoleIds(): string[] {
  const ids: string[] = [];
  for (const [id] of cache.customRolesById) {
    if (isSharedResourceCustomRole(id)) ids.push(id);
  }
  return ids;
}

// Mirrors app_has_permission() exactly: a per-role override wins outright; otherwise the role's
// department default; otherwise false. Returns false for any id that isn't an active custom role
// (including every built-in role — this function is only ever meaningful for a custom-role id;
// src/lib/capabilities.ts's can() is what built-in callers should use, and it never delegates
// here for them).
export function customRoleHasPermission(roleId: string, permissionKey: string): boolean {
  const role = getActiveCustomRole(roleId);
  if (!role) return false;
  const override = cache.permissionOverridesByRoleId.get(roleId)?.get(permissionKey);
  if (override !== undefined) return override;
  if (!role.department_id) return false;
  return cache.departmentPermissionsByDeptId.get(role.department_id)?.has(permissionKey) ?? false;
}

// Flat, ordered list of every team_value across every active department (department.sort_order,
// then department_member_teams.sort_order within it) — the table-driven data source behind
// departmentStaffing.ts's getOperationalTeams(). Empty before the cache loads or if the fetch
// never ran; departmentStaffing.ts itself (not here) decides what fallback to show in that case.
export function getOperationalTeamValuesFromCache(): string[] {
  return [...cache.operationalTeamValues];
}

// The table-driven data source behind departmentStaffing.ts's getCombinedDepartmentTeams().
// Expansion to every team_value sharing `team`'s department applies ONLY when `team` is that
// department's PRIMARY team (the member team with the lowest sort_order, ties broken by
// team_value — i.e. teamValuesByDeptId's own first entry, since it's already sorted that way).
// This mirrors today's actual hardcoded behavior exactly: selecting 'Creative & Design' expands
// to both Creative & Design and Video Production employees, but selecting 'Video Production'
// itself returns ONLY Video Production — it is never the one that expands. Every other team
// (a team_value whose department has only one team, isn't the primary team of a multi-team
// department, or isn't found in the cache at all) comes back as just [team].
export function getCombinedTeamValuesFromCache(team: string): string[] {
  const deptId = cache.deptIdByTeamValue.get(team);
  if (!deptId) return [team];
  const teamsInDept = cache.teamValuesByDeptId.get(deptId);
  if (!teamsInDept || teamsInDept.length === 0) return [team];
  return team === teamsInDept[0] ? teamsInDept : [team];
}
