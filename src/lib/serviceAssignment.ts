import { ServiceType, UserRecord, UserRole } from '../types/database';
import { isActiveEmployee } from './permissions';

export type AssignableServiceType = Extract<ServiceType, 'seo' | 'media_buying' | 'social_media'>;

export interface ServiceAssignmentConfig {
  serviceType: AssignableServiceType;
  teamLeadRole: UserRole;
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
      (user.role === config.teamLeadRole || config.agentRoles.includes(user.role)) &&
      isActiveEmployee(user)
  );
};
