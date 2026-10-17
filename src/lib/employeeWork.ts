import { TaskRecord, TaskPriority, TaskStatus } from '../types/database';
import { isTaskDone } from './taskLifecycle';

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
