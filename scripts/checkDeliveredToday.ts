// Regression check for countDeliveredToday() (src/lib/employeeWork.ts) — backs the Daily
// Operations Module's "Delivered today: N / target" card. Covers the four things most likely to
// silently drift: counting more than one delivered task in a day, the Africa/Cairo midnight
// boundary (not UTC's, not the browser's own local day), counting for a non-primary co-assignee
// (task_assignees membership, not just the legacy single assigned_to column), and never capping
// N even when it exceeds a target.
//
// Run via `npm run lint` (chained after tsc --noEmit) or directly:
// `npx tsx scripts/checkDeliveredToday.ts`.
import { countDeliveredToday } from '../src/lib/employeeWork';
import { TaskAssigneeRecord, TaskRecord } from '../src/types/database';

const failures: string[] = [];

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
}

const task = (id: string, deliveredAt: string | null, assignedTo: string | null = null): Pick<TaskRecord, 'id' | 'delivered_at' | 'assigned_to'> => ({
  id,
  delivered_at: deliveredAt,
  assigned_to: assignedTo,
});

const assignee = (taskId: string, userId: string): Pick<TaskAssigneeRecord, 'task_id' | 'user_id'> => ({ task_id: taskId, user_id: userId });

function main(): void {
  // ------------------------------------------------------------------
  // Scenario 1: multiple deliveries on the same day, same assignee — counted individually, not
  // deduped or collapsed to 1.
  // ------------------------------------------------------------------
  {
    const tasks = [
      task('t1', '2026-03-10T09:00:00Z', 'u1'),
      task('t2', '2026-03-10T14:30:00Z', 'u1'),
      task('t3', '2026-03-10T17:00:00Z', 'u1'),
    ];
    const taskAssignees = [assignee('t1', 'u1'), assignee('t2', 'u1'), assignee('t3', 'u1')];
    assertEqual(countDeliveredToday('u1', tasks as TaskRecord[], taskAssignees as TaskAssigneeRecord[], '2026-03-10'), 3, 'multiple deliveries same day');
  }

  // ------------------------------------------------------------------
  // Scenario 2: the Africa/Cairo midnight boundary (Cairo is UTC+2, no DST). 22:30 UTC on
  // 2026-03-10 is already 2026-03-11 00:30 in Cairo — must count toward 2026-03-11, NOT
  // 2026-03-10 (which is what a naive UTC-date or raw ISO-prefix comparison would wrongly do).
  // ------------------------------------------------------------------
  {
    const tasks = [task('t4', '2026-03-10T22:30:00Z', 'u2')];
    const taskAssignees = [assignee('t4', 'u2')];
    assertEqual(countDeliveredToday('u2', tasks as TaskRecord[], taskAssignees as TaskAssigneeRecord[], '2026-03-11'), 1, 'past-midnight-Cairo delivery counts toward the Cairo day it landed in');
    assertEqual(countDeliveredToday('u2', tasks as TaskRecord[], taskAssignees as TaskAssigneeRecord[], '2026-03-10'), 0, 'past-midnight-Cairo delivery must NOT count toward the UTC day');
  }

  // ------------------------------------------------------------------
  // Scenario 3: a co-assignee (task_assignees row, not the legacy single assigned_to column)
  // must be counted too — the primary assignee (assigned_to) and a later co-assignee both see
  // this task in their own Delivered-today count.
  // ------------------------------------------------------------------
  {
    const tasks = [task('t5', '2026-03-10T10:00:00Z', 'primary')];
    const taskAssignees = [assignee('t5', 'primary'), assignee('t5', 'co_assignee')];
    assertEqual(countDeliveredToday('primary', tasks as TaskRecord[], taskAssignees as TaskAssigneeRecord[], '2026-03-10'), 1, 'primary assignee (legacy assigned_to + task_assignees row)');
    assertEqual(countDeliveredToday('co_assignee', tasks as TaskRecord[], taskAssignees as TaskAssigneeRecord[], '2026-03-10'), 1, 'co-assignee (task_assignees row only, not assigned_to)');
    assertEqual(countDeliveredToday('bystander', tasks as TaskRecord[], taskAssignees as TaskAssigneeRecord[], '2026-03-10'), 0, 'unrelated employee, same task');
  }

  // ------------------------------------------------------------------
  // Scenario 4: no cap. An assignee who delivered well past any plausible daily target still
  // gets the real, uncapped count back.
  // ------------------------------------------------------------------
  {
    const tasks = Array.from({ length: 9 }, (_, i) => task(`t${i + 10}`, '2026-03-10T08:00:00Z', 'u4'));
    const taskAssignees = tasks.map((t) => assignee(t.id, 'u4'));
    assertEqual(countDeliveredToday('u4', tasks as TaskRecord[], taskAssignees as TaskAssigneeRecord[], '2026-03-10'), 9, 'no cap — 9 delivered in one day, past the 6/day creative default');
  }

  // ------------------------------------------------------------------
  // Sanity: a task with no delivered_at (never delivered) never counts, regardless of assignee
  // or date.
  // ------------------------------------------------------------------
  {
    const tasks = [task('t20', null, 'u5')];
    const taskAssignees = [assignee('t20', 'u5')];
    assertEqual(countDeliveredToday('u5', tasks as TaskRecord[], taskAssignees as TaskAssigneeRecord[], '2026-03-10'), 0, 'delivered_at null never counts');
  }

  if (failures.length) {
    console.error('Found countDeliveredToday regression(s):\n');
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
  }
  console.log('OK: countDeliveredToday handles multiple deliveries, the Africa/Cairo midnight boundary, co-assignees, and never caps the count.');
}

main();
