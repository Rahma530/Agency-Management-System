import { registerCustomRoleData, resetCustomRoleDataForTesting } from '../src/data/customRoles';
import { isEligibleReportSubject, isSelectableReportAgent } from '../src/lib/reportAgentEligibility';
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

const creativeDepartment = {
  id: 'creative_design',
  label: 'Creative & Design',
  is_shared_resource: true,
  is_active: true,
  sort_order: 1,
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

const creativeCustomRole = {
  ...reportRole,
  id: 'ui_designer',
  english_title: 'UI Designer',
  portal_slug: 'ui-designer',
  department_id: creativeDepartment.id,
  default_module: 'my_work',
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
    [department, creativeDepartment],
    [reportRole, nonReportRole, inactiveReportRole, creativeCustomRole],
    [
      { role_id: reportRole.id, module_id: 'reports' },
      { role_id: nonReportRole.id, module_id: 'my_work' },
      { role_id: inactiveReportRole.id, module_id: 'reports' },
      { role_id: creativeCustomRole.id, module_id: 'my_work' },
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
  assertEqual(isSelectableReportAgent(executive, user({ role: 'graphic_designer' })), true, 'graphic designer subject');
  assertEqual(isSelectableReportAgent(executive, user({ role: 'video_editor' })), true, 'video editor subject');
  assertEqual(isSelectableReportAgent(executive, user({ role: creativeCustomRole.id })), true, 'shared Creative custom-role subject');
  assertEqual(isSelectableReportAgent(executive, user({ role: 'executive' })), false, 'Executive target');
  assertEqual(isSelectableReportAgent(executive, user({ role: 'head_of_technical' })), false, 'leadership target');
  assertEqual(isSelectableReportAgent(executive, user({ role: 'am_team_lead' })), true, 'global viewer can select a team-lead target');
  assertEqual(isSelectableReportAgent(executive, user({ role: 'seo_team_lead' })), true, 'global viewer can select any team-lead target');
  assertEqual(isSelectableReportAgent(amLead, user({ role: 'am_agent' })), true, 'team lead direct report');
  assertEqual(isSelectableReportAgent(amLead, user({ role: 'seo_agent' })), false, 'team lead cross-team agent');
  assertEqual(isSelectableReportAgent(amLead, user({ role: 'graphic_designer' })), false, 'team lead picker is not widened to Creative');
  assertEqual(isSelectableReportAgent(amLead, user({ role: reportRole.id })), false, 'team lead custom role not inferred as direct report');
  assertEqual(isSelectableReportAgent(amLead, { ...amLead }), true, 'team lead can self-select');
  assertEqual(
    isSelectableReportAgent(amLead, user({ id: 'viewer-seo-lead', role: 'seo_team_lead' })),
    false,
    'team lead cannot select a PEER team lead (self-select only)'
  );
  assertEqual(isEligibleReportSubject(user({ role: 'am_agent' })), true, 'ordinary agent subject');
  assertEqual(isEligibleReportSubject(user({ role: reportRole.id })), true, 'custom Reports subject');
  assertEqual(isEligibleReportSubject(user({ role: creativeCustomRole.id })), true, 'custom Creative subject without Reports module');
  assertEqual(isEligibleReportSubject(user({ role: 'executive' })), false, 'Executive is not an employee-report subject');
  assertEqual(isEligibleReportSubject(user({ role: 'am_team_lead' })), true, 'built-in team lead is an eligible subject for a global viewer');

  resetCustomRoleDataForTesting();
  if (failures.length) {
    console.error('Found report-agent eligibility regression(s):\n');
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
  }
  console.log('OK: report agent eligibility handles built-in/custom roles, active state, and team-lead scope.');
}

main();
