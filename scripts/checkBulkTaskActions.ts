// Regression check for src/lib/bulkTaskActions.ts — the Table view's bulk-action toolbar
// (CrossTeamTaskBoard.tsx) must never grant anything the single-task UI wouldn't, must never
// stop early on one task's skip/failure (no all-or-nothing), and Duplicate's "include subtasks"
// must walk the full subtree, any depth, same as delete_tasks()'s own definition.
//
// Run via `npm run lint` (chained after tsc --noEmit) or directly:
// `npx tsx scripts/checkBulkTaskActions.ts`.
import {
  checkBulkStatusChange,
  checkBulkAssigneeEdit,
  checkBulkDuplicate,
  resolveBulkAssigneeIds,
  runBulkTaskAction,
  collectDescendantTaskIds,
  summarizeBulkOutcomes,
  MAX_BULK_TASKS,
} from '../src/lib/bulkTaskActions';
import { TaskAssigneeRecord, TaskRecord, UserRecord } from '../src/types/database';

const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertTrue(actual: boolean, label: string): void {
  if (!actual) failures.push(`${label}: expected true, got false`);
}

const user = (id: string, role: UserRecord['role'], team: string | null = null): Pick<UserRecord, 'id' | 'role' | 'team'> => ({
  id,
  role,
  team,
});

function checkStatusChange(): void {
  const openTask = { id: 't1', created_by: 'creator1', assigned_to: 'primary1', status: 'in_progress' } as Pick<
    TaskRecord,
    'id' | 'created_by' | 'assigned_to' | 'status'
  >;
  const completedTask = { ...openTask, status: 'completed' } as typeof openTask;
  const taskAssignees = [{ task_id: 't1', user_id: 'primary1' }] as Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[];

  // Any non-'closed' target is unrestricted — visibility alone (already guaranteed by the task
  // being in the viewer's own list) is enough, no matter who's asking or the task's own status.
  assertEqual(
    checkBulkStatusChange(openTask, 'in_review', user('bystander', 'seo_agent'), taskAssignees),
    { allowed: true },
    'non-closed target is unrestricted for an unrelated employee'
  );

  // 'closed' requires canCloseTask AND canSubmitTaskForClosing (status === 'completed').
  assertEqual(
    checkBulkStatusChange(completedTask, 'closed', user('creator1', 'seo_agent'), taskAssignees),
    { allowed: true },
    'creator may close a completed task'
  );
  assertEqual(
    checkBulkStatusChange(completedTask, 'closed', user('exec1', 'executive'), taskAssignees),
    { allowed: true },
    'admin may close a completed task, unrelated to it'
  );
  assertTrue(
    !checkBulkStatusChange(completedTask, 'closed', user('bystander', 'seo_agent'), taskAssignees).allowed,
    'unrelated employee may not close'
  );
  assertTrue(
    !checkBulkStatusChange(openTask, 'closed', user('creator1', 'seo_agent'), taskAssignees).allowed,
    'creator may not close a task that has not reached completed'
  );
}

function checkAssigneeEdit(): void {
  const task = { id: 't1', created_by: 'creator1', client_id: null, assigned_to: 'primary1' } as Pick<
    TaskRecord,
    'id' | 'created_by' | 'client_id' | 'assigned_to'
  >;
  const taskAssignees = [{ task_id: 't1', user_id: 'primary1' }] as Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[];
  const users: Pick<UserRecord, 'id' | 'team'>[] = [];
  const clients: { id: string; am_agent_id: string | null }[] = [];

  assertEqual(
    checkBulkAssigneeEdit(task, user('creator1', 'seo_agent'), taskAssignees, users, clients),
    { allowed: true },
    'creator may edit assignees'
  );
  assertEqual(
    checkBulkAssigneeEdit(task, user('primary1', 'seo_agent'), taskAssignees, users, clients),
    { allowed: true },
    'current assignee may edit assignees'
  );
  assertTrue(
    !checkBulkAssigneeEdit(task, user('bystander', 'seo_agent'), taskAssignees, users, clients).allowed,
    'unrelated employee may not edit assignees'
  );
  assertTrue(
    !checkBulkAssigneeEdit(task, user('sales1', 'sales'), taskAssignees, users, clients).allowed,
    'sales may never edit assignees, even as creator'
  );
}

