import { TaskRecord, TaskPriority } from '../types/database';
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
