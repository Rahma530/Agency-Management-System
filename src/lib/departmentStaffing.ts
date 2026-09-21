import { useMemo } from 'react';
import { UserRecord } from '../types/database';
import { isActiveEmployee } from './permissions';

// The operational departments assignable via a Team/Department dropdown that's paired with an
// employee/assignee picker (task assignment, campaign ownership, new-hire team). Deliberately
// excludes the non-operational team values that also exist on UserRecord.team (Executive,
// Technical, Sales, AI Engineering, Marketing) — those roles are never the target of a
// department-scoped staffing picker, the same reason CrossTeamTaskBoard's isOperationalAssignee
// already excludes executive/head_of_technical from task assignment. This is the single shared
// list — every department dropdown that pairs with an employee picker should render its options
// from this array rather than hardcoding its own copy.
export const OPERATIONAL_TEAMS = [
  'SEO',
  'Social Media',
  'Media Buying',
  'Creative & Design',
  'Video Production',
  'Programming',
  'Account Management',
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
