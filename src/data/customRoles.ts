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
}

const emptyCache = (): CustomRoleCache => ({
  loaded: false,
  departmentsById: new Map(),
  customRolesById: new Map(),
  modulesByRoleId: new Map(),
  permissionOverridesByRoleId: new Map(),
  departmentPermissionsByDeptId: new Map(),
});

let cache: CustomRoleCache = emptyCache();

export function registerCustomRoleData(
  departments: DepartmentRecord[],
  customRoles: CustomRoleRecord[],
  customRoleModules: CustomRoleModuleRecord[],
  customRolePermissions: CustomRolePermissionRecord[],
  departmentPermissions: DepartmentPermissionRecord[]
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

  cache = {
    loaded: true,
    departmentsById,
    customRolesById,
    modulesByRoleId,
    permissionOverridesByRoleId,
    departmentPermissionsByDeptId,
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
