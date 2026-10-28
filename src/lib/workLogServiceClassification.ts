import type { ServiceType, UserRole } from '../types/database';

// Maps a work-log author's role to one of the client's subscribed ServiceType categories, for
// grouping a CLIENT-scope report's PDF export by service (ReportDraftWorkspace.tsx /
// pdfExport.ts). Deliberately a NEW, narrower mapping rather than reusing
// serviceAssignment.ts's SERVICE_ASSIGNMENT_CONFIG as-is: that config answers a different
// question (task-assignment ELIGIBILITY — who may be assigned a service's tasks) and only covers
// 4 of the 6 ServiceType values (its AssignableServiceType omits 'creation' and 'branding'
// entirely). This mapping needs full BuiltInRole coverage for exactly one purpose: "which service
// did this daily-log entry's author do that work for."
//
// Known, accepted limitation: 'branding' has no reliable mapping here, and neither does a single
// real ServiceType for graphic_designer/video_editor — per BuiltInRole's own comments
// (types/database.ts), they're an explicitly SHARED creative resource pool with no dedicated
// owning team, producing both social-media creatives and branding/identity deliverables, so
// guessing either ServiceType would misclassify real work more often than a grouping feature
// should. Their work logs get the dedicated 'creative' bucket below instead (CREATIVE_BUCKET_LABEL,
// pdfExport.ts) — its own sub-heading, separate from any real client-subscribed service. Any other
// role not listed below — am_team_lead/am_agent/sales/executive/head_of_technical/ai_engineer/
// marketing_manager, or any admin-created custom role — still falls into the fully-uncategorized
// "Other updates" bucket in the exported PDF/HTML instead of being forced into the wrong section.
const ROLE_TO_SERVICE: Partial<Record<UserRole, ServiceType>> = {
  seo_team_lead: 'seo',
  seo_agent: 'seo',
  store_manager: 'seo', // identical treatment to seo_agent everywhere else in this codebase
  seo_content_agent: 'seo',
  seo_backlink_agent: 'seo',
  media_buying_team_lead: 'media_buying',
  media_buying_agent: 'media_buying',
  social_media_team_lead: 'social_media',
  social_media_agent: 'social_media',
  ui_ux_designer: 'interface',
  programming_agent: 'creation',
};

// Roles mapped to the dedicated 'creative' bucket rather than ROLE_TO_SERVICE above — see this
// file's top comment for why they can't safely share a real ServiceType mapping.
const CREATIVE_POOL_ROLES = new Set<UserRole>(['graphic_designer', 'video_editor']);

export function classifyWorkLogService(role: UserRole | undefined): ServiceType | 'creative' | null {
  if (!role) return null;
  if (CREATIVE_POOL_ROLES.has(role)) return 'creative';
  return ROLE_TO_SERVICE[role] || null;
}
