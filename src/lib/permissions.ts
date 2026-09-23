import { BriefRecord, ClientRecord, ServiceType, UserRecord, UserRole } from '../types/database';

const CLIENT_REGISTRATION_ROLES: UserRole[] = [
  'executive',
  'head_of_technical',
  'sales',
  'am_team_lead',
  'am_agent',
];

export const canRegisterClient = (role: UserRole): boolean => CLIENT_REGISTRATION_ROLES.includes(role);

// Temporary portal preview is available only to an authenticated leadership account.
export const canUseEmployeeTestingMode = (role: UserRole): boolean =>
  role === 'executive' || role === 'head_of_technical';

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

// Shared gate for the client's phone number AND the "Client Access" tab (portal/platform login
// credentials, ad account access notes, payment card details tied to those ad accounts) — both
// are PII/credential-grade data restricted to the roles that own the client relationship
// end-to-end: Executive, Head of Technical, AM Team Leader, AM Agent. Deliberately excludes every
// department team lead/agent and sales (unlike CONTRACT_VALUE_ROLES above, sales never sees
// either of these, even for their own client). One shared list/check since both surfaces use the
// identical role set — do not fork this into two checks.
const CLIENT_SENSITIVE_INFO_ROLES: UserRole[] = ['executive', 'head_of_technical', 'am_team_lead', 'am_agent'];

export const canAccessClientSensitiveInfo = (role: UserRole): boolean =>
  CLIENT_SENSITIVE_INFO_ROLES.includes(role);

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

// Who can access the "Client Onboarding" sidebar tab at all: sales sees SalesPortalView there,
// every other role in this list sees AMQueue's onboarding & reassignment queue. Shared by both
// App.tsx's sidebar nav visibility and AMQueue's own "Access Restricted" gate, so a role that
// isn't authorized never even sees the nav item in the first place — previously the nav item was
// shown to every role whose roles.ts allowedModules happened to include 'onboarding' (nearly
// everyone), while AMQueue's actual check only ever allowed these five, so most roles saw the nav
// item highlighted and active but landed on "Access Restricted" when they clicked it.
const CLIENT_ONBOARDING_ROLES: UserRole[] = [
  'executive',
  'head_of_technical',
  'sales',
  'am_team_lead',
  'am_agent',
];

export const canAccessClientOnboarding = (role?: UserRole): boolean =>
  !!role && CLIENT_ONBOARDING_ROLES.includes(role);

// Service Brief CONTENT (the actual filled-in answers on a specific client's brief — Target
// Website URL, Target Keywords, CMS Platform, etc.), as distinct from canEditBriefFieldSchema
// below (which governs the QUESTIONS themselves, not the answers). Brief content is captured
// during the AM's discovery meeting and belongs to Account Management + leadership only:
// executive/head_of_technical/am_team_lead unconditionally, am_agent scoped to their own assigned
// client. Every department team lead/agent (SEO/Media Buying/Social Media) — previously able to
// edit their own department's brief content — is view-only now; they keep full view access via
// ClientDashboard's separate hasBriefViewAccess check, which this does not affect. Mirrors
// briefs_update_rls/briefs_write_rls exactly — see those migrations for the DB-level twin of this
// check.
export const canEditServiceBrief = (
  role: UserRole,
  userId: string,
  client: Pick<ClientRecord, 'am_agent_id'>
): boolean => {
  if (role === 'executive' || role === 'head_of_technical' || role === 'am_team_lead') return true;
  if (role === 'am_agent') return client.am_agent_id === userId;
  return false;
};

// CapacityManagement.tsx's "إدارة العملاء"/"إدارة الموظفين" buttons — deliberately separate from
// canManageEmployeesOrClients above, which already has two different, real consumers
// (EmployeeAdminHub.tsx's edit/deactivate rights, ClientDashboard.tsx's hard-delete rights) with a
// broader role set (all four department team leads). These two buttons need narrower, asymmetric
// role sets of their own: client management includes only AM Team Leader among team leads, and
// employee management excludes every team lead entirely. Both buttons are visibility-only checks
// today — clicking either opens ImportDataModal, whose onImport handler is a no-op simulation, not
// a real client/employee write path (a separate, already-flagged incomplete-feature gap, not
// something either of these functions needs to account for).
export const canManageClientsFromCapacity = (role?: UserRole): boolean =>
  role === 'executive' || role === 'head_of_technical' || role === 'am_team_lead';

export const canManageEmployeesFromCapacity = (role?: UserRole): boolean =>
  role === 'executive' || role === 'head_of_technical';

// Whether `role` may see a SPECIFIC brief's actual field content — distinct from whether the
// Service Briefs tab/screen is reachable at all (that's hasBriefViewAccess in ClientDashboard.tsx
// and the role-based routing in ServiceBriefsRoutingView.tsx). AM/leadership author the brief, so
// there's nothing to gate for them. Every other role that's otherwise eligible for brief access
// must wait for brief.submitted_at — before that, it's a private AM-in-progress draft, invisible
// even if the surrounding tab is already reachable. Mirrors briefs_select_rls's own
// "and submitted_at is not null" condition on the department team-lead/agent branches — that RLS
// check is the real security boundary; this is the matching UI-layer check for correct
// empty-state rendering. Deliberately NOT scoped by the viewer's own department/service: a
// submitted brief stays visible to every role hasBriefViewAccess already allows onto the tab,
// exactly as broad as before this change — only the WHEN changed, not the WHICH.
const BRIEF_CONTENT_ALWAYS_VISIBLE_ROLES: UserRole[] = ['executive', 'head_of_technical', 'am_team_lead', 'am_agent'];

export const canViewBriefContent = (
  role: UserRole,
  brief: Pick<BriefRecord, 'submitted_at'> | undefined
): boolean => {
  if (BRIEF_CONTENT_ALWAYS_VISIBLE_ROLES.includes(role)) return true;
  return !!brief?.submitted_at;
};

// Global brief field schema (brief_field_schemas) write access: executive/head_of_technical/
// am_team_lead/am_agent unconditionally (including interface briefs, which have no dedicated
// service team lead), plus each department team lead scoped to only their own
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
