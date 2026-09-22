import { useMemo } from 'react';
import { UserRecord, UserRole } from '../types/database';
import { isActiveEmployee } from './permissions';
import { supabaseRaw } from './supabase';

// The operational departments assignable via a Team/Department dropdown that's paired with an
// employee/assignee picker (task assignment, campaign ownership, new-hire team, Task Board's Team
// filter). AI Engineering was deliberately excluded when this list was first built, on the
// reasoning that it wasn't a department a staffing picker would ever target — that's since been
// reversed: ai_engineer is a real, task-assigned operational role (Rahma Ehab et al.) and needs to
// be selectable the same way every other department is. Executive, Technical, Sales, and Marketing
// remain excluded — those still aren't staffing-picker targets, the same reason
// CrossTeamTaskBoard's isOperationalAssignee excludes executive/head_of_technical from task
// assignment. This is the single shared list — every department dropdown that pairs with an
// employee picker (including an "All Teams"/"all" catch-all where relevant, added separately by
// the caller — this array is real departments only) should render its options from this array
// rather than hardcoding its own copy.
export const OPERATIONAL_TEAMS = [
  'SEO',
  'Social Media',
  'Media Buying',
  'Creative & Design',
  'Video Production',
  'Programming',
  'Account Management',
  'AI Engineering',
] as const;

export type OperationalTeam = (typeof OPERATIONAL_TEAMS)[number];

// Creative & Design (graphic_designer) and Video Production (video_editor) are two distinct
// UserRecord.team values, but CapacityManagement.tsx already treats them as one combined staffing
// bucket when a department filter is set to "Creative & Design" — mirrored here rather than
// re-deriving the pairing a second time in every consumer.
const COMBINED_DEPARTMENT_TEAMS: Partial<Record<string, string[]>> = {
  'Creative & Design': ['Creative & Design', 'Video Production'],
};

const teamsForDepartment = (department: string): string[] =>
  COMBINED_DEPARTMENT_TEAMS[department] || [department];

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
