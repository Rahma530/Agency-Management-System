import type { ServiceType, UserRole } from '../types/database';
import { isBuiltInRole } from '../data/roles';
import { getCustomRoleDepartmentId } from '../data/customRoles';

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

// An admin-created CUSTOM role (data/customRoles.ts, 20261101400000_custom_roles_departments_
// foundation.sql) has no entry in ROLE_TO_SERVICE above — it is never a BuiltInRole string, so it
// used to always fall through to the fully-uncategorized "Other updates" bucket, regardless of
// which real department it was actually created under. That misclassified every custom-role
// employee's work logs under whichever client they worked on. Mirrors
// reportingEngine.ts's getDepartmentMappedServiceType (same department ids, same reasoning for
// what's left unmapped), plus the department ids are seeded by
// 20261101400000_custom_roles_departments_foundation.sql — 'creative_design' is this app's one
// other shared-resource pool, so it gets the same 'creative' bucket graphic_designer/video_editor
// do rather than a guessed ServiceType. 'programming'/'account_management'/'ai_engineering' stay
// unmapped (null -> 'other') on purpose: a custom role there has no single client-facing service
// to attribute a work log to, same as their built-in counterparts (am_agent, ai_engineer) do today.
const DEPARTMENT_ID_TO_BUCKET: Partial<Record<string, ServiceType | 'creative'>> = {
  seo: 'seo',
  media_buying: 'media_buying',
  social_media: 'social_media',
  creative_design: 'creative',
};

export function classifyWorkLogService(role: UserRole | undefined): ServiceType | 'creative' | null {
  if (!role) return null;
  if (CREATIVE_POOL_ROLES.has(role)) return 'creative';
  const builtIn = ROLE_TO_SERVICE[role];
  if (builtIn) return builtIn;
  if (isBuiltInRole(role)) return null;
  const departmentId = getCustomRoleDepartmentId(role);
  return (departmentId && DEPARTMENT_ID_TO_BUCKET[departmentId]) || null;
}
