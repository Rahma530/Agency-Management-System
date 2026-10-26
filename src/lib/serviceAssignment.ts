import { ServiceType, UserRecord, UserRole } from '../types/database';
import { isActiveEmployee } from './permissions';

export type AssignableServiceType = Extract<ServiceType, 'seo' | 'media_buying' | 'social_media' | 'interface'>;

export interface ServiceAssignmentConfig {
  serviceType: AssignableServiceType;
  teamLeadRole: UserRole | null;
  agentRoles: readonly UserRole[];
}

export const SERVICE_ASSIGNMENT_CONFIG: Record<AssignableServiceType, ServiceAssignmentConfig> = {
  seo: {
    serviceType: 'seo',
    teamLeadRole: 'seo_team_lead',
    agentRoles: ['seo_agent', 'store_manager', 'seo_content_agent', 'seo_backlink_agent'],
  },
  media_buying: {
    serviceType: 'media_buying',
    teamLeadRole: 'media_buying_team_lead',
    agentRoles: ['media_buying_agent'],
  },
  social_media: {
    serviceType: 'social_media',
    teamLeadRole: 'social_media_team_lead',
    agentRoles: ['social_media_agent'],
  },
  interface: {
    serviceType: 'interface',
    teamLeadRole: null,
    agentRoles: ['ui_ux_designer'],
  },
};

export const getServiceAssignmentConfigForRole = (
  role: UserRole
): ServiceAssignmentConfig | null =>
  Object.values(SERVICE_ASSIGNMENT_CONFIG).find(
    (config) => config.teamLeadRole === role || config.agentRoles.includes(role)
  ) || null;

export const getEligibleServiceAssignees = (
  users: UserRecord[],
  serviceType: AssignableServiceType
): UserRecord[] => {
  const config = SERVICE_ASSIGNMENT_CONFIG[serviceType];
  return users.filter(
    (user) =>
      ((config.teamLeadRole !== null && user.role === config.teamLeadRole) || config.agentRoles.includes(user.role)) &&
      isActiveEmployee(user)
  );
};

// Graphic Designer assignment is deliberately NOT part of SERVICE_ASSIGNMENT_CONFIG/social_media's
// agentRoles: a client can have a social_media_agent AND a graphic_designer assigned at the same
// time (two separate `assignments` rows, both service_type='social_media', distinguished only by
// the assignee's role — see 20261217200000_graphic_designer_social_assignment.sql), whereas the
// config above assumes exactly one agent slot per service. Kept as its own small helper rather than
// folded into the generic config so the "one slot per service" assumption elsewhere (ClientDashboard's
// clientAssignments.find(a => a.service_type === serviceType), handleAssignServiceAgent's `existing`
// lookup) is never accidentally broken by a second role sharing the same service_type.
export const GRAPHIC_DESIGNER_ROLE: UserRole = 'graphic_designer';

export const getEligibleGraphicDesigners = (users: UserRecord[]): UserRecord[] =>
  users.filter((user) => user.role === GRAPHIC_DESIGNER_ROLE && isActiveEmployee(user));

// Per explicit product decision: am_team_lead, executive, head_of_technical, and am_agent (for
// their own client only — checked separately, this only says the ROLE is eligible at all) may
// assign/reassign the Graphic Designer slot. Deliberately excludes social_media_team_lead, who
// keeps managing only the social_media_agent slot via the normal service-assignment card.
const GRAPHIC_DESIGNER_ASSIGNER_ROLES = new Set<UserRole>([
  'am_team_lead',
  'executive',
  'head_of_technical',
  'am_agent',
]);

export const canAssignGraphicDesigner = (role: UserRole): boolean =>
  GRAPHIC_DESIGNER_ASSIGNER_ROLES.has(role);
