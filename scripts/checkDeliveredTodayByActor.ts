// Regression check for countDeliveredTodayByActor() (src/lib/employeeWork.ts) — the Delivered-today
// card's current rule. It counts task_events transitions INTO in_review/completed, dated today in
// Africa/Cairo, performed by the user. Covers: a re-delivery on a later day still counts (the case
// tasks.delivered_at-based counting misses), a task moved between assignees counts for whoever
// performed the transition, an in_review <-> completed move is not a new delivery, a bulk change
// by someone else is not counted for the assignee, the Cairo midnight boundary, and the
// assignee fallback when actor_id is null.
//
// Run via `npm run lint` or directly: `npx tsx scripts/checkDeliveredTodayByActor.ts`.
import { countDeliveredTodayByActor, DeliveryEventRow } from '../src/lib/employeeWork';
import { TaskAssigneeRecord } from '../src/types/database';

const failures: string[] = [];

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
}

const event = (
  taskId: string,
  createdAt: string,
  oldValue: string | null,
  newValue: string | null,
  actorId: string | null
): DeliveryEventRow => ({ task_id: taskId, actor_id: actorId, old_value: oldValue, new_value: newValue, created_at: createdAt });

const assignee = (taskId: string, userId: string): Pick<TaskAssigneeRecord, 'task_id' | 'user_id'> => ({ task_id: taskId, user_id: userId });

function main(): void {
  // Scenario 1: re-delivery on a later day counts for the actor on that day.
  {
    const events = [
      event('t1', '2026-10-24T13:37:00Z', 'in_progress', 'in_review', 'u1'),
      event('t1', '2026-10-29T08:00:00Z', 'todo', 'in_progress', 'u1'),
      event('t1', '2026-10-29T09:00:00Z', 'in_progress', 'completed', 'u1'),
    ];
    assertEqual(countDeliveredTodayByActor('u1', events, [assignee('t1', 'u1')], '2026-10-29'), 1, 're-delivery counts on the later day');
    assertEqual(countDeliveredTodayByActor('u1', events, [assignee('t1', 'u1')], '2026-10-24'), 1, 'the first delivery still counts on its own day');
  }

  // Scenario 2: a task that was delivered by someone else earlier and then moved to this user
  // counts for this user only on the day this user delivered it.
  {
    const events = [
      event('t2', '2026-10-24T13:37:00Z', 'in_progress', 'in_review', 'designer_a'),
      event('t2', '2026-10-29T08:11:00Z', 'in_progress', 'completed', 'designer_b'),
    ];
    const assignees = [assignee('t2', 'designer_b')];
    assertEqual(countDeliveredTodayByActor('designer_b', events, assignees, '2026-10-29'), 1, 'handoff: the user who delivered today gets the count');
    assertEqual(countDeliveredTodayByActor('designer_a', events, assignees, '2026-10-29'), 0, 'handoff: the earlier deliverer gets nothing today');
  }

  // Scenario 3: in_review -> completed on the same day is one delivery, not two.
  {
    const events = [
      event('t3', '2026-10-29T07:00:00Z', 'in_progress', 'in_review', 'u3'),
      event('t3', '2026-10-29T09:00:00Z', 'in_review', 'completed', 'u3'),
    ];
    assertEqual(countDeliveredTodayByActor('u3', events, [assignee('t3', 'u3')], '2026-10-29'), 1, 'in_review -> completed is not a second delivery');
  }

  // Scenario 4: a bulk status change done by someone else is not counted for the assignee.
  {
    const events = [event('t4', '2026-10-29T06:00:00Z', 'in_progress', 'completed', 'manager')];
    assertEqual(countDeliveredTodayByActor('assignee', events, [assignee('t4', 'assignee')], '2026-10-29'), 0, 'bulk change by manager is not the assignee delivery');
  }

  // Scenario 5: Africa/Cairo midnight boundary. 22:30 UTC on 10-28 is 00:30 on 10-29 in Cairo.
  {
    const events = [event('t5', '2026-10-28T22:30:00Z', 'in_progress', 'completed', 'u5')];
    assertEqual(countDeliveredTodayByActor('u5', events, [assignee('t5', 'u5')], '2026-10-29'), 1, 'past-midnight Cairo event counts toward the Cairo day');
    assertEqual(countDeliveredTodayByActor('u5', events, [assignee('t5', 'u5')], '2026-10-28'), 0, 'past-midnight Cairo event does not count toward the UTC day');
  }

  // Scenario 6: null actor falls back to the current assignees.
  {
    const events = [event('t6', '2026-10-29T10:00:00Z', 'in_progress', 'completed', null)];
    assertEqual(countDeliveredTodayByActor('u6', events, [assignee('t6', 'u6')], '2026-10-29'), 1, 'null actor + assignee counts');
    assertEqual(countDeliveredTodayByActor('stranger', events, [assignee('t6', 'u6')], '2026-10-29'), 0, 'null actor + non-assignee does not count');
  }

  // Scenario 7: several deliveries the same day are counted per task, and a task counted twice
  // in one day still counts once.
  {
    const events = [
      event('t7a', '2026-10-29T08:00:00Z', 'in_progress', 'completed', 'u7'),
      event('t7b', '2026-10-29T09:00:00Z', 'in_progress', 'in_review', 'u7'),
      event('t7b', '2026-10-29T11:00:00Z', 'todo', 'in_review', 'u7'),
    ];
    assertEqual(countDeliveredTodayByActor('u7', events, [], '2026-10-29'), 2, 'two tasks, one of them twice, counts as 2');
  }

  if (failures.length > 0) {
    console.error('checkDeliveredTodayByActor FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('checkDeliveredTodayByActor: all scenarios passed.');
}

main();
