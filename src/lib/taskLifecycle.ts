import { TaskRecord, TaskStatus, UserRecord } from '../types/database';

// Single source of truth for the task lifecycle's linear "Advance Status" progression — shared by
// MyWorkHub.tsx and DailyOperationsModule.tsx, which previously each hardcoded their own copy of
// this array (the same drift risk this project has hit and fixed before). 'blocked' is
// deliberately excluded: it's a side-branch reachable separately (Report Blocker / a direct status
// pick), not a step in this forward progression.
export const TASK_STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'completed', 'closed'];

// 'closed' is a manual confirmation step on top of 'completed', not a distinct kind of done —
// functionally identical for every downstream calculation (capacity load, overdue/due-today,
// completion-rate/performance metrics, "active tasks" counts). Use this everywhere one of those
// checks is needed instead of comparing against either value inline.
export const isTaskDone = (status: TaskStatus): boolean => status === 'completed' || status === 'closed';

// Who may transition a task INTO 'closed': its creator, its current assignee (the person who did
// the work can also close it themselves), or head_of_technical (this session's standing "full
// access" precedent). Deliberately narrower than every other status transition in this app, which
// has no assignee/creator restriction at all — this is a new, additional gate specific to the
// closing action, not a general task-edit permission.
export const canCloseTask = (
  task: Pick<TaskRecord, 'created_by' | 'assigned_to'>,
  user: Pick<UserRecord, 'id' | 'role'>
): boolean => task.created_by === user.id || task.assigned_to === user.id || user.role === 'head_of_technical';

// The Close Task control should only be usable once the task has actually reached 'completed' and
// the assignee has submitted a done_link for the creator/assignee/head_of_technical to review —
// reinforcing the "review before closing" intent even though done_link is optional at the DB
// level. Combine with canCloseTask() for the full gate on rendering/enabling that control.
export const canSubmitTaskForClosing = (task: Pick<TaskRecord, 'status' | 'done_link'>): boolean =>
  task.status === 'completed' && !!task.done_link?.trim();
