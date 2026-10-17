import { TaskRecord, TaskAssigneeRecord, TaskStatus, UserRecord, ClientRecord } from '../types/database';
import { canCloseTask, canSubmitTaskForClosing, canEditTaskAssignees } from './taskLifecycle';

// ClickUp-style bulk actions in CrossTeamTaskBoard.tsx's Table view. Every predicate here mirrors
// the EXACT same gate the single-task UI already applies (handleMoveStatus's own closing check,
// the Assignees section's canEditTaskAssignees-gated Add/Remove controls) — a bulk run must never
// grant anything a one-at-a-time action wouldn't. Server-side RLS (tasks_update_rls,
// set_task_assignees()'s own gate, tasks_insert_rls) is still the real backstop regardless; these
// predicates only decide what to even ATTEMPT, so a disallowed task is reported as "skipped — no
// permission" instead of surfacing as a confusing RLS failure deep in a Promise.
export const MAX_BULK_TASKS = 100;

export type PermissionCheck = { allowed: true } | { allowed: false; reason: string };

export interface BulkActionOutcome {
  taskId: string;
  status: 'succeeded' | 'skipped' | 'failed';
  reason?: string;
}

export interface BulkActionSummary {
  succeeded: string[];
  skipped: { taskId: string; reason: string }[];
  failed: { taskId: string; reason: string }[];
}

export const summarizeBulkOutcomes = (outcomes: BulkActionOutcome[]): BulkActionSummary => {
  const summary: BulkActionSummary = { succeeded: [], skipped: [], failed: [] };
  for (const outcome of outcomes) {
    if (outcome.status === 'succeeded') {
      summary.succeeded.push(outcome.taskId);
    } else if (outcome.status === 'skipped') {
      summary.skipped.push({ taskId: outcome.taskId, reason: outcome.reason || 'Not permitted.' });
    } else {
      summary.failed.push({ taskId: outcome.taskId, reason: outcome.reason || 'Unknown error.' });
    }
  }
  return summary;
};

// Sequential on purpose, not a small concurrency pool: a bulk action here is a deliberate,
// infrequent operator action (confirmed with a count up front), not a hot path — there's no
// latency budget worth the added complexity/harder-to-reason-about partial-failure ordering a
// concurrency pool would bring. Never all-or-nothing: one task's skip or failure never stops the
// rest from being attempted.
export const runBulkTaskAction = async (
  taskIds: string[],
  options: {
    canPerform: (taskId: string) => PermissionCheck;
    perform: (taskId: string) => Promise<void>;
  }
): Promise<BulkActionOutcome[]> => {
  const outcomes: BulkActionOutcome[] = [];
  for (const taskId of taskIds) {
    const check = options.canPerform(taskId);
    // Deliberately `=== false`, not `!check.allowed`: TypeScript only narrows a boolean-literal
    // discriminated union through an explicit equality comparison against the literal, not through
    // a bare truthiness/negation check — `!check.allowed` leaves `check` typed as the full union
    // inside this branch, so `check.reason` wouldn't type-check (confirmed directly against tsc).
    if (check.allowed === false) {
      outcomes.push({ taskId, status: 'skipped', reason: check.reason });
      continue;
    }
    try {
      await options.perform(taskId);
      outcomes.push({ taskId, status: 'succeeded' });
    } catch (err) {
      outcomes.push({ taskId, status: 'failed', reason: err instanceof Error ? err.message : 'Unknown error.' });
    }
  }
  return outcomes;
};

// Mirrors handleMoveStatus's own closing gate (CrossTeamTaskBoard.tsx) byte-for-byte in substance:
// every OTHER target status is unrestricted (visibility alone, already guaranteed — a task only
// reaches this check because it's in the current viewer's own already-RLS-filtered task list);
// only 'closed' needs canCloseTask + canSubmitTaskForClosing.
export const checkBulkStatusChange = (
  task: Pick<TaskRecord, 'id' | 'created_by' | 'assigned_to' | 'status'>,
  targetStatus: TaskStatus,
  currentUser: Pick<UserRecord, 'id' | 'role'>,
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[]
): PermissionCheck => {
  if (targetStatus !== 'closed') return { allowed: true };
  if (!canCloseTask(task, currentUser, taskAssignees)) {
    return {
      allowed: false,
      reason: "Only the task's creator, any current assignee, or Executive/Head of Technical/AI Engineer can close it.",
    };
  }
  if (!canSubmitTaskForClosing(task)) {
    return { allowed: false, reason: 'This task must reach Completed before it can be closed.' };
  }
  return { allowed: true };
};

// Mirrors the single-task Assignees section's own canEdit gate exactly (CrossTeamTaskBoard.tsx:
// "const canEdit = ... canEditTaskAssignees(...)").
export const checkBulkAssigneeEdit = (
  task: Pick<TaskRecord, 'id' | 'created_by' | 'client_id' | 'assigned_to'>,
  currentUser: Pick<UserRecord, 'id' | 'role' | 'team'>,
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[],
  users: Pick<UserRecord, 'id' | 'team'>[],
  clients: Pick<ClientRecord, 'id' | 'am_agent_id'>[]
): PermissionCheck =>
  canEditTaskAssignees(task, currentUser, taskAssignees, users, clients)
    ? { allowed: true }
    : { allowed: false, reason: "You do not have permission to modify this task's assignees." };

// Duplicate always creates with created_by = the current caller (create_task_copy() sets this
// itself via app_user_id(), see 20261105000000_task_assignees_rpcs.sql) — the one thing
// tasks_insert_rls would reject regardless of which task is being duplicated is a 'sales' caller,
// so that's the only thing worth checking client-side before attempting.
export const checkBulkDuplicate = (currentUser: Pick<UserRecord, 'role'>): PermissionCheck =>
  currentUser.role === 'sales'
    ? { allowed: false, reason: 'sales may not create tasks.' }
    : { allowed: true };

export type BulkAssigneeMode = 'add' | 'replace' | 'remove';

export const resolveBulkAssigneeIds = (
  mode: BulkAssigneeMode,
  currentIds: string[],
  pickedIds: string[]
): string[] => {
  switch (mode) {
    case 'add':
      return [...new Set([...currentIds, ...pickedIds])];
    case 'remove':
      return currentIds.filter((id) => !pickedIds.includes(id));
    case 'replace':
      return [...new Set(pickedIds)];
    default:
      return currentIds;
  }
};

// Every descendant of parentId, any depth — same recursive subtree definition delete_tasks()
// (20261113000000_task_hard_delete.sql) and computeTaskDeletionPreview() (taskOperations.ts)
// already use, kept consistent so "include subtasks" on Duplicate means the same thing "this
// will also remove N subtasks" already means on Delete.
export const collectDescendantTaskIds = (
  parentId: string,
  allTasks: Pick<TaskRecord, 'id' | 'parent_task_id'>[]
): string[] => {
  const childIdsByParent = new Map<string, string[]>();
  allTasks.forEach((t) => {
    if (!t.parent_task_id) return;
    childIdsByParent.set(t.parent_task_id, [...(childIdsByParent.get(t.parent_task_id) || []), t.id]);
  });
  const result: string[] = [];
  const walk = (id: string) => {
    for (const childId of childIdsByParent.get(id) || []) {
      result.push(childId);
      walk(childId);
    }
  };
  walk(parentId);
  return result;
};