function checkDuplicatePermission(): void {
  assertEqual(checkBulkDuplicate({ role: 'seo_agent' }), { allowed: true }, 'a normal role may duplicate');
  assertEqual(checkBulkDuplicate({ role: 'executive' }), { allowed: true }, 'an admin role may duplicate');
  assertTrue(!checkBulkDuplicate({ role: 'sales' }).allowed, 'sales may never duplicate (create) a task');
}

function checkAssigneeModes(): void {
  assertEqual(resolveBulkAssigneeIds('add', ['a', 'b'], ['b', 'c']), ['a', 'b', 'c'], 'add merges and dedupes');
  assertEqual(resolveBulkAssigneeIds('remove', ['a', 'b', 'c'], ['b']), ['a', 'c'], 'remove drops only the picked ids');
  assertEqual(resolveBulkAssigneeIds('replace', ['a', 'b'], ['c', 'c']), ['c'], 'replace discards the old list and dedupes the new one');
}

async function checkRunner(): Promise<void> {
  const attempted: string[] = [];
  const outcomes = await runBulkTaskAction(['t1', 't2', 't3'], {
    canPerform: (taskId) =>
      taskId === 't2' ? { allowed: false, reason: 'no permission for t2' } : { allowed: true },
    perform: async (taskId) => {
      attempted.push(taskId);
      if (taskId === 't3') throw new Error('boom');
    },
  });

  // Every task is attempted exactly once, in order, regardless of t2's skip or t3's failure —
  // never all-or-nothing, and never stopping early.
  assertEqual(attempted, ['t1', 't3'], 'perform() is called only for the two non-skipped tasks, t2 excluded');
  const summary = summarizeBulkOutcomes(outcomes);
  assertEqual(summary.succeeded, ['t1'], 'exactly t1 succeeded');
  assertEqual(summary.skipped.map((s) => s.taskId), ['t2'], 'exactly t2 was skipped');
  assertEqual(summary.skipped[0]?.reason, 'no permission for t2', "t2's skip reason is preserved");
  assertEqual(summary.failed.map((f) => f.taskId), ['t3'], 'exactly t3 failed');
  assertEqual(summary.failed[0]?.reason, 'boom', "t3's failure message is preserved");
}

function checkSubtreeWalk(): void {
  const allTasks = [
    { id: 'parent', parent_task_id: null },
    { id: 'child1', parent_task_id: 'parent' },
    { id: 'child2', parent_task_id: 'parent' },
    { id: 'grandchild1', parent_task_id: 'child1' },
    { id: 'unrelated', parent_task_id: null },
  ] as Pick<TaskRecord, 'id' | 'parent_task_id'>[];

  const descendants = collectDescendantTaskIds('parent', allTasks).sort();
  assertEqual(descendants, ['child1', 'child2', 'grandchild1'], 'every depth of descendant is collected, unrelated tasks excluded');
  assertEqual(collectDescendantTaskIds('grandchild1', allTasks), [], 'a leaf task has no descendants');
}

function main(): void {
  checkStatusChange();
  checkAssigneeEdit();
  checkDuplicatePermission();
  checkAssigneeModes();
  checkSubtreeWalk();
  if (MAX_BULK_TASKS !== 100) failures.push(`MAX_BULK_TASKS: expected 100, got ${MAX_BULK_TASKS}`);

  checkRunner()
    .then(() => {
      if (failures.length) {
        console.error('Found bulkTaskActions regression(s):\n');
        failures.forEach((failure) => console.error(`  ${failure}`));
        process.exit(1);
      }
      console.log('OK: bulk status/assignee permission checks mirror the single-task gates, assignee modes, the subtree walk, and the runner attempt every task without stopping early.');
    })
    .catch((err) => {
      console.error('checkBulkTaskActions crashed:', err);
      process.exit(1);
    });
}

main();
