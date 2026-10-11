// Pure id/slug generators + Supabase write paths for the roles/departments admin UI (PR 6,
// src/components/RolesAndDepartmentsAdmin.tsx). Kept separate from that component so the
// generators (pure functions) are importable from a plain tsx test script without pulling in
// React — the exact same reasoning scripts/checkCustomRolesAndCapabilities.ts already relies on
// for data/customRoles.ts.
//
// Writes go through the real Supabase client (lib/supabase.ts's `supabase`) and check every
// returned row via .select() — an RLS-filtered write (e.g. a non-executive/HOT session somehow
// reaching this code) returns zero rows with NO error, which would otherwise look like success.
// Creating a department touches 2 tables (departments, department_member_teams); creating a
// custom role touches 3 (custom_roles, custom_role_modules, custom_role_permissions). There is no
// multi-table transaction available from the client, so every create function: (1) inserts the
// parent row with is_active=false, (2) inserts the child rows, (3) flips is_active=true as the
// LAST step, and (4) on any failure at any step, deletes whatever was already inserted and
// reports the error — never leaving a half-created, is_active=false orphan behind.
import { supabase } from './supabase';
import { isActiveEmployee } from './permissions';
import { AppModuleId } from '../data/roles';
import { CapabilityKey } from './capabilities';
import {
  CustomRoleRecord,
  DepartmentRecord,
  UserRecord,
} from '../types/database';
import {
  countActiveCustomRolesInDepartment,
  getAllCustomRoles,
  getAllDepartments,
  getDepartmentMemberTeamsForDepartment,
  getNextDepartmentSortOrder,
} from '../data/customRoles';

// The 7 departments seeded by 20261101400000_custom_roles_departments_foundation.sql — cannot be
// deactivated, and their id/team values cannot be changed, from this UI (PR 6 decision 2).
export const SEEDED_DEPARTMENT_IDS: ReadonlySet<string> = new Set([
  'seo',
  'social_media',
  'media_buying',
  'creative_design',
  'programming',
  'account_management',
  'ai_engineering',
]);

// Mirrors custom_roles_id_shape_check / departments_id_shape_check exactly (both
// '^[a-z][a-z0-9_]{2,40}$' — 1 letter + 2 to 40 more lowercase letters/digits/underscores, 3 to
// 41 characters total).
const ID_SHAPE_REGEX = /^[a-z][a-z0-9_]{2,40}$/;

export function isValidGeneratedId(id: string): boolean {
  return ID_SHAPE_REGEX.test(id);
}

// Lowercase, non-letter runs collapsed to a single underscore, leading/trailing underscores
// trimmed. If the result doesn't start with a letter (e.g. the label was all digits/punctuation),
// prefixes with 'r_' rather than failing — matches custom_roles_id_shape_check's letter-first
// requirement without ever refusing to generate an id. Padded/truncated to land in the DB
// constraint's 3-41 character window.
export function slugifyToId(label: string): string {
  let candidate = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  if (!/^[a-z]/.test(candidate)) candidate = `r_${candidate}`;
  candidate = candidate.replace(/_+/g, '_').replace(/_+$/, '');
  if (candidate.length > 41) candidate = candidate.slice(0, 41).replace(/_+$/, '');
  while (candidate.length < 3) candidate += '0';
  return candidate;
}

