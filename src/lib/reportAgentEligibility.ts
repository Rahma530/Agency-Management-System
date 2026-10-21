import { TEAM_LEAD_TO_AGENT_ROLE } from '../data/roles';
import { isModuleAllowed } from '../data/roles';
import { isSharedResourceCustomRole } from '../data/customRoles';
import { UserRecord, UserRole } from '../types/database';
import { isActiveEmployee } from './permissions';
import { isEmployeeAccessibleUnderRLS } from './supabase';

// Organization-wide report viewers may choose an agent, but they are not themselves agent
// candidates. Keeping this separate from report-module eligibility is intentional: having the
// Reports module says what the TARGET can use, while this set says which VIEWERS have the existing
// organization-wide picker. Neither check grants database access; RLS remains authoritative.
// ai_engineer was removed from this set at the owner's explicit request (part of the broader
// ai_engineer de-privileging pass — see permissions.ts's header comment): it is now an ordinary
// report SUBJECT like any other reports-enabled agent (governed by isEligibleReportSubject below),
// not a global viewer with its own agent picker.
export const GLOBAL_REPORT_AGENT_PICKER_ROLES = new Set<UserRole>([
  'executive',
  'head_of_technical',
]);

export function canSelectAnyReportAgent(role: UserRole): boolean {
  return GLOBAL_REPORT_AGENT_PICKER_ROLES.has(role);
}

export function isCreativeReportSubject(target: Pick<UserRecord, 'role'>): boolean {
  return target.role === 'graphic_designer' ||
    target.role === 'video_editor' ||
    isSharedResourceCustomRole(target.role);
}

export function isEligibleReportSubject(target: UserRecord): boolean {
  if (!isActiveEmployee(target)) return false;
  if (GLOBAL_REPORT_AGENT_PICKER_ROLES.has(target.role)) return false;
  // Subject eligibility is not the same as module access. Creative employees are report subjects
  // for an already-authorized global viewer even though their own portals deliberately do not
  // expose Reports. This never grants the target access to Reports or widens the viewer's RLS.
  if (isCreativeReportSubject(target)) return true;
  // Built-in team leads (am_team_lead/media_buying_team_lead/seo_team_lead/social_media_team_lead)
  // are deliberately allowed here: a global viewer (executive/head_of_technical) can
  // pull a team lead's own report, same as any other reports-enabled role. This only widens who a
  // GLOBAL viewer may pick; a team-lead VIEWER's own picker is governed separately below, in
  // isSelectableReportAgent, and still only grants that team lead their fixed direct-report roles
  // plus themselves.
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
    // A team lead may always pull their own report (self-selection), in addition to their
    // existing, deliberately fixed direct-report mapping. This does not extend to a PEER team
    // lead (another team lead is not in directReportRoles and does not match viewer.id) — that
    // is a separate, not-yet-requested widening.
    if (target.id === viewer.id) return true;
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
