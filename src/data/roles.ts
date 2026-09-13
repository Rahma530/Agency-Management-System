import { UserRole } from '../types/database';

export type AppModuleId = 'onboarding' | 'service_briefs' | 'capacity' | 'tasks' | 'daily_operations' | 'campaigns';

export interface RoleMetadata {
  role: UserRole;
  englishTitle: string;
  arabicTitle: string;
  portalTitleEn: string;
  portalTitleAr: string;
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
    arabicTitle: 'الإدارة التنفيذية العليا',
    portalTitleEn: 'Executive Portal',
    portalTitleAr: 'بوابة الإدارة التنفيذية',
    portalSlug: 'executive',
    team: 'Executive',
    department: 'Executive Board',
    badgeBg: 'rgba(216, 180, 254, 0.2)',
    badgeText: '#e9d5ff',
    defaultModule: 'capacity',
    allowedModules: ['capacity', 'tasks', 'campaigns'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: true,
    canAssignAM: true,
    description: 'Strategic oversight, operational capacity monitoring, and organization-wide performance.',
  },
  head_of_technical: {
    role: 'head_of_technical',
    englishTitle: 'Head of Technical',
    arabicTitle: 'رئيس القسم الفني والعمليات',
    portalTitleEn: 'Head of Technical Portal',
    portalTitleAr: 'بوابة الإدارة الفنية',
    portalSlug: 'head-of-technical',
    team: 'Technical',
    department: 'Technical & Operations',
    badgeBg: 'rgba(123, 47, 247, 0.25)',
    badgeText: '#c084fc',
    defaultModule: 'capacity',
    allowedModules: ['capacity', 'tasks', 'daily_operations', 'campaigns'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: true,
    canAssignAM: true,
    description: 'Cross-functional technical leadership, workflow tracking, and team capacity.',
  },
  marketing_manager: {
    role: 'marketing_manager',
    englishTitle: 'Marketing Manager',
    arabicTitle: 'مدير التسويق',
    portalTitleEn: 'Marketing Manager Portal',
    portalTitleAr: 'بوابة مدير التسويق',
    portalSlug: 'marketing-manager',
    team: 'Marketing',
    department: 'Marketing',
    badgeBg: 'rgba(20, 184, 166, 0.2)',
    badgeText: '#2dd4bf',
    defaultModule: 'tasks',
    allowedModules: ['tasks', 'capacity'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Cross-cutting visibility into the Creative task pipeline (Graphic Design & Video Production): can view and assign Creative tasks and view Creative capacity, without managing the shared Creative pool or its employees.',
  },
  sales: {
    role: 'sales',
    englishTitle: 'Sales Representative',
    arabicTitle: 'فريق المبيعات',
    portalTitleEn: 'Sales Portal',
    portalTitleAr: 'بوابة المبيعات',
    portalSlug: 'sales',
    team: 'Sales',
    department: 'Sales & Business Development',
    badgeBg: 'rgba(245, 226, 154, 0.2)',
    badgeText: 'var(--roas-mid)',
    defaultModule: 'onboarding',
    allowedModules: ['onboarding'],
    canRegisterClients: true,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: true,
    description: 'Client registration, agreement setup, handoff to Account Management, and personal pipeline.',
  },
  am_team_lead: {
    role: 'am_team_lead',
    englishTitle: 'AM Team Leader',
    arabicTitle: 'قائد فريق إدارة الحسابات',
    portalTitleEn: 'AM Team Leader Portal',
    portalTitleAr: 'بوابة قيادة إدارة الحسابات',
    portalSlug: 'am-team-lead',
    team: 'Account Management',
    department: 'Account Management',
    badgeBg: 'rgba(123, 47, 247, 0.2)',
    badgeText: 'var(--purple-light)',
    defaultModule: 'onboarding',
    allowedModules: ['onboarding', 'capacity', 'tasks', 'campaigns'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: true,
    canAssignAM: true,
    description: 'Client onboarding queue, Account Manager assignments, brief reviews, and client health.',
  },
  am_agent: {
    role: 'am_agent',
    englishTitle: 'Account Manager (AM)',
    arabicTitle: 'أخصائي إدارة الحسابات',
    portalTitleEn: 'Account Manager Portal',
    portalTitleAr: 'بوابة مدير الحساب',
    portalSlug: 'am-agent',
    team: 'Account Management',
    department: 'Account Management',
    badgeBg: 'rgba(168, 155, 184, 0.15)',
    badgeText: 'var(--lilac)',
    defaultModule: 'onboarding',
    allowedModules: ['onboarding', 'tasks', 'campaigns'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Assigned client onboarding, dynamic service briefs, and client communication.',
  },
  media_buying_team_lead: {
    role: 'media_buying_team_lead',
    englishTitle: 'Media Buying Team Leader',
    arabicTitle: 'قائد فريق الإعلانات الممولة',
    portalTitleEn: 'Media Buying Lead Portal',
    portalTitleAr: 'بوابة قيادة الميديا باينج',
    portalSlug: 'media-buying-team-lead',
    team: 'Media Buying',
    department: 'Paid Media',
    badgeBg: 'rgba(14, 165, 233, 0.2)',
    badgeText: '#38bdf8',
    defaultModule: 'campaigns',
    allowedModules: ['campaigns', 'onboarding', 'daily_operations', 'tasks', 'capacity'],
    canRegisterClients: false,
    canCreateCampaign: true,
    canManageCapacity: true,
    canAssignAM: false,
    description: 'Full campaign management, budget allocation, team ROAS optimization, and client briefs.',
  },
  media_buying_agent: {
    role: 'media_buying_agent',
    englishTitle: 'Media Buying Specialist',
    arabicTitle: 'أخصائي إعلانات ممولة',
    portalTitleEn: 'Media Buying Specialist Portal',
    portalTitleAr: 'بوابة أخصائي الميديا باينج',
    portalSlug: 'media-buying-agent',
    team: 'Media Buying',
    department: 'Paid Media',
    badgeBg: 'rgba(14, 165, 233, 0.15)',
    badgeText: '#7dd3fc',
    defaultModule: 'campaigns',
    allowedModules: ['campaigns', 'onboarding', 'daily_operations', 'tasks'],
    canRegisterClients: false,
    canCreateCampaign: true,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Operational campaign management for assigned clients, ad spend tracking, and conversion APIs.',
  },
  seo_team_lead: {
    role: 'seo_team_lead',
    englishTitle: 'SEO Team Leader',
    arabicTitle: 'قائد فريق تحسين محركات البحث',
    portalTitleEn: 'SEO Team Leader Portal',
    portalTitleAr: 'بوابة قيادة السيو',
    portalSlug: 'seo-team-lead',
    team: 'SEO',
    department: 'Organic Search (SEO)',
    badgeBg: 'rgba(16, 185, 129, 0.2)',
    badgeText: '#34d399',
    defaultModule: 'onboarding',
    allowedModules: ['onboarding', 'daily_operations', 'tasks', 'capacity'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: true,
    canAssignAM: false,
    description: 'SEO strategy, keyword audits, multi-service onboarding reviews, and team task distribution.',
  },
  seo_agent: {
    role: 'seo_agent',
    englishTitle: 'SEO Specialist',
    arabicTitle: 'أخصائي تحسين محركات البحث',
    portalTitleEn: 'SEO Specialist Portal',
    portalTitleAr: 'بوابة أخصائي السيو',
    portalSlug: 'seo-agent',
    team: 'SEO',
    department: 'Organic Search (SEO)',
    badgeBg: 'rgba(168, 185, 129, 0.15)',
    badgeText: '#6ee7b7',
    defaultModule: 'daily_operations',
    allowedModules: ['daily_operations', 'onboarding', 'tasks'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'On-page audits, backlink execution, technical SEO tasks, and daily logs.',
  },
  social_media_team_lead: {
    role: 'social_media_team_lead',
    englishTitle: 'Social Media Team Leader',
    arabicTitle: 'قائد فريق السوشيال ميديا',
    portalTitleEn: 'Social Media Lead Portal',
    portalTitleAr: 'بوابة قيادة السوشيال ميديا',
    portalSlug: 'social-media-team-lead',
    team: 'Social Media',
    department: 'Social Media & Content',
    badgeBg: 'rgba(236, 72, 153, 0.2)',
    badgeText: '#f472b6',
    defaultModule: 'onboarding',
    allowedModules: ['onboarding', 'daily_operations', 'tasks', 'capacity'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: true,
    canAssignAM: false,
    description: 'Content calendar approvals, multi-service client brief reviews, and publishing workflows.',
  },
  social_media_agent: {
    role: 'social_media_agent',
    englishTitle: 'Social Media Specialist',
    arabicTitle: 'أخصائي سوشيال ميديا ومحتوى',
    portalTitleEn: 'Social Media Specialist Portal',
    portalTitleAr: 'بوابة أخصائي السوشيال ميديا',
    portalSlug: 'social-media-agent',
    team: 'Social Media',
    department: 'Social Media & Content',
    badgeBg: 'rgba(236, 72, 153, 0.15)',
    badgeText: '#fbcfe8',
    defaultModule: 'daily_operations',
    allowedModules: ['daily_operations', 'onboarding', 'tasks'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Copywriting, content scheduling, community engagement, and assigned tasks.',
  },
  graphic_designer: {
    role: 'graphic_designer',
    englishTitle: 'Graphic Designer',
    arabicTitle: 'مصمم جرافيك',
    portalTitleEn: 'Graphic Designer Portal',
    portalTitleAr: 'بوابة مصمم الجرافيك',
    portalSlug: 'graphic-designer',
    team: 'Creative & Design',
    department: 'Creative & Visual Design',
    badgeBg: 'rgba(249, 115, 22, 0.2)',
    badgeText: '#fb923c',
    defaultModule: 'daily_operations',
    allowedModules: ['daily_operations', 'onboarding', 'tasks'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Brand identity, ad creative assets, and cross-team design deliverables.',
  },
  video_editor: {
    role: 'video_editor',
    englishTitle: 'Video Editor',
    arabicTitle: 'محرر ومونتير فيديو',
    portalTitleEn: 'Video Editor Portal',
    portalTitleAr: 'بوابة محرر الفيديو',
    portalSlug: 'video-editor',
    team: 'Video Production',
    department: 'Video Production',
    badgeBg: 'rgba(239, 68, 68, 0.2)',
    badgeText: '#f87171',
    defaultModule: 'daily_operations',
    allowedModules: ['daily_operations', 'onboarding', 'tasks'],
    canRegisterClients: false,
    canCreateCampaign: false,
    canManageCapacity: false,
    canAssignAM: false,
    description: 'Video production, motion graphics, and short-form video ads.',
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
