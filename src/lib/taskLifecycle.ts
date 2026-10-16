import { ClientRecord, TaskAssigneeRecord, TaskRecord, TaskStatus, UserRecord } from '../types/database';

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
// the work can also close it themselves), or an admin role (executive, head_of_technical,
// ai_engineer — matching task_closable() in supabase/migrations/20261104000000_task_visibility_functions.sql).
// Deliberately narrower than every other status transition in this app, which has no
// assignee/creator restriction at all — this is a new, additional gate specific to the closing
// action, not a general task-edit permission.
export const canCloseTask = (
  task: Pick<TaskRecord, 'created_by' | 'assigned_to'>,
  user: Pick<UserRecord, 'id' | 'role'>
): boolean =>
  task.created_by === user.id ||
  task.assigned_to === user.id ||
  user.role === 'executive' ||
  user.role === 'head_of_technical' ||
  user.role === 'ai_engineer';

// The Close Task control should only be usable once the task has actually reached 'completed'.
// done_link is OPTIONAL on every task (owner decision) and is never required to close a task —
// combine with canCloseTask() for the full gate on rendering/enabling that control.
export const canSubmitTaskForClosing = (task: Pick<TaskRecord, 'status'>): boolean =>
  task.status === 'completed';

// Done Link (tasks.done_link) is shown from 'in_progress' onward — not at 'todo'/'blocked', where
// there's nothing yet to link to — OR whenever the task already carries a non-empty done_link,
// whatever its current status (e.g. the backfill migration can set one on a task that's since
// moved back to 'todo'/'blocked'; that value must never become invisible/unreachable). Single
// source of truth for that stage gate, shared by CrossTeamTaskBoard.tsx and
// DailyOperationsModule.tsx so the two surfaces can't drift.
export const canShowDoneLink = (task: Pick<TaskRecord, 'status' | 'done_link'>): boolean =>
  !!task.done_link?.trim() ||
  task.status === 'in_progress' || task.status === 'in_review' || isTaskDone(task.status);

// The real, multi-assignee membership for a task — task_assignees rows when any exist, falling
// back to the legacy single `assigned_to` column only for an older task that predates the
// task_assignees table (set_task_assignees always keeps both in sync going forward, via the
// reverse trigger, so a task with any real assignee history always has task_assignees rows).
// Every "is this task mine / does this cover me" check below the Create/Edit form must go
// through this — reading tasks.assigned_to alone silently drops every co-assignee added after
// the first.
export const resolveTaskAssigneeIds = (
  taskId: string,
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[],
  legacyAssignedTo?: string | null
): string[] => {
  const ids = taskAssignees.filter((row) => row.task_id === taskId).map((row) => row.user_id);
  return ids.length > 0 ? ids : (legacyAssignedTo ? [legacyAssignedTo] : []);
};

// Display order for a task's assignees. The newest task_assignees row is the primary assignee;
// the legacy tasks.assigned_to value is only consulted when the task has no membership rows.
// Missing created_at values sort behind timestamped rows. task_assignees has no sequence/id column,
// so an exact timestamp tie cannot prove which row was inserted last; user_id provides a stable,
// deterministic tie-breaker instead of relying on the database's unspecified result order.
export const resolveOrderedTaskAssigneeIds = (
  taskId: string,
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id' | 'created_at'>[],
  legacyAssignedTo?: string | null
): string[] => {
  const rows = taskAssignees.filter((row) => row.task_id === taskId);
  if (rows.length === 0) return legacyAssignedTo ? [legacyAssignedTo] : [];

  return [...rows]
    .sort((a, b) => {
      const aCreatedAt = a.created_at || '';
      const bCreatedAt = b.created_at || '';
      return bCreatedAt.localeCompare(aCreatedAt) || a.user_id.localeCompare(b.user_id);
    })
    .map((row) => row.user_id);
};

// Client-side UI mirror of set_task_assignees' permission gate
// (supabase/migrations/20261105000000_task_assignees_rpcs.sql, PR 4a — not yet merged/applied,
// read there for the authoritative SQL). Deliberately only decides whether to SHOW the "Add
// assignee"/remove controls in the Details modal; the RPC itself is the only real enforcement,
// and a wrong `true` here just means a visible RPC error on submit, never a silent bypass. Can
// under-show for a team-lead door when `users`/`taskDirectoryUsers` doesn't happen to include
// every relevant team/role (both are RLS- or caller-scoped rosters, not guaranteed complete) —
// in that case the control stays hidden rather than erroring, a safe direction to be wrong in.
export const canEditTaskAssignees = (
  task: Pick<TaskRecord, 'id' | 'created_by' | 'client_id' | 'assigned_to'>,
  currentUser: Pick<UserRecord, 'id' | 'role' | 'team'>,
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[],
  users: Pick<UserRecord, 'id' | 'team'>[],
  clients: Pick<ClientRecord, 'id' | 'am_agent_id'>[]
): boolean => {
  if (currentUser.role === 'sales' || currentUser.role === 'ui_ux_designer') return false;

  const assigneeIds = resolveTaskAssigneeIds(task.id, taskAssignees, task.assigned_to);
  const isAdmin = currentUser.role === 'executive' || currentUser.role === 'head_of_technical' || currentUser.role === 'ai_engineer';
  const isCreator = task.created_by === currentUser.id;
  const isCurrentAssignee = assigneeIds.includes(currentUser.id);
  if (isAdmin || isCreator || isCurrentAssignee) return true;

  const client = task.client_id ? clients.find((c) => c.id === task.client_id) : undefined;
  if (currentUser.role === 'am_agent' && !!client && client.am_agent_id === currentUser.id) return true;

  const teamOf = (userId: string | null | undefined) => userId ? users.find((u) => u.id === userId)?.team : undefined;

  if (currentUser.role === 'am_team_lead' && !!client?.am_agent_id) {
    if (teamOf(client.am_agent_id) === currentUser.team) return true;
  }

  const TEAM_LEAD_ROLES = ['am_team_lead', 'media_buying_team_lead', 'seo_team_lead', 'social_media_team_lead'];
  if (TEAM_LEAD_ROLES.includes(currentUser.role)) {
    const creatorTeam = teamOf(task.created_by);
    const assigneeTeams = assigneeIds.map(teamOf);
    if (creatorTeam === currentUser.team || assigneeTeams.includes(currentUser.team)) return true;
    if (currentUser.role === 'seo_team_lead' && (creatorTeam === 'Programming' || assigneeTeams.includes('Programming'))) {
      return true;
    }
  }

  return false;
};
