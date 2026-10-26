import { ServiceType, UserRecord, UserRole } from '../types/database';
import { isActiveEmployee } from './permissions';

export type AssignableServiceType = Extract<
  ServiceType,
  'seo' | 'media_buying' | 'social_media' | 'interface' | 'graphic_design'
>;

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
  // Standalone service (per explicit product decision — a client can need design work without
  // being subscribed to Social Media), modeled exactly like 'interface': no dedicated team lead
  // (graphic_designer is a shared-resource-pool role, deliberately excluded from
  // TEAM_LEAD_TO_AGENT_ROLE — see src/data/roles.ts), one agent slot, reassignable. Being its own
  // service_type (not piggybacking on social_media) means the normal one-row-per-(client,
  // service_type) assumption everywhere else (ClientDashboard's clientAssignments.find, this
  // file's getEligibleServiceAssignees, handleAssignServiceAgent's `existing` lookup) just works
  // unmodified — no special-casing needed, unlike the earlier social_media-based design.
  graphic_design: {
    serviceType: 'graphic_design',
    teamLeadRole: null,
    agentRoles: ['graphic_designer'],
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

// Who may assign/reassign the Graphic Design service specifically — per explicit product
// decision, a WIDER set than canManageServiceAssignments (executive/head_of_technical only, used
// by the other 4 services' generic card): am_team_lead and am_agent (for their own client only —
// checked separately by the caller, this only says the ROLE is eligible at all) also get this one
// service's assignment control. Deliberately excludes social_media_team_lead and every other
// department team lead — this is specifically an AM-facing capability for Graphic Design, not a
// general widening of who manages service assignments.
const GRAPHIC_DESIGN_ASSIGNER_ROLES = new Set<UserRole>([
  'am_team_lead',
  'executive',
  'head_of_technical',
  'am_agent',
]);

export const canAssignGraphicDesignSpecialist = (role: UserRole): boolean =>
  GRAPHIC_DESIGN_ASSIGNER_ROLES.has(role);
