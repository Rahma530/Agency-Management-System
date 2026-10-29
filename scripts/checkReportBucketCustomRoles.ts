// Regression check for the fix in 20261223000000_report_bucket_custom_roles.sql /
// src/lib/workLogServiceClassification.ts: a custom role (public.custom_roles,
// data/customRoles.ts) must classify via its OWN department instead of always falling into
// "Other updates" — see that migration's own header for the two symptoms this caused (a mislabeled
// section, and entries silently dropped by a narrowed bucket filter).
import { registerCustomRoleData, resetCustomRoleDataForTesting } from '../src/data/customRoles';
import { classifyWorkLogService } from '../src/lib/workLogServiceClassification';
import { DepartmentRecord, CustomRoleRecord } from '../src/types/database';

const failures: string[] = [];

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const dept = (id: string, isShared = false): DepartmentRecord =>
  ({ id, label: id, is_shared_resource: isShared, is_active: true, sort_order: 0 } as DepartmentRecord);

const role = (id: string, departmentId: string): CustomRoleRecord =>
  ({
    id,
    english_title: id,
    portal_title_en: id,
    portal_slug: id.replace(/_/g, '-'),
    department_id: departmentId,
    default_module: 'my_work',
    is_active: true,
  } as CustomRoleRecord);

function main(): void {
  registerCustomRoleData(
    [dept('seo'), dept('media_buying'), dept('social_media'), dept('creative_design', true), dept('programming'), dept('account_management')],
    [
      role('seo_junior_specialist', 'seo'),
      role('media_buying_junior', 'media_buying'),
      role('social_media_junior', 'social_media'),
      role('creative_junior', 'creative_design'),
      role('programming_junior', 'programming'),
      role('am_junior', 'account_management'),
    ],
    [],
    [],
    [],
    []
  );

  assertEqual(classifyWorkLogService('seo_junior_specialist'), 'seo', 'custom SEO role classifies as seo');
  assertEqual(classifyWorkLogService('media_buying_junior'), 'media_buying', 'custom Media Buying role classifies as media_buying');
  assertEqual(classifyWorkLogService('social_media_junior'), 'social_media', 'custom Social Media role classifies as social_media');
  assertEqual(classifyWorkLogService('creative_junior'), 'creative', 'custom Creative & Design role classifies as creative');
  assertEqual(classifyWorkLogService('programming_junior'), null, 'custom Programming role has no service bucket (falls to Other updates)');
  assertEqual(classifyWorkLogService('am_junior'), null, 'custom Account Management role has no service bucket (falls to Other updates)');
  assertEqual(classifyWorkLogService('totally_unknown_role'), null, 'a role matching no built-in and no registered custom role stays null');

  // A built-in role must still classify exactly as before — the custom-role lookup is a fallback,
  // never consulted when ROLE_TO_SERVICE already has a confident answer.
  assertEqual(classifyWorkLogService('seo_agent'), 'seo', 'built-in seo_agent is unaffected by the custom-role fallback');
  assertEqual(classifyWorkLogService('graphic_designer'), 'creative', 'built-in graphic_designer is unaffected by the custom-role fallback');

  resetCustomRoleDataForTesting();
  assertEqual(classifyWorkLogService('seo_junior_specialist'), null, 'a custom role resolves to null (fail-closed) before the cache has loaded');

  if (failures.length > 0) {
    console.error('checkReportBucketCustomRoles FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('checkReportBucketCustomRoles: all scenarios passed.');
}

main();
