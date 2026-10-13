import { registerCustomRoleData, resetCustomRoleDataForTesting } from '../src/data/customRoles';
import { isSelectableReportAgent } from '../src/lib/reportAgentEligibility';
import { DepartmentRecord, CustomRoleRecord, UserRecord } from '../src/types/database';

const failures: string[] = [];

function assertEqual(actual: boolean, expected: boolean, label: string): void {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
}

const department = {
  id: 'seo',
  label: 'SEO',
  is_shared_resource: false,
  is_active: true,
  sort_order: 0,
} as DepartmentRecord;

const reportRole = {
  id: 'seo_report_specialist',
  english_title: 'SEO Report Specialist',
  portal_title_en: 'SEO Report Specialist',
  portal_slug: 'seo-report-specialist',
  team: 'SEO',
  department_id: department.id,
  default_module: 'reports',
  is_active: true,
} as CustomRoleRecord;

const nonReportRole = {
  ...reportRole,
  id: 'seo_no_reports',
  english_title: 'SEO Without Reports',
  portal_slug: 'seo-no-reports',
  default_module: 'my_work',
} as CustomRoleRecord;

const inactiveReportRole = {
  ...reportRole,
  id: 'seo_retired_reporter',
  portal_slug: 'seo-retired-reporter',
  is_active: false,
} as CustomRoleRecord;

const user = (overrides: Partial<UserRecord>): UserRecord =>
  ({
    id: 'target',
    auth_id: 'auth-target',
    name: 'Target',
    email: 'target@example.test',
    role: 'am_agent',
    team: 'Account Management',
    status: 'active',
    deactivated_at: null,
    ...overrides,
  } as UserRecord);

function main(): void {
  registerCustomRoleData(
    [department],
    [reportRole, nonReportRole, inactiveReportRole],
    [
      { role_id: reportRole.id, module_id: 'reports' },
      { role_id: nonReportRole.id, module_id: 'my_work' },
      { role_id: inactiveReportRole.id, module_id: 'reports' },
    ],
    [],
    [],
    []
  );

  const executive = user({ id: 'viewer-exec', role: 'executive' });
  const amLead = user({ id: 'viewer-am-lead', role: 'am_team_lead' });

  assertEqual(isSelectableReportAgent(executive, user({ role: reportRole.id })), true, 'active custom Reports role');
  assertEqual(isSelectableReportAgent(executive, user({ role: nonReportRole.id })), false, 'custom role without Reports');
  assertEqual(isSelectableReportAgent(executive, user({ role: inactiveReportRole.id })), false, 'inactive custom role');
  assertEqual(
    isSelectableReportAgent(executive, user({ role: reportRole.id, deactivated_at: '2026-01-01T00:00:00Z' })),
    false,
    'deactivated employee'
  );
  assertEqual(isSelectableReportAgent(executive, user({ role: reportRole.id, auth_id: null })), false, 'pending employee');
  assertEqual(isSelectableReportAgent(executive, user({ role: 'am_agent' })), true, 'built-in report agent');
  assertEqual(isSelectableReportAgent(executive, user({ role: 'executive' })), false, 'Executive target');
  assertEqual(isSelectableReportAgent(executive, user({ role: 'head_of_technical' })), false, 'leadership target');
  assertEqual(isSelectableReportAgent(executive, user({ role: 'am_team_lead' })), false, 'team-lead target');
  assertEqual(isSelectableReportAgent(amLead, user({ role: 'am_agent' })), true, 'team lead direct report');
  assertEqual(isSelectableReportAgent(amLead, user({ role: 'seo_agent' })), false, 'team lead cross-team agent');
  assertEqual(isSelectableReportAgent(amLead, user({ role: reportRole.id })), false, 'team lead custom role not inferred as direct report');

  resetCustomRoleDataForTesting();
  if (failures.length) {
    console.error('Found report-agent eligibility regression(s):\n');
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
  }
  console.log('OK: report agent eligibility handles built-in/custom roles, active state, and team-lead scope.');
}

main();
