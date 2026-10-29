import { TaskRecord, TaskPriority, TaskStatus, TaskAssigneeRecord, TaskEventRecord } from '../types/database';
import { isTaskDone, resolveTaskAssigneeIds } from './taskLifecycle';

// Shared by DailyOperationsModule.tsx and MyWorkHub.tsx so both compute
// "overdue"/"due today"/priority order identically instead of drifting.

// Browser-local calendar day, not UTC (toISOString() lags local time by up to a few hours every
// night) — getFullYear/getMonth/getDate already read the browser's own OS timezone, which for
// this app's actual users already is the local day that matters.
export const getTodayStr = (): string => {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// delivered_at (tasks.delivered_at, 20261112000000_in_review_not_workload.sql) is a timestamptz —
// stored/transmitted as UTC. "Today" for the Delivered-today card is Africa/Cairo's calendar day,
// the same authority get_server_today()/getServerToday() already use elsewhere, NOT the UTC date
// (a delivery at, say, 22:30 UTC is already past midnight the next day in Cairo, UTC+2/+3) and NOT
// the browser's own local day (getTodayStr() above) — a viewer in a different timezone than Cairo
// must not see a different count than one in Cairo would. Intl.DateTimeFormat with timeZone:
// 'Africa/Cairo' is the browser-native way to get that civil date without a date library; 'en-CA'
// is used purely because that locale happens to format as YYYY-MM-DD, matching getServerToday()'s
// own return shape.
const CAIRO_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export const toCairoDateStr = (isoTimestamp: string): string => CAIRO_DATE_FORMATTER.format(new Date(isoTimestamp));

// Delivered today: every task this user is a current assignee of (resolveTaskAssigneeIds — every
// row in task_assignees, not just the legacy single assigned_to column, so a co-assignee who
// isn't the "primary" one still counts) whose delivered_at falls on today's Africa/Cairo calendar
// date. No cap — a task delivered more than once (in_review -> revision -> in_review again) still
// only has ONE delivered_at (it is set once, never moved — see that migration's own header), so
// this never double-counts a single task; a genuinely prolific day with more deliveries than the
// assignee's target is reported as-is, over target, never clamped down to it.
export const countDeliveredToday = (
  userId: string,
  tasks: TaskRecord[],
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[],
  todayStr: string
): number =>
  tasks.filter(
    (t) =>
      !!t.delivered_at &&
      toCairoDateStr(t.delivered_at) === todayStr &&
      resolveTaskAssigneeIds(t.id, taskAssignees, t.assigned_to).includes(userId)
  ).length;

// Delivered today, by ACTOR (the Delivered-today card's current rule). countDeliveredToday above
// counts the FIRST delivery only (tasks.delivered_at is set once), so a task that was delivered
// before, sent back for revision and delivered again today never counts today. This version reads
// task_events instead: every status_changed event that moved a task INTO in_review or completed
// from a non-delivered status, dated today in Africa/Cairo, and performed by this user. A task is
// counted at most once per day, even if it was delivered more than once that day. When an event
// has no actor_id, it falls back to the task's current assignees.
export type DeliveryEventRow = Pick<TaskEventRecord, 'task_id' | 'actor_id' | 'old_value' | 'new_value' | 'created_at'>;

const DELIVERED_STATUSES: ReadonlySet<string> = new Set(['in_review', 'completed']);

export const countDeliveredTodayByActor = (
  userId: string,
  events: DeliveryEventRow[],
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[],
  todayStr: string
): number => {
  const counted = new Set<string>();
  for (const event of events) {
    if (!event.new_value || !DELIVERED_STATUSES.has(event.new_value)) continue;
    // in_review <-> completed is not a new delivery; only a move from a non-delivered status is.
    if (event.old_value && DELIVERED_STATUSES.has(event.old_value)) continue;
    if (toCairoDateStr(event.created_at) !== todayStr) continue;
    const doneByUser = event.actor_id
      ? event.actor_id === userId
      : taskAssignees.some((a) => a.task_id === event.task_id && a.user_id === userId);
    if (doneByUser) counted.add(event.task_id);
  }
  return counted.size;
};

export const isTaskOverdue = (task: TaskRecord, todayStr: string): boolean => {
  if (!task.due_date) return false;
  if (isTaskDone(task.status)) return false;
  return task.due_date < todayStr;
};

export const isTaskDueToday = (task: TaskRecord, todayStr: string): boolean => {
  if (!task.due_date) return false;
  if (isTaskDone(task.status)) return false;
  return task.due_date === todayStr;
};

// Workload-open (owner decision): the three statuses that count as real, outstanding work.
// in_review is deliberately excluded — it's delivered, waiting on the client, not workload (see
// isTaskOverdueForAssignee's own comment) — and completed/closed are done, not open. A revision
// (a previously-delivered task sent back to todo/in_progress, tasks.revision_count > 0) IS in
// this set, by construction: it's just a todo/in_progress task like any other.
export const isTaskWorkloadOpen = (status: TaskStatus): boolean =>
  status === 'todo' || status === 'in_progress' || status === 'blocked';

// The one Overdue determination every surface in this app must use (DailyOperationsModule,
// MyWorkHub, CrossTeamTaskBoard/KanbanTaskCard, get_user_schedule_load's carried_over_count on
// the SQL side — see 20261112000000_in_review_not_workload.sql). Two owner decisions in one
// function:
//   1. in_review is NOT workload and therefore can never be Overdue, whatever its due_date —
//      it's delivered, waiting on the client, not late work sitting with the assignee.
//   2. A REVISION (tasks.revision_count > 0 — a previously-delivered task the client sent back)
//      IS workload again, but must never show as Overdue even if its due_date has passed: the
//      assignee didn't sit on it for N days, the client's review cycle did, and `due_date` is
//      never moved to reflect that (owner decision: no task date is ever changed).
// Both are folded into one condition — "workload-open AND past due AND never revised" — rather
// than two separate flags, so there is exactly one place this logic can drift.
export const isTaskOverdueForAssignee = (
  task: Pick<TaskRecord, 'status' | 'due_date' | 'revision_count'>,
  todayStr: string
): boolean => {
  if (!task.due_date) return false;
  if (!isTaskWorkloadOpen(task.status)) return false;
  if ((task.revision_count ?? 0) > 0) return false;
  return task.due_date < todayStr;
};

// Urgent > High > Medium > Low
export const getTaskPriorityWeight = (priority: TaskPriority): number => {
  switch (priority) {
    case 'urgent': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
};

// Priority first (Urgent first), then due date (closest first)
export const sortTasksByPriorityThenDueDate = (tasks: TaskRecord[]): TaskRecord[] => {
  return [...tasks].sort((a, b) => {
    const weightDiff = getTaskPriorityWeight(b.priority) - getTaskPriorityWeight(a.priority);
    if (weightDiff !== 0) return weightDiff;
    if (a.due_date && b.due_date) {
      return a.due_date.localeCompare(b.due_date);
    }
    return 0;
  });
};

export const getSortedEmployeeTasks = (tasks: TaskRecord[], employeeId: string): TaskRecord[] =>
  sortTasksByPriorityThenDueDate(tasks.filter((t) => t.assigned_to === employeeId));