// Appends _2, _3, ... (truncating the base to leave room, so the result is always still within
// the 3-41 character / shape-regex window) until an id outside `existingIds` is found. Throws
// only if 9999 consecutive collisions occur, which would mean existingIds itself is pathological.
export function generateUniqueId(label: string, existingIds: ReadonlySet<string>): string {
  const base = slugifyToId(label);
  if (!existingIds.has(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix++) {
    const suffixStr = `_${suffix}`;
    const truncatedBase = base.slice(0, 41 - suffixStr.length).replace(/_+$/, '');
    const candidate = `${truncatedBase}${suffixStr}`;
    if (ID_SHAPE_REGEX.test(candidate) && !existingIds.has(candidate)) return candidate;
  }
  throw new Error('Could not generate a unique id after many attempts.');
}

// portal_slug has no DB shape CHECK (just `unique`), so this is free to use hyphens for a more
// URL-like slug rather than reusing the id's underscore shape.
export function slugifyPortalSlug(label: string): string {
  const candidate = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return candidate || 'role';
}

export function generateUniquePortalSlug(label: string, existingSlugs: ReadonlySet<string>): string {
  const base = slugifyPortalSlug(label);
  if (!existingSlugs.has(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!existingSlugs.has(candidate)) return candidate;
  }
  throw new Error('Could not generate a unique portal slug after many attempts.');
}

function friendlyUniqueViolation(error: { code?: string; message?: string } | null | undefined, fieldName: string): string | null {
  if (error && (error.code === '23505' || /duplicate key value/i.test(error.message || ''))) {
    return `That ${fieldName} is already in use. Please choose a different one.`;
  }
  return null;
}

export interface AdminWriteResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Every write function below takes the Supabase client as its last parameter, defaulting to the
// real one (lib/supabase.ts's `supabase`) — the only reason is testability: the rollback-on-
// failure path can only be exercised deterministically, without a real network call, by handing
// in a fake that fails a specific step on cue (see scripts/checkCustomRolesAndCapabilities.ts's
// testRollbackOnFailure()). Typed loosely (not as SupabaseClient) because only the narrow
// .from(table).insert(...).select() / .update(...).eq(...).select() / .delete().eq(...) chain
// actually used below needs to match; forcing the real, far richer generic SupabaseClient type
// to line up with a plain test fake would need its own elaborate mock typing for no behavioral
// benefit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminDbClient = any;

// --- Departments --------------------------------------------------------------------------

export interface CreateDepartmentInput {
  label: string;
  teamValues: string[]; // at least one, already trimmed/non-empty/deduplicated by the caller
  isSharedResource: boolean;
}

export async function createDepartment(
  input: CreateDepartmentInput,
  dbClient: AdminDbClient = supabase
): Promise<AdminWriteResult<DepartmentRecord>> {
  const existingIds = new Set(getAllDepartments().map((d) => d.id));
  const id = generateUniqueId(input.label, existingIds);
  const sortOrder = getNextDepartmentSortOrder();

  const { data: deptRows, error: deptErr } = await dbClient
    .from('departments')
    .insert([{ id, label: input.label, is_shared_resource: input.isSharedResource, is_active: false, sort_order: sortOrder }])
    .select();
  if (deptErr || !deptRows || deptRows.length === 0) {
    return { success: false, error: friendlyUniqueViolation(deptErr, 'department name') || deptErr?.message || 'Failed to create the department.' };
  }

  const teamRows = input.teamValues.map((teamValue, i) => ({ department_id: id, team_value: teamValue, sort_order: i }));
  const { data: teamData, error: teamErr } = await dbClient.from('department_member_teams').insert(teamRows).select();
  if (teamErr || !teamData || teamData.length !== teamRows.length) {
    await dbClient.from('department_member_teams').delete().eq('department_id', id);
    await dbClient.from('departments').delete().eq('id', id);
    return { success: false, error: friendlyUniqueViolation(teamErr, 'team value') || teamErr?.message || 'Failed to save the department\'s team values.' };
  }

  const { data: activated, error: activateErr } = await dbClient
    .from('departments')
    .update({ is_active: true })
    .eq('id', id)
    .select();
  if (activateErr || !activated || activated.length === 0) {
    await dbClient.from('department_member_teams').delete().eq('department_id', id);
    await dbClient.from('departments').delete().eq('id', id);
    return { success: false, error: 'Could not activate the new department after creating it. It has been rolled back — please try again.' };
  }

  return { success: true, data: activated[0] as DepartmentRecord };
}

export interface DeactivationGuard {
  allowed: boolean;
  reason?: string;
  activeCustomRoleCount: number;
  activeEmployeeCount: number;
}

export function checkCanDeactivateDepartment(departmentId: string, users: UserRecord[]): DeactivationGuard {
  const activeCustomRoleCount = countActiveCustomRolesInDepartment(departmentId);
  const teamValues = new Set(getDepartmentMemberTeamsForDepartment(departmentId).map((t) => t.team_value));
  const activeEmployeeCount = users.filter((u) => isActiveEmployee(u) && !!u.team && teamValues.has(u.team)).length;

  if (SEEDED_DEPARTMENT_IDS.has(departmentId)) {
    return { allowed: false, reason: 'This is one of the original seeded departments and cannot be deactivated.', activeCustomRoleCount, activeEmployeeCount };
  }
  if (activeCustomRoleCount > 0 || activeEmployeeCount > 0) {
    return {
      allowed: false,
      reason: `This department still has ${activeCustomRoleCount} active custom role(s) and ${activeEmployeeCount} active employee(s). Reassign or deactivate them first.`,
      activeCustomRoleCount,
      activeEmployeeCount,
    };
  }
  return { allowed: true, activeCustomRoleCount, activeEmployeeCount };
}

export async function deactivateDepartment(
  departmentId: string,
  users: UserRecord[],
  dbClient: AdminDbClient = supabase
): Promise<AdminWriteResult<DepartmentRecord>> {
  const guard = checkCanDeactivateDepartment(departmentId, users);
  if (!guard.allowed) return { success: false, error: guard.reason };

  const { data, error } = await dbClient.from('departments').update({ is_active: false }).eq('id', departmentId).select();
  if (error || !data || data.length === 0) {
    return { success: false, error: error?.message || 'Failed to deactivate the department (no row updated — check permissions).' };
  }
  return { success: true, data: data[0] as DepartmentRecord };
}

// --- Custom roles --------------------------------------------------------------------------

export type PermissionOverrideState = 'inherit' | 'grant' | 'revoke';

export interface CreateCustomRoleInput {
  englishTitle: string;
  arabicTitle?: string | null;
  departmentId: string;
  badgeBg?: string | null;
  badgeText?: string | null;
  defaultModule: AppModuleId;
  allowedModules: AppModuleId[];
  permissionOverrides: Partial<Record<CapabilityKey, PermissionOverrideState>>;
  isActive: boolean;
  createdBy?: string | null;
}

export async function createCustomRole(
  input: CreateCustomRoleInput,
  dbClient: AdminDbClient = supabase
): Promise<AdminWriteResult<CustomRoleRecord>> {
  const existingIds = new Set(getAllCustomRoles().map((r) => r.id));
  const id = generateUniqueId(input.englishTitle, existingIds);
  const existingSlugs = new Set(getAllCustomRoles().map((r) => r.portal_slug));
  const portalSlug = generateUniquePortalSlug(input.englishTitle, existingSlugs);

  // custom_roles.team is set to the department's PRIMARY team value (lowest sort_order) so the
  // Add Employee form can auto-fill Team the same way it already does for a built-in role's
  // canonical team (PR 6 decision 4).
  const deptTeams = getDepartmentMemberTeamsForDepartment(input.departmentId);
  const primaryTeam = deptTeams.length > 0 ? deptTeams.slice().sort((a, b) => a.sort_order - b.sort_order)[0].team_value : null;

  const { data: roleRows, error: roleErr } = await dbClient
    .from('custom_roles')
    .insert([
      {
        id,
        english_title: input.englishTitle,
        arabic_title: input.arabicTitle || null,
        portal_title_en: `${input.englishTitle} Portal`,
        portal_slug: portalSlug,
        team: primaryTeam,
        department_id: input.departmentId,
        badge_bg: input.badgeBg || null,
        badge_text: input.badgeText || null,
        default_module: input.defaultModule,
        is_active: false,
        created_by: input.createdBy || null,
      },
    ])
    .select();
  if (roleErr || !roleRows || roleRows.length === 0) {
    return { success: false, error: friendlyUniqueViolation(roleErr, 'role id or portal slug') || roleErr?.message || 'Failed to create the custom role.' };
  }

  const moduleRows = input.allowedModules.map((m) => ({ role_id: id, module_id: m }));
  if (moduleRows.length > 0) {
    const { data: moduleData, error: moduleErr } = await dbClient.from('custom_role_modules').insert(moduleRows).select();
    if (moduleErr || !moduleData || moduleData.length !== moduleRows.length) {
      await dbClient.from('custom_role_modules').delete().eq('role_id', id);
      await dbClient.from('custom_roles').delete().eq('id', id);
      return { success: false, error: moduleErr?.message || 'Failed to save the role\'s allowed modules.' };
    }
  }

  const overrideRows = Object.entries(input.permissionOverrides)
    .filter(([, state]) => state && state !== 'inherit')
    .map(([key, state]) => ({ role_id: id, permission_key: key, granted: state === 'grant' }));
  if (overrideRows.length > 0) {
    const { data: overrideData, error: overrideErr } = await dbClient.from('custom_role_permissions').insert(overrideRows).select();
    if (overrideErr || !overrideData || overrideData.length !== overrideRows.length) {
      await dbClient.from('custom_role_permissions').delete().eq('role_id', id);
      await dbClient.from('custom_role_modules').delete().eq('role_id', id);
      await dbClient.from('custom_roles').delete().eq('id', id);
      return { success: false, error: overrideErr?.message || 'Failed to save the role\'s permission overrides.' };
    }
  }

  const { data: activated, error: activateErr } = await dbClient
    .from('custom_roles')
    .update({ is_active: input.isActive })
    .eq('id', id)
    .select();
  if (activateErr || !activated || activated.length === 0) {
    await dbClient.from('custom_role_permissions').delete().eq('role_id', id);
    await dbClient.from('custom_role_modules').delete().eq('role_id', id);
    await dbClient.from('custom_roles').delete().eq('id', id);
    return { success: false, error: 'Could not activate the new role after creating it. It has been rolled back — please try again.' };
  }

  return { success: true, data: activated[0] as CustomRoleRecord };
}

export function countActiveEmployeesHoldingRole(roleId: string, users: UserRecord[]): number {
  return users.filter((u) => isActiveEmployee(u) && u.role === roleId).length;
}

// No guard blocks this (unlike a department) — PR 6 decision 6 only requires the caller to show
// the affected-employee count and get an explicit confirmation before calling this; it never
// touches any users row itself.
export async function deactivateCustomRole(roleId: string, dbClient: AdminDbClient = supabase): Promise<AdminWriteResult<CustomRoleRecord>> {
  const { data, error } = await dbClient.from('custom_roles').update({ is_active: false }).eq('id', roleId).select();
  if (error || !data || data.length === 0) {
    return { success: false, error: error?.message || 'Failed to deactivate the role (no row updated — check permissions).' };
  }
  return { success: true, data: data[0] as CustomRoleRecord };
}
