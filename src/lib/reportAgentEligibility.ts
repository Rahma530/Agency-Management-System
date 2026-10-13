import { TEAM_LEAD_TO_AGENT_ROLE } from '../data/roles';
import { isModuleAllowed } from '../data/roles';
import { UserRecord, UserRole } from '../types/database';
import { isActiveEmployee } from './permissions';
import { isEmployeeAccessibleUnderRLS } from './supabase';

// Organization-wide report viewers may choose an agent, but they are not themselves agent
// candidates. Keeping this separate from report-module eligibility is intentional: having the
// Reports module says what the TARGET can use, while this set says which VIEWERS have the existing
// organization-wide picker. Neither check grants database access; RLS remains authoritative.
export const GLOBAL_REPORT_AGENT_PICKER_ROLES = new Set<UserRole>([
  'executive',
  'head_of_technical',
  'ai_engineer',
]);

export function canSelectAnyReportAgent(role: UserRole): boolean {
  return GLOBAL_REPORT_AGENT_PICKER_ROLES.has(role);
}

export function isEligibleReportSubject(target: UserRecord): boolean {
  if (!isActiveEmployee(target)) return false;
  if (GLOBAL_REPORT_AGENT_PICKER_ROLES.has(target.role)) return false;
  if (Object.prototype.hasOwnProperty.call(TEAM_LEAD_TO_AGENT_ROLE, target.role)) return false;
  return isModuleAllowed(target.role, 'reports');
}

export function isSelectableReportAgent(
  viewer: Pick<UserRecord, 'id' | 'role'>,
  target: UserRecord
): boolean {
  if (!isActiveEmployee(target)) return false;
  if (!isEmployeeAccessibleUnderRLS(viewer, target)) return false;

  const directReportRoles = TEAM_LEAD_TO_AGENT_ROLE[viewer.role];
  if (directReportRoles) {
    // Preserve the current, deliberately fixed direct-report mapping for built-in team leads.
    // A custom role is not silently treated as their direct report merely because it can open
    // Reports; that relationship needs an explicit server-backed model before it can widen.
    return directReportRoles.includes(target.role);
  }

  if (!canSelectAnyReportAgent(viewer.role)) return false;

  // Leadership/global-picker roles and built-in team leads are report viewers, not selectable
  // agents. Active custom roles are accepted here when their real cached module configuration
  // grants Reports, rather than being dropped because they are absent from AGENCY_ROLES.
  return isEligibleReportSubject(target);
}
