import { DailyLogRecord, TaskAssigneeRecord, TaskRecord } from '../types/database';
import { isTaskDone, resolveTaskAssigneeIds } from './taskLifecycle';

export interface DailyActivitySubmission {
  key: string;
  clientId: string | null;
  summaryText: string;
  taskIds: string[];
  kind: 'completed_tasks' | 'employee_note';
}

export type DailyActivityTaskLinkIssueCode =
  | 'missing_task'
  | 'wrong_employee'
  | 'ambiguous_assignee'
  | 'not_completed'
  | 'wrong_date'
  | 'wrong_client'
  | 'duplicate_selection'
  | 'already_linked';

export interface DailyActivityTaskLinkIssue {
  taskId: string;
  taskTitle: string;
  code: DailyActivityTaskLinkIssueCode;
  message: string;
}

export interface DailyActivityTaskLinkValidation {
  validTaskIds: string[];
  issues: DailyActivityTaskLinkIssue[];
}

// Report-source SQL currently treats completed_at as a UTC calendar date. Keep the create/edit
// workflow aligned with that authoritative contract instead of mixing browser-local and UTC days.
export const getTaskCompletionDate = (task: Pick<TaskRecord, 'completed_at'>): string | null =>
  task.completed_at?.slice(0, 10) || null;

export const getAlreadyLinkedTaskIds = (
  dailyLogs: DailyLogRecord[],
  userId: string,
  date: string,
  excludeLogId?: string,
): Set<string> => new Set(
  dailyLogs
    .filter((log) => log.user_id === userId && log.date === date && log.id !== excludeLogId)
    .flatMap((log) => log.linked_task_ids || []),
);

export const getEligibleCompletedTasks = (
  tasks: TaskRecord[],
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[],
  dailyLogs: DailyLogRecord[],
  userId: string,
  date: string,
  excludeLogId?: string,
): TaskRecord[] => {
  const alreadyLinked = getAlreadyLinkedTaskIds(dailyLogs, userId, date, excludeLogId);
  return tasks.filter((task) => {
    const assigneeIds = resolveTaskAssigneeIds(task.id, taskAssignees, task.assigned_to);
    return isTaskDone(task.status)
      && getTaskCompletionDate(task) === date
      && assigneeIds.includes(userId)
      && (assigneeIds.length === 1 || (task.completion_user_ids || []).includes(userId))
      && !alreadyLinked.has(task.id);
  });
};

// Editing a log can change both its date and client. Existing links are therefore revalidated
// against the same evidence rules as creation instead of being grandfathered into a different
// report scope. The current log is excluded from duplicate detection, but every other log for the
// same employee/date remains authoritative.
export const validateDailyActivityTaskLinks = (
  tasks: TaskRecord[],
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[],
  dailyLogs: DailyLogRecord[],
  linkedTaskIds: string[],
  userId: string,
  date: string,
  clientId: string | null,
  excludeLogId?: string,
): DailyActivityTaskLinkValidation => {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const alreadyLinked = getAlreadyLinkedTaskIds(dailyLogs, userId, date, excludeLogId);
  const validTaskIds: string[] = [];
  const issues: DailyActivityTaskLinkIssue[] = [];

  const uniqueLinkedTaskIds = [...new Set(linkedTaskIds)];
  uniqueLinkedTaskIds.forEach((taskId) => {
    const task = tasksById.get(taskId);
    const taskTitle = task?.title || taskId;
    if (linkedTaskIds.filter((linkedId) => linkedId === taskId).length > 1) {
      issues.push({ taskId, taskTitle, code: 'duplicate_selection', message: 'is selected more than once in this log' });
    }
    let code: DailyActivityTaskLinkIssueCode | null = null;
    let message = '';
    if (!task) {
      code = 'missing_task';
      message = 'is not available in your authorized task data';
    } else if (!resolveTaskAssigneeIds(task.id, taskAssignees, task.assigned_to).includes(userId)) {
      code = 'wrong_employee';
      message = 'is not assigned to this log owner';
    } else if (resolveTaskAssigneeIds(task.id, taskAssignees, task.assigned_to).length !== 1
      && !(task.completion_user_ids || []).includes(userId)) {
      code = 'ambiguous_assignee';
      message = 'has multiple assignees but no current-cycle completion evidence for this employee';
    } else if (!isTaskDone(task.status) || !task.completed_at) {
      code = 'not_completed';
      message = 'is not currently completed or closed';
    } else if (getTaskCompletionDate(task) !== date) {
      code = 'wrong_date';
      message = `was completed on ${getTaskCompletionDate(task) || 'an unknown date'}`;
    } else if ((task.client_id || null) !== clientId) {
      code = 'wrong_client';
      message = 'belongs to a different client';
    } else if (alreadyLinked.has(task.id)) {
      code = 'already_linked';
      message = 'is already linked to another log for this employee and date';
    }

    if (code) issues.push({ taskId, taskTitle, code, message });
    else validTaskIds.push(taskId);
  });

  return { validTaskIds, issues };
};

const completedTaskSummary = (tasks: TaskRecord[]): string => [
  'Completed Task Board work:',
  ...tasks.map((task) => {
    const description = task.description?.trim();
    return `- ${task.title}${description ? ` — ${description}` : ''}`;
  }),
].join('\n');

// A task is emitted exactly once, in the row for its own client. Additional employee-written
// context remains a separate row so it is not copied into every client/task group.
export const buildDailyActivitySubmissions = (
  tasks: TaskRecord[],
  selectedTaskIds: string[],
  selectedClientIds: string[],
  employeeNote: string,
): DailyActivitySubmission[] => {
  const selected = new Set(selectedTaskIds);
  const groups = new Map<string | null, TaskRecord[]>();
  tasks.forEach((task) => {
    if (!selected.has(task.id)) return;
    const clientId = task.client_id || null;
    groups.set(clientId, [...(groups.get(clientId) || []), task]);
  });

  const submissions: DailyActivitySubmission[] = [...groups.entries()].map(([clientId, groupTasks]) => ({
    key: `tasks:${clientId || 'none'}`,
    clientId,
    summaryText: completedTaskSummary(groupTasks),
    taskIds: groupTasks.map((task) => task.id),
    kind: 'completed_tasks' as const,
  }));

  const note = employeeNote.trim();
  if (note) {
    const noteClients: Array<string | null> = selectedClientIds.length ? [...new Set(selectedClientIds)] : [null];
    noteClients.forEach((clientId) => submissions.push({
      key: `note:${clientId || 'none'}`,
      clientId,
      summaryText: note,
      taskIds: [],
      kind: 'employee_note',
    }));
  }
  return submissions;
};
