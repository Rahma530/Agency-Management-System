import { useMemo } from 'react';
import { UserRecord, UserRole } from '../types/database';
import { isActiveEmployee } from './permissions';
import { supabaseRaw } from './supabase';
import {
  getCombinedTeamValuesFromCache,
  getOperationalTeamValuesFromCache,
  isCustomRoleCacheLoaded,
} from '../data/customRoles';

// Was `(typeof OPERATIONAL_TEAMS)[number]`, a closed literal union, back when OPERATIONAL_TEAMS
// was a static tuple. Now that getOperationalTeams() returns a plain (database-sourced) string[],
// there is no fixed set of literals left to union — this alias exists only so TaskTypeManager.tsx's
// existing `(team: OperationalTeam) =>` annotation keeps compiling unchanged.
export type OperationalTeam = string;

// FALLBACK ONLY — the real source of truth, once the custom-roles cache has loaded (PR 5), is the
// department_member_teams table via getOperationalTeams() below. This literal array exists solely
// as what getOperationalTeams() returns before that cache has loaded (first paint, or a fetch
// failure) and is never read directly by anything else — it is NOT exported. Keep it as the exact
// list the old module-level OPERATIONAL_TEAMS constant held, so built-in behavior is byte-for-byte
// identical during that window. AI Engineering was deliberately excluded when this list was first
// built, on the reasoning that it wasn't a department a staffing picker would ever target — that's
// since been reversed: ai_engineer is a real, task-assigned operational role and needs to be
// selectable the same way every other department is. Executive, Technical, Sales, and Marketing
// remain excluded — those still aren't staffing-picker targets, the same reason
// CrossTeamTaskBoard's isOperationalAssignee excludes executive/head_of_technical from task
// assignment.
const FALLBACK_OPERATIONAL_TEAMS = [
  'SEO',
  'Social Media',
  'Media Buying',
  'Creative & Design',
  'Video Production',
  'Programming',
  'Account Management',
  'AI Engineering',
] as const;

// FALLBACK ONLY, same reasoning as FALLBACK_OPERATIONAL_TEAMS above — Creative & Design
// (graphic_designer) and Video Production (video_editor) are two distinct UserRecord.team values
// that CapacityManagement.tsx already treats as one combined staffing bucket; this mirrors that
// pairing for the pre-cache-load window.
const FALLBACK_COMBINED_DEPARTMENT_TEAMS: Partial<Record<string, string[]>> = {
  'Creative & Design': ['Creative & Design', 'Video Production'],
};

// The operational departments assignable via a Team/Department dropdown that's paired with an
// employee/assignee picker (task assignment, campaign ownership, new-hire team, Task Board's Team
// filter). This is the single shared list — every department dropdown that pairs with an employee
// picker (including an "All Teams"/"all" catch-all where relevant, added separately by the caller
// — this array is real departments only) should call this function rather than hardcoding its own
// copy. Deliberately a FUNCTION, not a module-level constant: the underlying data
// (department_member_teams, via data/customRoles.ts) only loads asynchronously after app bootstrap,
// so a module-level `const` evaluated at import time would freeze in whatever was true (nothing)
// before that fetch ever ran. Call this at render time instead, every time the list is needed.
// Before the cache has loaded (or if the fetch never succeeds), or if a successful load
// unexpectedly yields zero departments, returns the exact hardcoded fallback above — built-in
// behavior never changes because of this.
export function getOperationalTeams(): string[] {
  if (!isCustomRoleCacheLoaded()) return [...FALLBACK_OPERATIONAL_TEAMS];
  const live = getOperationalTeamValuesFromCache();
  return live.length > 0 ? live : [...FALLBACK_OPERATIONAL_TEAMS];
}

// Same function-not-constant reasoning as getOperationalTeams() above. Only ever contains an
// entry for a department's PRIMARY team (lowest sort_order, ties broken by team_value) when that
// department has 2+ teams — getCombinedTeamValuesFromCache(team) returns a single-element array
// for every other team (a single-team department, or a non-primary team of a multi-team one),
// which this filters out, matching today's hardcoded shape exactly: only
// {'Creative & Design': ['Creative & Design', 'Video Production']}, never a 'Video Production'
// entry and never a single-entry entry for every other department.
export function getCombinedDepartmentTeams(): Partial<Record<string, string[]>> {
  if (!isCustomRoleCacheLoaded()) return FALLBACK_COMBINED_DEPARTMENT_TEAMS;
  const live = getOperationalTeamValuesFromCache();
  if (live.length === 0) return FALLBACK_COMBINED_DEPARTMENT_TEAMS;
  const combined: Partial<Record<string, string[]>> = {};
  for (const team of live) {
    const expanded = getCombinedTeamValuesFromCache(team);
    if (expanded.length > 1) combined[team] = expanded;
  }
  return combined;
}

const teamsForDepartment = (department: string): string[] =>
  getCombinedDepartmentTeams()[department] || [department];

// The single shared filter every department-scoped employee dropdown in the app should call: given
// the currently-selected department/team value, return only the active employees who actually
// belong to it. Pass null/undefined/'' for "nothing selected yet" — returns an empty list rather
// than everyone, which is the whole point of this fix (a department dropdown paired with an
// employee dropdown must never leak every employee regardless of the department chosen).
export const getEmployeesByDepartment = (
  users: UserRecord[],
  department: string | null | undefined
): UserRecord[] => {
  if (!department) return [];
  const teams = teamsForDepartment(department);
  return users.filter((u) => isActiveEmployee(u) && !!u.team && teams.includes(u.team));
};

// React hook wrapper for components that want this memoized against their users/department state.
export const useEmployeesByDepartment = (
  users: UserRecord[],
  department: string | null | undefined
): UserRecord[] => useMemo(() => getEmployeesByDepartment(users, department), [users, department]);

// The shape returned by the assignable_employees() RPC below — deliberately narrower than
// UserRecord. It exists because getEmployeesByDepartment()/useEmployeesByDepartment() above only
// ever see whatever's in the caller's OWN locally-fetched `users` array, which is scoped by
// users_select_rls (employee_visible()) to that viewer's own visibility — for most roles that's
// far narrower than "every employee in every department" (e.g. an am_agent's visible users are
// just themselves, other am_agent/am_team_lead, and the shared graphic_designer/video_editor
// pool). A department-scoped picker that needs to reach OUTSIDE the viewer's own department (task
// assignment, campaign ownership) can't rely on that local array — it calls fetchAssignableEmployees
// below instead. Only these five columns: never email, password, manager_id, auth_id, or
// deactivated_at — see the assignable_employees() migration for why.
export interface AssignableEmployee {
  id: string;
  name: string;
  role: UserRole;
  team: string | null;
  capacity_limit: number | null;
}

// Calls the assignable_employees(p_department) SECURITY DEFINER RPC, which bypasses
// users_select_rls entirely and returns only active, non-executive/head_of_technical employees
// in the given department (with the same Creative & Design/Video Production combined bucket as
// getEmployeesByDepartment above, applied server-side). Returns [] for a falsy department without
// making a request, same "nothing selected yet" contract as getEmployeesByDepartment.
export const fetchAssignableEmployees = async (
  department: string | null | undefined
): Promise<AssignableEmployee[]> => {
  if (!department) return [];
  const { data, error } = await supabaseRaw.rpc('assignable_employees', { p_department: department });
  if (error) {
    console.error('Failed to load assignable employees:', error);
    return [];
  }
  return (data as AssignableEmployee[]) || [];
};
