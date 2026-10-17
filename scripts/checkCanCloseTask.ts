// Regression check for canCloseTask() (src/lib/taskLifecycle.ts) — the Close Task UI gate must
// match task_closable() (supabase/migrations/20261104000000_task_visibility_functions.sql), the
// function tasks_update_rls's own server-side closing check calls
// (20261104100000_task_visibility_cutover.sql): the creator, ANY current assignee (every row in
// task_assignees, not only the legacy single assigned_to column), or an admin role
// (executive/head_of_technical/ai_engineer) may close a task. Everyone else — including a role
// that can see or even edit a task through some other door (sales, marketing_manager) — may not.
//
// Run via `npm run lint` (chained after tsc --noEmit) or directly:
// `npx tsx scripts/checkCanCloseTask.ts`.
import { canCloseTask } from '../src/lib/taskLifecycle';
import { TaskAssigneeRecord, TaskRecord, UserRecord } from '../src/types/database';

const failures: string[] = [];

function assertEqual(actual: boolean, expected: boolean, label: string): void {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
}

// One task: created by 'creator1', legacy assigned_to = 'primary1' (the oldest/first assignee —
// set_task_assignees' reverse trigger keeps this in sync with task_assignees going forward), with
// task_assignees carrying BOTH 'primary1' and a later, non-primary co-assignee 'co1'. 'removed1'
// is deliberately NOT a row here, simulating someone set_task_assignees has since dropped from the
// list — canCloseTask must judge CURRENT membership only, never anyone's past presence.
const task = {
  id: 'task-1',
  created_by: 'creator1',
  assigned_to: 'primary1',
} as Pick<TaskRecord, 'id' | 'created_by' | 'assigned_to'>;

const taskAssignees = [
  { task_id: 'task-1', user_id: 'primary1' },
  { task_id: 'task-1', user_id: 'co1' },
] as Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[];

const user = (id: string, role: UserRecord['role']): Pick<UserRecord, 'id' | 'role'> => ({ id, role });

function main(): void {
  // Expected true.
  assertEqual(canCloseTask(task, user('primary1', 'seo_agent'), taskAssignees), true, 'primary assignee (legacy assigned_to + task_assignees row)');
  assertEqual(canCloseTask(task, user('co1', 'graphic_designer'), taskAssignees), true, 'non-primary co-assignee (task_assignees row only)');
  assertEqual(canCloseTask(task, user('creator1', 'seo_agent'), taskAssignees), true, 'creator');
  assertEqual(canCloseTask(task, user('exec1', 'executive'), taskAssignees), true, 'executive (admin role, unrelated to the task)');
  assertEqual(canCloseTask(task, user('hot1', 'head_of_technical'), taskAssignees), true, 'head_of_technical (admin role, unrelated to the task)');
  assertEqual(canCloseTask(task, user('ai1', 'ai_engineer'), taskAssignees), true, 'ai_engineer (admin role, unrelated to the task)');

  // Expected false.
  assertEqual(canCloseTask(task, user('bystander1', 'seo_agent'), taskAssignees), false, 'unrelated employee');
  assertEqual(canCloseTask(task, user('sales1', 'sales'), taskAssignees), false, 'sales, unrelated to the task');
  assertEqual(canCloseTask(task, user('mm1', 'marketing_manager'), taskAssignees), false, 'marketing_manager, unrelated to the task');
  assertEqual(canCloseTask(task, user('removed1', 'seo_agent'), taskAssignees), false, 'removed assignee (no current task_assignees row)');

  if (failures.length) {
    console.error('Found canCloseTask regression(s):\n');
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
  }
  console.log('OK: canCloseTask allows the creator, any current assignee, and every admin role, and rejects everyone else.');
}

main();
