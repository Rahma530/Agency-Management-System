import { TaskRecord, TaskPriority } from '../types/database';

// Shared by DailyOperationsModule.tsx and MyWorkHub.tsx so both compute
// "overdue"/"due today"/priority order identically instead of drifting.

export const getTodayStr = (): string => new Date().toISOString().split('T')[0];

export const isTaskOverdue = (task: TaskRecord, todayStr: string): boolean => {
  if (!task.due_date) return false;
  if (task.status === 'completed') return false;
  return task.due_date < todayStr;
};

export const isTaskDueToday = (task: TaskRecord, todayStr: string): boolean => {
  if (!task.due_date) return false;
  if (task.status === 'completed') return false;
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
