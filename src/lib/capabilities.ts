// can(user, capability) — the one new capability-check surface for roles that live in the
// database (public.custom_roles) rather than in code. It is NOT a replacement for the existing
// hardcoded checks in lib/permissions.ts, lib/supabase.ts, etc. — those already correctly decide
// access for the 19 built-in roles and are left exactly as they are. can() is additive: a custom
// role's access to anything beyond its unconditional self-visibility is decided here.
import { UserRecord } from '../types/database';
import { isBuiltInRole } from '../data/roles';
import { customRoleHasPermission } from '../data/customRoles';

// The finite, closed set of capabilities a custom role (via its department default or a per-role
// override) can ever be granted — mirrors permission_catalog's grantable=true rows exactly
// (20261101400000_custom_roles_departments_foundation.sql). Administrative keys (users.manage,
// users.create, users.manage_role_team_department, admin.impersonation, admin.roles_departments)
// are deliberately NOT part of this type — can() has no way to even be asked about them by a
// normally-typed caller.
export type CapabilityKey =
  | 'employees.view_department_peers'
  | 'tasks.view_cross_team'
  | 'daily_logs.view_department'
  | 'extra_notes.view_department'
  | 'kpi_scores.view_department';

// Display metadata for the roles/departments admin UI (PR 6) — one row per CapabilityKey above,
// in the same order, mirroring permission_catalog's own 5 grantable=true rows and labels exactly
// (20261101400000_custom_roles_departments_foundation.sql). `enforced: false` means the key
// exists in the schema and can() already resolves it correctly, but nothing in the app actually
// reads it yet — only employees.view_department_peers (lib/supabase.ts's employee-visibility
// mirrors) is wired into any real check today. The admin UI surfaces this directly rather than
// implying a toggle does something it doesn't.
export const GRANTABLE_CAPABILITY_CATALOG: { key: CapabilityKey; label: string; enforced: boolean }[] = [
  { key: 'employees.view_department_peers', label: 'View employees in my own department', enforced: true },
  { key: 'tasks.view_cross_team', label: 'View tasks across every team', enforced: false },
  { key: 'daily_logs.view_department', label: 'View daily logs for my department', enforced: false },
  { key: 'extra_notes.view_department', label: 'View extra notes for my department', enforced: false },
  { key: 'kpi_scores.view_department', label: 'View KPI scores for my department', enforced: false },
];

// Defense in depth, independent of the CapabilityKey type above: even if a caller bypasses the
// type (e.g. a dynamic string cast), these keys can never be granted by can(), mirroring
// app_has_permission()'s own "grantable" guard server-side — never grantable regardless of what
// any permission table says.
const NEVER_GRANTABLE: ReadonlySet<string> = new Set([
  'users.manage',
  'users.create',
  'users.manage_role_team_department',
  'admin.impersonation',
  'admin.roles_departments',
]);

// Explicit transcription of what a built-in role already gets through its own existing hardcoded
// checks elsewhere (permissions.ts, employee_visible(), task_visible(), etc.) — empty today,
// because every one of the 19 built-in roles already gets equivalent access directly from those
// existing checks, not from this permission system. Exists so a future built-in grant has a
// single, explicit place to be added rather than inventing a new pattern; adding an entry here
// has zero effect unless some call site is also changed to call can() instead of its existing
// hardcoded check, so this table being empty is not itself a behavior change.
const BUILT_IN_CAPABILITY_GRANTS: Partial<Record<string, CapabilityKey[]>> = {};

export function can(user: Pick<UserRecord, 'role'>, capability: CapabilityKey): boolean {
  if (NEVER_GRANTABLE.has(capability)) return false;

  if (user.role === 'executive' || user.role === 'head_of_technical') return true;

  if (isBuiltInRole(user.role)) {
    return BUILT_IN_CAPABILITY_GRANTS[user.role]?.includes(capability) ?? false;
  }

  return customRoleHasPermission(user.role, capability);
}
