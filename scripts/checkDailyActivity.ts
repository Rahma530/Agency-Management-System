import { strict as assert } from 'node:assert';
import {
  buildDailyActivitySubmissions,
  getEligibleCompletedTasks,
  validateDailyActivityTaskLinks,
} from '../src/lib/dailyActivity';
import { DailyLogRecord, TaskAssigneeRecord, TaskRecord } from '../src/types/database';

const task = (id: string, clientId: string, completedAt: string | null, status: TaskRecord['status'] = 'completed'): TaskRecord => ({
  id, client_id: clientId, title: `Task ${id}`, description: `Details ${id}`, assigned_to: 'legacy',
  created_by: 'lead', status, due_date: '2026-10-14', priority: 'medium', completed_at: completedAt,
});
const tasks = [
  task('a', 'c1', '2026-10-14T21:30:00.000Z'),
  task('b', 'c2', '2026-10-14T08:00:00.000Z', 'closed'),
  task('old', 'c1', '2026-10-13T23:59:59.000Z'),
  task('open', 'c1', null, 'in_progress'),
];
const assignees: TaskAssigneeRecord[] = tasks.map((item) => ({ task_id: item.id, user_id: 'u1' }));
const logs: DailyLogRecord[] = [{ id: 'log', user_id: 'u1', date: '2026-10-14', summary_text: 'saved', linked_task_ids: ['b'] }];

const eligible = getEligibleCompletedTasks(tasks, assignees, logs, 'u1', '2026-10-14');
assert.deepEqual(eligible.map((item) => item.id), ['a'], 'date/status/assignee/dedup filtering must be stable');

const submissions = buildDailyActivitySubmissions(tasks, ['a', 'a', 'b'], ['c2'], 'Additional context');
assert.equal(submissions.filter((item) => item.kind === 'completed_tasks').length, 2, 'tasks must be grouped by client');
assert.equal(submissions.flatMap((item) => item.taskIds).filter((id) => id === 'a').length, 1, 'a task must be linked once');
assert.equal(submissions.find((item) => item.key === 'tasks:c1')?.summaryText.includes('Details a'), true, 'task details must be retained');
assert.equal(submissions.find((item) => item.key === 'note:c2')?.taskIds.length, 0, 'employee context must stay separate from task evidence');

const originalLog: DailyLogRecord = { id: 'edit', user_id: 'u1', date: '2026-10-14', client_id: 'c1', summary_text: 'saved', linked_task_ids: ['a'] };
const dateChanged = validateDailyActivityTaskLinks(tasks, assignees, [originalLog], ['a'], 'u1', '2026-10-15', 'c1', originalLog.id);
assert.deepEqual(dateChanged.validTaskIds, [], 'changing the report date must not retain a task completed on another UTC date');
assert.equal(dateChanged.issues[0]?.code, 'wrong_date', 'date mismatch must be explained');

const clientChanged = validateDailyActivityTaskLinks(tasks, assignees, [originalLog], ['a'], 'u1', '2026-10-14', 'c2', originalLog.id);
assert.deepEqual(clientChanged.validTaskIds, [], 'changing the client must not retain a task belonging to another client');
assert.equal(clientChanged.issues[0]?.code, 'wrong_client', 'client mismatch must be explained');

const unchanged = validateDailyActivityTaskLinks(tasks, assignees, [originalLog], ['a'], 'u1', '2026-10-14', 'c1', originalLog.id);
assert.deepEqual(unchanged.validTaskIds, ['a'], 'an unchanged valid historical link must be preserved');

const duplicateElsewhere: DailyLogRecord = { id: 'other', user_id: 'u1', date: '2026-10-14', client_id: 'c1', summary_text: 'other', linked_task_ids: ['a'] };
const duplicate = validateDailyActivityTaskLinks(tasks, assignees, [originalLog, duplicateElsewhere], ['a'], 'u1', '2026-10-14', 'c1', originalLog.id);
assert.equal(duplicate.issues[0]?.code, 'already_linked', 'deduplication must use employee, date, and stable task id');
const duplicateSelection = validateDailyActivityTaskLinks(tasks, assignees, [originalLog], ['a', 'a'], 'u1', '2026-10-14', 'c1', originalLog.id);
assert.equal(duplicateSelection.issues[0]?.code, 'duplicate_selection', 'duplicate ids within one edited row must require explicit reconciliation');
assert.deepEqual(duplicateSelection.validTaskIds, ['a'], 'explicit reconciliation must retain one valid stable task id');

const sharedAssignees: TaskAssigneeRecord[] = [
  { task_id: 'a', user_id: 'u1' },
  { task_id: 'a', user_id: 'u2' },
];
assert.deepEqual(
  getEligibleCompletedTasks(tasks, sharedAssignees, [], 'u1', '2026-10-14').map((item) => item.id),
  [],
  'a shared task without completed_by evidence must not be auto-attributed to either assignee',
);
const ambiguous = validateDailyActivityTaskLinks(tasks, sharedAssignees, [], ['a'], 'u1', '2026-10-14', 'c1');
assert.equal(ambiguous.issues[0]?.code, 'ambiguous_assignee', 'editing must explain ambiguous shared-task attribution');

const evidencedSharedTasks = tasks.map((item) => item.id === 'a'
  ? { ...item, lifecycle_cycle: 2, completion_user_ids: ['u1'] }
  : item);
assert.deepEqual(
  getEligibleCompletedTasks(evidencedSharedTasks, sharedAssignees, [], 'u1', '2026-10-14').map((item) => item.id),
  ['a'],
  'a shared task must be attributable only to an assignee with current-cycle completion evidence',
);
assert.deepEqual(
  getEligibleCompletedTasks(evidencedSharedTasks, sharedAssignees, [], 'u2', '2026-10-14').map((item) => item.id),
  [],
  'co-assignment alone must not attribute another assignee completion evidence',
);
const evidencedValidation = validateDailyActivityTaskLinks(
  evidencedSharedTasks, sharedAssignees, [], ['a'], 'u1', '2026-10-14', 'c1',
);
assert.deepEqual(evidencedValidation.validTaskIds, ['a'], 'current-cycle evidence must validate a shared-task link');

console.log('OK: daily activity validates edit scope, current-cycle shared evidence, stable IDs, grouping, and client-side duplicate detection.');
