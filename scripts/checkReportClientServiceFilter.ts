// Guards the per-service CLIENT-scope report filter (20261125000000_report_client_service_filter.sql
// + reportAgentEligibility.ts's getReportClientServiceLock). The database itself cannot be unit
// tested from this static script — this only proves the client-side lock/choice classification
// used for the Reports screen's picker matches the exact role split the product owner confirmed:
//   - Choice roles (free pick of one service, or "All services"): executive, head_of_technical,
//     am_team_lead, am_agent, and all three department team leads.
//   - Locked-to-one-service roles: the five SEO agent-level roles -> 'seo',
//     media_buying_agent -> 'media_buying', social_media_agent -> 'social_media'.
//   - Everything else that could ever reach client-scope report access (creative/tech roles, any
//     future/custom role) -> 'own_entries' (locked to just the caller's own work-log rows).
import { getReportClientServiceLock } from '../src/lib/reportAgentEligibility';
import { UserRole } from '../src/types/database';

const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const CHOICE_ROLES: UserRole[] = [
  'executive',
  'head_of_technical',
  'am_team_lead',
  'am_agent',
  'seo_team_lead',
  'media_buying_team_lead',
  'social_media_team_lead',
];

const LOCKED_TO_SERVICE: Array<[UserRole, string]> = [
  ['seo_agent', 'seo'],
  ['store_manager', 'seo'],
  ['seo_content_agent', 'seo'],
  ['seo_backlink_agent', 'seo'],
  ['media_buying_agent', 'media_buying'],
  ['social_media_agent', 'social_media'],
];

// No reliable service classification at all -> locked to just the caller's own entries.
const LOCKED_TO_OWN_ENTRIES: UserRole[] = ['graphic_designer', 'video_editor', 'sales', 'marketing_manager'];

// classifyWorkLogService DOES map these two (for PDF-section grouping), even though neither role
// has a report_scope_accessible branch today and so cannot actually reach client-scope reports yet.
// getReportClientServiceLock follows that classification regardless, so this documents today's
// real return value rather than asserting 'own_entries' for roles classifyWorkLogService maps.
const CLASSIFIED_BUT_NOT_CHOICE: Array<[UserRole, string]> = [
  ['ui_ux_designer', 'interface'],
  ['programming_agent', 'creation'],
];

function main(): void {
  for (const role of CHOICE_ROLES) {
    assertEqual(getReportClientServiceLock(role), 'choice', `${role} should get the full Choice picker`);
  }
  for (const [role, service] of LOCKED_TO_SERVICE) {
    assertEqual(getReportClientServiceLock(role), service, `${role} should be locked to '${service}'`);
  }
  for (const role of LOCKED_TO_OWN_ENTRIES) {
    assertEqual(getReportClientServiceLock(role), 'own_entries', `${role} has no classifiable service`);
  }
  for (const [role, service] of CLASSIFIED_BUT_NOT_CHOICE) {
    assertEqual(getReportClientServiceLock(role), service, `${role} classifies to '${service}' (PDF-grouping parity)`);
  }
  assertEqual(getReportClientServiceLock(undefined), 'own_entries', 'an unresolved role is never widened to Choice or a guessed service');

  if (failures.length) {
    console.error('Found report client-service-filter regression(s):\n');
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
  }
  console.log('OK: report client-service-filter lock matches Choice/Locked-to-service/Locked-to-own-entries exactly as confirmed.');
}

main();
