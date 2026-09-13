import { ServiceType, UserRecord, UserRole } from '../types/database';

// contract_value is financial/commercial data: full visibility stays with the roles who own the
// client relationship end-to-end (leadership + AM), everyone else never sees it — except sales,
// who entered the figure themselves at registration and may see it only for their own clients
// (sales_owner_id === them), never anyone else's. isOwnClient is the caller's job to compute
// (e.g. client.sales_owner_id === currentUser.id) since this function has no client in scope.
const CONTRACT_VALUE_ROLES: UserRole[] = ['executive', 'head_of_technical', 'am_team_lead', 'am_agent'];

export const canSeeContractValue = (role: UserRole, isOwnClient: boolean): boolean => {
  if (CONTRACT_VALUE_ROLES.includes(role)) return true;
  if (role === 'sales' && isOwnClient) return true;
  return false;
};

// An employee created via the "Add Employee" admin flow (single form or bulk upload) starts with
// auth_id null — a real Supabase Auth account hasn't been provisioned for them yet (that only
// happens out-of-band via scripts/provisionAuthUsers.ts, since it needs the service-role key).
// Until then they can't log in at all, so every picker/list that lets someone assign real work to
// an employee (task assignee, AM assignment, brief routing, campaign ownership, the demo-login
// list, etc.) or that aggregates an employee's performance/capacity must exclude them — otherwise
// work silently piles up on someone who can never see or act on it. Lookups that just resolve an
// existing reference's display name (e.g. "who submitted this brief") are unaffected; a pending
// employee can never actually be set as one of those references in the first place, since every
// picker feeding them is filtered here too.
export const isPendingEmployee = (user: Pick<UserRecord, 'auth_id'>): boolean => !user.auth_id;

// A deactivated employee (users.deactivated_at set) is the opposite lifecycle end from pending:
// they DID have a working account, but have been permanently shut off — their row stays (so their
// name still displays correctly on every historical task/brief/daily-log/report they're
// referenced from), their auth.users account is banned out-of-band by
// scripts/deactivateAuthUser.ts, and every picker/list that isPendingEmployee() already excludes
// them from must exclude a deactivated employee too, for the same reason: work must never pile up
// on someone who can no longer act on it.
export const isDeactivatedEmployee = (user: Pick<UserRecord, 'deactivated_at'>): boolean => !!user.deactivated_at;

// The single check every "assignable/active employee" picker or list should use instead of
// isPendingEmployee() alone — covers both ends of the lifecycle a working employee isn't at.
export const isActiveEmployee = (user: Pick<UserRecord, 'auth_id' | 'deactivated_at'>): boolean =>
  !isPendingEmployee(user) && !isDeactivatedEmployee(user);

// The 4 department team leads + am_team_lead — every role with "team_lead" reach over a specific
// department's own employees (distinct from executive/head_of_technical's org-wide reach).
export const DEPARTMENT_TEAM_LEAD_ROLES: UserRole[] = [
  'am_team_lead',
  'seo_team_lead',
  'media_buying_team_lead',
  'social_media_team_lead',
];

// Employee edit/deactivate and client hard-delete both share this exact access rule: leadership,
// or a team lead acting on their own department (RLS's employee_visible()/client visibility rules
// narrow a team lead's actual reach further — this is just the role-level gate).
export const canManageEmployeesOrClients = (role: UserRole): boolean =>
  role === 'executive' || role === 'head_of_technical' || DEPARTMENT_TEAM_LEAD_ROLES.includes(role);

// Global brief field schema (brief_field_schemas) write access: executive/head_of_technical/
// am_team_lead/am_agent unconditionally (this branch already covers 'creative' — there is no
// dedicated "creative team lead" role in this app; creative resources are pooled under
// am_team_lead's oversight elsewhere), plus each department team lead scoped to only their own
// service_type.
export const canEditBriefFieldSchema = (role: UserRole, serviceType: ServiceType): boolean => {
  if (role === 'executive' || role === 'head_of_technical' || role === 'am_team_lead' || role === 'am_agent') {
    return true;
  }
  if (role === 'seo_team_lead') return serviceType === 'seo';
  if (role === 'media_buying_team_lead') return serviceType === 'media_buying';
  if (role === 'social_media_team_lead') return serviceType === 'social_media';
  return false;
};
