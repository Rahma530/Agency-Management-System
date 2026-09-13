import { UserRole } from '../types/database';

export type AppModuleId = 'onboarding' | 'service_briefs' | 'capacity' | 'tasks' | 'daily_operations' | 'campaigns' | 'reports' | 'dashboard' | 'my_work' | 'employees';

export interface RoleMetadata {
  role: UserRole;
  englishTitle: string;
  portalTitleEn: string;
  portalSlug: string;
  team: string;
  department: string;
  badgeBg: string;
  badgeText: string;
  defaultModule: AppModuleId;
  allowedModules: AppModuleId[];
  description: string;
  canRegisterClients?: boolean;
  canCreateCampaign?: boolean;
  canManageCapacity?: boolean;
  canAssignAM?: boolean;
}

export const AGENCY_ROLES: Record<UserRole, RoleMetadata> = {
  executive: {
    role: 'executive',
    englishTitle: 'Executive Management (C-Level)',
    portalTitleEn: 'Executive Portal',
    portalSlug: 'executive',
    team: 'Executive',
    department: 'Executive Board',
    badgeBg: 'rgba(216, 180, 254, 0.2)',
    badgeText: '#e9d5ff',
    defaultModule: 'dashboard',
    allowedModules: ['dashboard', 'capacity', 'tasks', 'campaigns', 'reports', 'employees'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: true,
    canAssignAM: true,
    description: 'Strategic oversight, operational capacity monitoring, and organization-wide performance.',
  },
  head_of_technical: {
    role: 'head_of_technical',
    englishTitle: 'Head of Technical',
    portalTitleEn: 'Head of Technical Portal',
    portalSlug: 'head-of-technical',
    team: 'Technical',
    department: 'Technical & Operations',
    badgeBg: 'rgba(123, 47, 247, 0.25)',
    badgeText: '#c084fc',
    defaultModule: 'dashboard',
    allowedModules: ['dashboard', 'capacity', 'tasks', 'daily_operations', 'campaigns', 'reports', 'employees'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: true,
    canAssignAM: true,
    description: 'Cross-functional technical leadership, workflow tracking, and team capacity.',
  },
  sales: {
    role: 'sales',
    englishTitle: 'Sales Representative',
    portalTitleEn: 'Sales Portal',
    portalSlug: 'sales',
    team: 'Sales',
    department: 'Sales & Business Development',
    badgeBg: 'rgba(245, 226, 154, 0.2)',
    badgeText: 'var(--roas-mid)',
    defaultModule: 'my_work',
    allowedModules: ['my_work', 'onboarding'],
    canRegisterClients: true,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: true,
    description: 'Client registration, agreement setup, handoff to Account Management, and personal pipeline.',
  },
  am_team_lead: {
    role: 'am_team_lead',
    englishTitle: 'AM Team Leader',
    portalTitleEn: 'AM Team Leader Portal',
    portalSlug: 'am-team-lead',
    team: 'Account Management',
    department: 'Account Management',
    badgeBg: 'rgba(123, 47, 247, 0.2)',
    badgeText: 'var(--purple-light)',
    defaultModule: 'dashboard',
    allowedModules: ['dashboard', 'my_work', 'onboarding', 'service_briefs', 'capacity', 'tasks', 'campaigns', 'reports', 'employees'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: true,
    canAssignAM: true,
    description: 'Client onboarding queue, Account Manager assignments, brief reviews, and client health.',
  },
  am_agent: {
    role: 'am_agent',
    englishTitle: 'Account Manager (AM)',
    portalTitleEn: 'Account Manager Portal',
    portalSlug: 'am-agent',
    team: 'Account Management',
    department: 'Account Management',
    badgeBg: 'rgba(168, 155, 184, 0.15)',
    badgeText: 'var(--lilac)',
    defaultModule: 'my_work',
    allowedModules: ['my_work', 'onboarding', 'service_briefs', 'tasks', 'campaigns', 'reports'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Assigned client onboarding, dynamic service briefs, and client communication.',
  },
  media_buying_team_lead: {
    role: 'media_buying_team_lead',
    englishTitle: 'Media Buying Team Leader',
    portalTitleEn: 'Media Buying Lead Portal',
    portalSlug: 'media-buying-team-lead',
    team: 'Media Buying',
    department: 'Paid Media',
    badgeBg: 'rgba(14, 165, 233, 0.2)',
    badgeText: '#38bdf8',
    defaultModule: 'dashboard',
    allowedModules: ['dashboard', 'my_work', 'campaigns', 'onboarding', 'service_briefs', 'daily_operations', 'tasks', 'capacity', 'reports', 'employees'],
    canRegisterClients: false,
    canCreateCampaign: true,
    canManageCapacity: true,
    canAssignAM: false,
    description: 'Full campaign management, budget allocation, team ROAS optimization, and client briefs.',
  },
  media_buying_agent: {
    role: 'media_buying_agent',
    englishTitle: 'Media Buying Specialist',
    portalTitleEn: 'Media Buying Specialist Portal',
    portalSlug: 'media-buying-agent',
    team: 'Media Buying',
    department: 'Paid Media',
    badgeBg: 'rgba(14, 165, 233, 0.15)',
    badgeText: '#7dd3fc',
    defaultModule: 'my_work',
    allowedModules: ['my_work', 'campaigns', 'onboarding', 'service_briefs', 'daily_operations', 'tasks', 'reports'],
    canRegisterClients: false,
    canCreateCampaign: true,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Operational campaign management for assigned clients, ad spend tracking, and conversion APIs.',
  },
  seo_team_lead: {
    role: 'seo_team_lead',
    englishTitle: 'SEO Team Leader',
    portalTitleEn: 'SEO Team Leader Portal',
    portalSlug: 'seo-team-lead',
    team: 'SEO',
    department: 'Organic Search (SEO)',
    badgeBg: 'rgba(16, 185, 129, 0.2)',
    badgeText: '#34d399',
    defaultModule: 'dashboard',
    allowedModules: ['dashboard', 'my_work', 'onboarding', 'service_briefs', 'daily_operations', 'tasks', 'capacity', 'reports', 'employees'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: true,
    canAssignAM: false,
    description: 'SEO strategy, keyword audits, multi-service onboarding reviews, and team task distribution.',
  },
  seo_agent: {
    role: 'seo_agent',
    englishTitle: 'SEO Specialist',
    portalTitleEn: 'SEO Specialist Portal',
    portalSlug: 'seo-agent',
    team: 'SEO',
    department: 'Organic Search (SEO)',
    badgeBg: 'rgba(168, 185, 129, 0.15)',
    badgeText: '#6ee7b7',
    defaultModule: 'my_work',
    allowedModules: ['my_work', 'daily_operations', 'onboarding', 'service_briefs', 'tasks', 'reports'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'On-page audits, backlink execution, technical SEO tasks, and daily logs.',
  },
  // Structurally like graphic_designer/video_editor (no dedicated team lead, task-based work
  // with no service_type/assignments relationship to clients) — but exclusively owned by
  // seo_team_lead's oversight rather than shared across every team lead the way the creative
  // pool is. allowedModules mirrors graphic_designer/video_editor for that reason, not seo_agent:
  // service_briefs and reports are both built around a service_type this role doesn't have.
  programming_agent: {
    role: 'programming_agent',
    englishTitle: 'Programming Specialist',
    portalTitleEn: 'Programming Specialist Portal',
    portalSlug: 'programming-agent',
    team: 'Programming',
    department: 'Programming',
    badgeBg: 'rgba(99, 102, 241, 0.2)',
    badgeText: '#818cf8',
    defaultModule: 'my_work',
    allowedModules: ['my_work', 'daily_operations', 'onboarding', 'tasks'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Website/platform development tasks and technical implementation, under SEO Team Lead oversight.',
  },
  social_media_team_lead: {
    role: 'social_media_team_lead',
    englishTitle: 'Social Media Team Leader',
    portalTitleEn: 'Social Media Lead Portal',
    portalSlug: 'social-media-team-lead',
    team: 'Social Media',
    department: 'Social Media & Content',
    badgeBg: 'rgba(236, 72, 153, 0.2)',
    badgeText: '#f472b6',
    defaultModule: 'dashboard',
    allowedModules: ['dashboard', 'my_work', 'onboarding', 'service_briefs', 'daily_operations', 'tasks', 'capacity', 'reports', 'employees'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: true,
    canAssignAM: false,
    description: 'Content calendar approvals, multi-service client brief reviews, and publishing workflows.',
  },
  social_media_agent: {
    role: 'social_media_agent',
    englishTitle: 'Social Media Specialist',
    portalTitleEn: 'Social Media Specialist Portal',
    portalSlug: 'social-media-agent',
    team: 'Social Media',
    department: 'Social Media & Content',
    badgeBg: 'rgba(236, 72, 153, 0.15)',
    badgeText: '#fbcfe8',
    defaultModule: 'my_work',
    allowedModules: ['my_work', 'daily_operations', 'onboarding', 'service_briefs', 'tasks', 'reports'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Copywriting, content scheduling, community engagement, and assigned tasks.',
  },
  graphic_designer: {
    role: 'graphic_designer',
    englishTitle: 'Graphic Designer',
    portalTitleEn: 'Graphic Designer Portal',
    portalSlug: 'graphic-designer',
    team: 'Creative & Design',
    department: 'Creative & Visual Design',
    badgeBg: 'rgba(249, 115, 22, 0.2)',
    badgeText: '#fb923c',
    defaultModule: 'my_work',
    allowedModules: ['my_work', 'daily_operations', 'onboarding', 'tasks'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Brand identity, ad creative assets, and cross-team design deliverables.',
  },
  video_editor: {
    role: 'video_editor',
    englishTitle: 'Video Editor',
    portalTitleEn: 'Video Editor Portal',
    portalSlug: 'video-editor',
    team: 'Video Production',
    department: 'Video Production',
    badgeBg: 'rgba(239, 68, 68, 0.2)',
    badgeText: '#f87171',
    defaultModule: 'my_work',
    allowedModules: ['my_work', 'daily_operations', 'onboarding', 'tasks'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Video production, motion graphics, and short-form video ads.',
  },
  ai_engineer: {
    role: 'ai_engineer',
    englishTitle: 'AI Engineer',
    portalTitleEn: 'AI Engineer Portal',
    portalSlug: 'ai-engineer',
    team: 'AI Engineering',
    department: 'AI & Automation',
    badgeBg: 'rgba(45, 212, 191, 0.2)',
    badgeText: '#2dd4bf',
    defaultModule: 'my_work',
    allowedModules: ['my_work', 'tasks', 'daily_operations'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'AI-assisted automation, internal tooling, and technical support across cross-team task delivery.',
  },
  // NOT a team lead of graphic_designer/video_editor — that shared pool keeps its existing
  // "no dedicated manager, visible to everyone but sales" model untouched. This role is a narrow,
  // cross-cutting exception: visibility into and task-assignment rights over ONLY those two
  // roles' tasks, plus read-only capacity visibility for the same two — no employee-management
  // rights (no 'employees' module, never added to any edit/deactivate-capable list). Lands
  // directly on the Task Board (pre-filtered to Creative) rather than a dashboard, since they
  // have no clients/employees of their own to manage — a TeamLeadDashboard-style landing would be
  // mostly empty for them.
  marketing_manager: {
    role: 'marketing_manager',
    englishTitle: 'Marketing Manager',
    portalTitleEn: 'Marketing Manager Portal',
    portalSlug: 'marketing-manager',
    team: 'Marketing',
    department: 'Marketing',
    badgeBg: 'rgba(217, 70, 239, 0.2)',
    badgeText: '#e879f9',
    defaultModule: 'tasks',
    allowedModules: ['tasks', 'capacity'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Cross-cutting oversight of the shared Creative pool (Graphic Design & Video Production) — task assignment and read-only capacity visibility only.',
  },
};

export const getRoleInfo = (role?: UserRole): RoleMetadata => {
  if (!role || !AGENCY_ROLES[role]) {
    return AGENCY_ROLES.executive;
  }
  return AGENCY_ROLES[role];
};

export const isModuleAllowed = (role?: UserRole, moduleId?: AppModuleId): boolean => {
  if (!role || !moduleId) return false;
  const meta = getRoleInfo(role);
  return meta.allowedModules.includes(moduleId);
};

export const getPortalSlug = (role?: UserRole): string => {
  const meta = getRoleInfo(role);
  return meta.portalSlug;
};

export const getRoleFromSlug = (slug: string): UserRole | null => {
  const entry = Object.values(AGENCY_ROLES).find((r) => r.portalSlug === slug);
  return entry ? entry.role : null;
};
