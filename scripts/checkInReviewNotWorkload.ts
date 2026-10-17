// Regression check for the "in_review is not workload" owner decisions — see
// supabase/migrations/20261112000000_in_review_not_workload.sql's own header comment for the
// full list. Covers the pure-JS mirrors of those decisions: isTaskWorkloadOpen/
// isTaskOverdueForAssignee (src/lib/employeeWork.ts) and resolveDailyWorkCapacityLimit
// (src/lib/capacity.ts). The DB trigger/function side (delivered_at/revision_count tracking,
// get_user_schedule_load's status filters) is covered separately by
// supabase/verification/20261112000000_in_review_not_workload_tests.sql — nothing in this file
// touches a database.
import { isTaskWorkloadOpen, isTaskOverdueForAssignee } from '../src/lib/employeeWork';
import { resolveDailyWorkCapacityLimit, resolveCapacityLimit } from '../src/lib/capacity';
import { MAX_TASKS_PER_DAY } from '../src/config/designerScheduling';
import { UserRecord } from '../src/types/database';

const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function makeUser(overrides: Partial<UserRecord>): UserRecord {
  return {
    id: 'u1',
    name: 'Test User',
    email: 'test@example.com',
    role: 'graphic_designer',
    team: 'Creative & Design',
    auth_id: 'auth-1',
    deactivated_at: null,
    capacity_limit: null,
    ...overrides,
  } as UserRecord;
}

function main(): void {
  // ------------------------------------------------------------------------
  // isTaskWorkloadOpen — todo/in_progress/blocked only; in_review/completed/closed are NOT.
  // ------------------------------------------------------------------------
  assertEqual(isTaskWorkloadOpen('todo'), true, 'todo is workload-open');
  assertEqual(isTaskWorkloadOpen('in_progress'), true, 'in_progress is workload-open');
  assertEqual(isTaskWorkloadOpen('blocked'), true, 'blocked is workload-open');
  assertEqual(isTaskWorkloadOpen('in_review'), false, 'in_review is NOT workload-open (delivered, waiting on the client)');
  assertEqual(isTaskWorkloadOpen('completed'), false, 'completed is NOT workload-open');
  assertEqual(isTaskWorkloadOpen('closed'), false, 'closed is NOT workload-open');

  // ------------------------------------------------------------------------
  // isTaskOverdueForAssignee — workload-open AND past due AND never revised.
  // ------------------------------------------------------------------------
  const today = '2026-10-16';

  // Plain overdue todo task — the ordinary case.
  assertEqual(
    isTaskOverdueForAssignee({ status: 'todo', due_date: '2026-10-10', revision_count: 0 }, today),
    true,
    'an overdue todo task with no revisions is Overdue'
  );

  // in_review, however overdue its due_date, is never Overdue — decision 1.
  assertEqual(
    isTaskOverdueForAssignee({ status: 'in_review', due_date: '2026-10-10', revision_count: 0 }, today),
    false,
    'an overdue in_review task is never Overdue — delivered, waiting on the client'
  );

  // A revision (revision_count > 0) is workload again, but never Overdue even past its due_date
  // — decision 2. Covers both todo and in_progress, the two statuses a revision can be in.
  assertEqual(
    isTaskOverdueForAssignee({ status: 'todo', due_date: '2026-10-10', revision_count: 1 }, today),
    false,
    'an overdue revision (todo, revision_count 1) is never Overdue'
  );
  assertEqual(
    isTaskOverdueForAssignee({ status: 'in_progress', due_date: '2026-10-10', revision_count: 2 }, today),
    false,
    'an overdue revision (in_progress, revision_count 2) is never Overdue'
  );

  // completed/closed are done, not Overdue, regardless of revision_count or due_date — same as
  // the pre-existing isTaskOverdue rule.
  assertEqual(
    isTaskOverdueForAssignee({ status: 'completed', due_date: '2026-10-10', revision_count: 0 }, today),
    false,
    'a completed task is never Overdue'
  );

  // Not yet due, or no due_date at all — never Overdue regardless of status/revision_count.
  assertEqual(
    isTaskOverdueForAssignee({ status: 'todo', due_date: '2026-10-20', revision_count: 0 }, today),
    false,
    'a todo task not yet due is not Overdue'
  );
  assertEqual(
    isTaskOverdueForAssignee({ status: 'todo', due_date: null, revision_count: 0 }, today),
    false,
    'a task with no due_date is never Overdue'
  );

  // revision_count omitted (undefined) must be treated as 0, not throw and not suppress Overdue
  // — real rows written before this migration have no such guarantee from the type system alone.
  assertEqual(
    isTaskOverdueForAssignee({ status: 'todo', due_date: '2026-10-10' } as any, today),
    true,
    'a missing revision_count is treated as 0 (still Overdue if genuinely overdue)'
  );

  // ------------------------------------------------------------------------
  // resolveDailyWorkCapacityLimit — 6 for the three creative roles (when capacity_limit is
  // unset), resolveCapacityLimit's own default (8) for every other role, unchanged. An
  // explicitly admin-set capacity_limit always wins over either default.
  // ------------------------------------------------------------------------
  assertEqual(
    resolveDailyWorkCapacityLimit(makeUser({ role: 'graphic_designer', capacity_limit: null })),
    MAX_TASKS_PER_DAY,
    'graphic_designer with no explicit capacity_limit defaults to MAX_TASKS_PER_DAY (6)'
  );
  assertEqual(
    resolveDailyWorkCapacityLimit(makeUser({ role: 'video_editor', capacity_limit: null })),
    MAX_TASKS_PER_DAY,
    'video_editor with no explicit capacity_limit defaults to 6'
  );
  assertEqual(
    resolveDailyWorkCapacityLimit(makeUser({ role: 'ui_ux_designer', capacity_limit: null })),
    MAX_TASKS_PER_DAY,
    'ui_ux_designer with no explicit capacity_limit defaults to 6'
  );
  assertEqual(
    resolveDailyWorkCapacityLimit(makeUser({ role: 'seo_agent', capacity_limit: null })),
    resolveCapacityLimit(makeUser({ role: 'seo_agent', capacity_limit: null })),
    'a non-creative role is unchanged — still resolveCapacityLimit()\'s own default (8)'
  );
  assertEqual(
    resolveDailyWorkCapacityLimit(makeUser({ role: 'graphic_designer', capacity_limit: 10 })),
    10,
    'an explicitly admin-set capacity_limit wins over the creative-role default of 6'
  );

  if (failures.length) {
    console.error('Found in-review/not-workload regression(s):\n');
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
  }
  console.log('OK: in_review is never workload/Overdue, a revision is workload but never Overdue, and the creative-role daily capacity default is 6.');
}

main();
