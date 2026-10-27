import { ActivityRecord, TaskAssigneeLogRecord, TaskAttachmentRecord, TaskAssigneeRecord, TaskCommentRecord, TaskEventRecord, TaskPlatformLinkRecord, TaskPriority, TaskRecord, TeamTaskActivityFeedRow } from '../types/database';
import { buildAttachmentStoragePath, fetchAllRows, supabaseRaw } from './supabase';
import { sha256ForBlob } from './taskCreateRecovery';

export interface CapacitySnapshotRow {
  user_id: string;
  used_capacity: number;
}

export interface DeleteTasksResult {
  requestedCount: number;
  deletedTaskIds: string[];
  totalDeletedCount: number;
}

export interface TaskDeletionPreview {
  subtreeTaskIds: string[];
  subtaskCount: number;
  commentCount: number;
  attachmentCount: number;
}

// Pure, client-side mirror of delete_tasks()'s own subtree walk (20261113000000_task_hard_delete.sql)
// — computed from state already held in memory (tasks/taskComments/taskAttachments), so the
// confirm dialog can show "this will also remove N subtasks / N comments / N attachments" before
// the RPC call actually deletes anything. subtaskCount matches the RPC's own definition: every
// descendant pulled in by parent_task_id, minus the ids the caller explicitly requested.
export const computeTaskDeletionPreview = (
  taskIds: string[],
  tasks: TaskRecord[],
  taskComments: TaskCommentRecord[],
  taskAttachments: TaskAttachmentRecord[]
): TaskDeletionPreview => {
  const childIdsByParent = new Map<string, string[]>();
  tasks.forEach((t) => {
    if (!t.parent_task_id) return;
    childIdsByParent.set(t.parent_task_id, [...(childIdsByParent.get(t.parent_task_id) || []), t.id]);
  });

  const requestedIds = new Set(taskIds);
  const subtreeIds = new Set(taskIds);
  const collectDescendants = (id: string) => {
    for (const childId of childIdsByParent.get(id) || []) {
      if (subtreeIds.has(childId)) continue;
      subtreeIds.add(childId);
      collectDescendants(childId);
    }
  };
  requestedIds.forEach(collectDescendants);

  return {
    subtreeTaskIds: [...subtreeIds],
    subtaskCount: subtreeIds.size - requestedIds.size,
    commentCount: taskComments.filter((c) => subtreeIds.has(c.task_id)).length,
    attachmentCount: taskAttachments.filter((a) => subtreeIds.has(a.task_id)).length,
  };
};

export interface UserScheduleLoadRow {
  due_date: string;
  task_count: number;
  carried_over_count: number;
}

export interface UserScheduleLoad {
  loadByDate: Record<string, number>;
  // This assignee's overdue, still-open task count — see get_user_schedule_load()'s own comment
  // in supabase/migrations/20261111000000_user_schedule_load_carry_over.sql. Not scoped to
  // [fromDate, toDate]; a single scalar for the whole lookup, not a per-day map, since the RPC
  // itself only ever attaches it to one row (the first working day).
  carriedOverCount: number;
}

export interface StagedTaskAttachment {
  id: string;
  file: File;
  sha256?: string;
  metadataRetryAuthorized?: boolean;
}

export class TaskAttachmentMetadataError extends Error {
  constructor(message: string, public readonly metadataRetryAuthorized: boolean) {
    super(message);
    this.name = 'TaskAttachmentMetadataError';
  }
}

export interface CreateTaskCopiesInput {
  clientIds: string[];
  assigneeIds: string[];
  title: string;
  description: string;
  team: string;
  dueDate: string;
  priority: TaskPriority;
  estimatedHours?: number | null;
  taskType?: string | null;
  taskTypeOther?: string | null;
  parentTaskId?: string | null;
  batchId?: string | null;
  platformIds?: string[];
}

export interface CreateTaskFormInput extends CreateTaskCopiesInput {
  attachments: StagedTaskAttachment[];
}

export interface TaskCopyFailure {
  clientId: string;
  message: string;
  task?: TaskRecord;
}

export interface CreateTaskCopiesResult {
  tasks: TaskRecord[];
  successfulClientIds: string[];
  failures: TaskCopyFailure[];
}

const throwIfError = (error: { message?: string } | null, fallback: string) => {
  if (error) throw new Error(error.message || fallback);
};

const asTaskRow = (data: unknown): TaskRecord | null => {
  if (Array.isArray(data)) return (data[0] as TaskRecord | undefined) || null;
  return (data as TaskRecord | null) || null;
};

export const fetchTaskAssignees = async (): Promise<TaskAssigneeRecord[]> => {
  // Paginated: task_assignees has already grown past Supabase's 1000-row-per-request default (a
  // bare .select('*') here silently dropped every row past that cutoff — see fetchAllRows's own
  // comment in supabase.ts for the full story). This was the confirmed root cause of a task's
  // newest assignee intermittently not appearing for some viewers while still correctly present in
  // the database for others.
  const { data, error } = await fetchAllRows<TaskAssigneeRecord>(supabaseRaw, 'task_assignees');
  throwIfError(error, 'Unable to load task assignees.');
  return data || [];
};

export const setTaskAssignees = async (taskId: string, userIds: string[]): Promise<void> => {
  const { error } = await supabaseRaw.rpc('set_task_assignees', {
    p_task_id: taskId,
    p_user_ids: [...new Set(userIds.filter(Boolean))],
  });
  throwIfError(error, 'Unable to update task assignees.');
};

// Per-task, lazy (called only when a Task Details modal's History tab is actually opened — see
// CrossTeamTaskBoard.tsx — not fetched into global app state like fetchTaskAssignees() above,
// since task_events can grow large and most opened tasks never have their History tab visited).
// RLS on task_events (20261116000000_task_events.sql) already scopes visibility to task_visible_v2()
// or an admin role, so no permission filtering belongs here.
export const fetchTaskEvents = async (taskId: string): Promise<TaskEventRecord[]> => {
  const { data, error } = await supabaseRaw
    .from('task_events')
    .select('id, task_id, actor_id, event_type, old_value, new_value, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(100);
  throwIfError(error, 'Unable to load task history.');
  return (data as TaskEventRecord[] | null) || [];
};

// Older-history fallback for a task whose life predates task_events (20261116000000_task_events.sql)
// — see TaskHistoryTab.tsx's "Older history" section. Static cutoff, not a live query: the exact
// created_at of task_events' own first-ever row, read off production once and frozen here as a
// literal string (kept as-is, never parsed into a Date and reformatted, so the microsecond
// component survives unchanged into the query Postgres receives). Anything in the two legacy
// sources below from before this moment predates tracking entirely and is shown; anything from
// after it is already covered by task_events and would otherwise double up.
const TASK_EVENTS_HISTORY_CUTOFF = '2026-10-17T08:03:15.742991+00:00';

// public.activities rows for this one task (target_type='task', target_id=taskId), older than
// TASK_EVENTS_HISTORY_CUTOFF only. Visible to anyone who can see the task — not admin-only —
// since activities_select_task_participants (20261117000000_activities_task_participants_select.sql)
// widens activities' own RLS to the same task_visible_v2() door every other task-adjacent table
// already uses; activities_select_rls (admin-only) still applies on top of that, unchanged.
export const fetchLegacyTaskActivities = async (taskId: string): Promise<ActivityRecord[]> => {
  const { data, error } = await supabaseRaw
    .from('activities')
    .select('id, user_id, action_type, target_type, target_id, target_name, details, created_at')
    .eq('target_type', 'task')
    .eq('target_id', taskId)
    .lt('created_at', TASK_EVENTS_HISTORY_CUTOFF)
    .order('created_at', { ascending: false })
    .limit(100);
  throwIfError(error, 'Unable to load legacy task activity.');
  return (data as ActivityRecord[] | null) || [];
};

// public.task_assignee_log rows for this one task, older than TASK_EVENTS_HISTORY_CUTOFF only —
// same reasoning as fetchLegacyTaskActivities above. task_assignee_log's own RLS already lets
// anyone who can see the task see this (see that table's policy; unrelated to this PR).
export const fetchLegacyTaskAssigneeLog = async (taskId: string): Promise<TaskAssigneeLogRecord[]> => {
  const { data, error } = await supabaseRaw
    .from('task_assignee_log')
    .select('id, task_id, user_id, action, actor_id, created_at')
    .eq('task_id', taskId)
    .lt('created_at', TASK_EVENTS_HISTORY_CUTOFF)
    .order('created_at', { ascending: false })
    .limit(100);
  throwIfError(error, 'Unable to load legacy assignment log.');
  return (data as TaskAssigneeLogRecord[] | null) || [];
};

export const fetchTaskPlatformLinks = async (): Promise<TaskPlatformLinkRecord[]> => {
  // Paginated for the same reason as fetchTaskAssignees() above: one row per task per linked
  // platform, so this table grows at least as fast as `tasks` (already past the 1000-row default
  // cap) and was exposed to the exact same silent-truncation bug.
  const { data, error } = await fetchAllRows<TaskPlatformLinkRecord>(supabaseRaw, 'task_platform_links');
  throwIfError(error, 'Unable to load task platforms.');
  return data || [];
};

export const setTaskPlatforms = async (taskId: string, platformIds: string[]): Promise<void> => {
  const { error } = await supabaseRaw.rpc('set_task_platforms', {
    p_task_id: taskId,
    p_platform_ids: [...new Set(platformIds.filter(Boolean))],
  });
  throwIfError(error, 'Unable to update task platforms.');
};

export const createTaskCopies = async (input: CreateTaskCopiesInput): Promise<CreateTaskCopiesResult> => {
  const clientIds = [...new Set(input.clientIds.filter(Boolean))];
  if (clientIds.length === 0) throw new Error('Select at least one client.');

  const tasks: TaskRecord[] = [];
  const successfulClientIds: string[] = [];
  const failures: TaskCopyFailure[] = [];
  for (const clientId of clientIds) {
    const { data, error } = await supabaseRaw.rpc('create_task_copy', {
      p_client_id: clientId,
      p_title: input.title,
      p_description: input.description,
      p_team: input.team,
      p_due_date: input.dueDate,
      p_priority: input.priority,
      p_estimated_hours: input.estimatedHours ?? null,
      p_task_type: input.taskType ?? null,
      p_task_type_other: input.taskTypeOther ?? null,
      p_parent_task_id: input.parentTaskId ?? null,
      p_batch_id: input.batchId ?? null,
      p_assignee_ids: input.assigneeIds,
    });
    if (error) {
      failures.push({
        clientId,
        message: error.message || `Unable to create the task copy for client ${clientId}.`,
      });
      continue;
    }
    const task = asTaskRow(data);
    if (!task) {
      failures.push({ clientId, message: `Task creation returned no row for client ${clientId}.` });
      continue;
    }
    // create_task_copy returns an existing row before its internal set_task_assignees call on an
    // idempotent batch retry. Re-applying the form's requested set here makes both new and
    // existing copies converge. For a fresh copy this is a no-op, so the RPC emits no duplicate
    // notifications.
    try {
      await setTaskAssignees(task.id, input.assigneeIds);
    } catch (assigneeError) {
      tasks.push(task);
      failures.push({
        clientId,
        task,
        message: `The task copy was saved, but assignee synchronization was not confirmed: ${assigneeError instanceof Error ? assigneeError.message : 'Unknown Supabase error.'}`,
      });
      continue;
    }

    if (input.platformIds !== undefined) {
      try {
        await setTaskPlatforms(task.id, input.platformIds);
      } catch (platformError) {
        tasks.push(task);
        failures.push({
          clientId,
          task,
          message: `The task copy was saved, but platform synchronization was not confirmed: ${platformError instanceof Error ? platformError.message : 'Unknown Supabase error.'}`,
        });
        continue;
      }
    }

    try {
      const { data: refreshedTask, error: refreshError } = await supabaseRaw
        .from('tasks')
        .select('*')
        .eq('id', task.id)
        .single();
      if (refreshError || !refreshedTask) {
        throw new Error(`Assignees were synchronized, but the refreshed task row could not be loaded: ${refreshError?.message || 'No task row returned.'}`);
      }
      tasks.push(refreshedTask as TaskRecord);
      successfulClientIds.push(clientId);
    } catch (refreshError) {
      tasks.push(task);
      failures.push({
        clientId,
        task,
        message: `Assignees were synchronized, but the authoritative task row could not be refreshed: ${refreshError instanceof Error ? refreshError.message : 'Unknown Supabase error.'}`,
      });
    }
  }
  return { tasks, successfulClientIds, failures };
};

export const getCapacitySnapshot = async (userIds: string[]): Promise<Record<string, number>> => {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const { data, error } = await supabaseRaw.rpc('get_capacity_snapshot', { p_user_ids: ids });
  throwIfError(error, 'Unable to load capacity data.');
  return ((data as CapacitySnapshotRow[] | null) || []).reduce<Record<string, number>>((result, row) => {
    result[row.user_id] = Number(row.used_capacity);
    return result;
  }, {});
};

// Hard-deletes each given task AND its full subtree (every descendant reachable via
// parent_task_id, any depth) via delete_tasks() (20261113000000_task_hard_delete.sql) — the only
// path that can delete a task at all; there is no DELETE RLS/grant on public.tasks itself. The
// RPC itself re-checks the caller's role (executive/head_of_technical/ai_engineer) regardless of
// what the UI already gated on — canHardDeleteTasks (lib/permissions.ts) only controls whether
// the button renders.
export const deleteTasks = async (taskIds: string[]): Promise<DeleteTasksResult> => {
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) return { requestedCount: 0, deletedTaskIds: [], totalDeletedCount: 0 };
  const { data, error } = await supabaseRaw.rpc('delete_tasks', { p_task_ids: ids });
  throwIfError(error, 'Unable to delete the selected task(s).');
  const result = (data || {}) as { requested_count?: number; deleted_task_ids?: string[]; total_deleted_count?: number };
  return {
    requestedCount: result.requested_count ?? 0,
    deletedTaskIds: result.deleted_task_ids ?? [],
    totalDeletedCount: result.total_deleted_count ?? 0,
  };
};

// Backs the designer-scheduling suggestion feature — see get_user_schedule_load() in
// supabase/migrations/20261111000000_user_schedule_load_carry_over.sql and the pure algorithm in
// lib/designerScheduling.ts. Returns a due_date -> task_count map covering every day in
// [fromDate, toDate] (including empty days, counted as 0 by the RPC itself) plus this assignee's
// overdue-open carry-over count (a single scalar, not a per-day map — see UserScheduleLoad's own
// comment); never titles, ids, or status — only the aggregates the suggester needs.
export const getUserScheduleLoad = async (
  userId: string,
  fromDate: string,
  toDate: string
): Promise<UserScheduleLoad> => {
  const { data, error } = await supabaseRaw.rpc('get_user_schedule_load', {
    p_user_id: userId,
    p_from: fromDate,
    p_to: toDate,
  });
  throwIfError(error, 'Unable to load schedule data.');
  const rows = (data as UserScheduleLoadRow[] | null) || [];
  return {
    loadByDate: rows.reduce<Record<string, number>>((result, row) => {
      result[row.due_date] = Number(row.task_count);
      return result;
    }, {}),
    carriedOverCount: rows.reduce((total, row) => total + Number(row.carried_over_count), 0),
  };
};

// The one authoritative "today" for the designer-scheduling suggestion feature — Africa/Cairo's
// current date (see get_server_today() in supabase/migrations/20261110000000_user_schedule_load.sql
// for why: a bare browser-local date can be any employee's own timezone, and Supabase sessions
// default to UTC, neither of which is the agency's own calendar). The frontend must call this
// rather than deriving "today" itself for anything that feeds suggestDueDateAndHours() — see its
// call sites in CrossTeamTaskBoard.tsx, none of which fall back to a client-computed guess.
export const getServerToday = async (): Promise<string> => {
  const { data, error } = await supabaseRaw.rpc('get_server_today', {});
  throwIfError(error, 'Unable to determine the current date.');
  if (typeof data !== 'string') throw new Error('get_server_today returned an unexpected value.');
  return data;
};

export const addTaskAttachmentForCopies = async (
  taskIds: string[],
  staged: StagedTaskAttachment
): Promise<TaskAttachmentRecord[]> => {
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) throw new Error('Cannot attach a file before a task exists.');

  const storagePath = buildAttachmentStoragePath(ids[0], staged.id, staged.file.name);
  const { data: existing, error: existingError } = await supabaseRaw
    .from('task_attachments')
    .select('*')
    .eq('storage_path', storagePath);
  throwIfError(existingError, 'Unable to verify the staged attachment.');

  const existingRows = (existing as TaskAttachmentRecord[] | null) || [];
  if (ids.every((taskId) => existingRows.some((row) => row.task_id === taskId))) return existingRows;
  if (existingRows.length > 0) {
    throw new Error('This attachment is only partially linked. Refresh before retrying.');
  }

  const { error: uploadError } = await supabaseRaw.storage
    .from('task-attachments')
    .upload(storagePath, staged.file, { contentType: staged.file.type });
  if (uploadError) {
    const { data: existingObject, error: downloadError } = await supabaseRaw.storage
      .from('task-attachments')
      .download(storagePath);
    if (downloadError || !existingObject) {
      throw new Error(`Unable to upload ${staged.file.name}, and the existing object could not be safely verified. Manual review is required.`);
    }
    const [expectedHash, existingHash] = await Promise.all([
      staged.sha256 ? Promise.resolve(staged.sha256) : sha256ForBlob(staged.file),
      sha256ForBlob(existingObject),
    ]);
    if (existingObject.size !== staged.file.size || existingHash !== expectedHash) {
      throw new Error(`A different Storage object already exists for ${staged.file.name}. It was not overwritten or deleted; manual review is required.`);
    }
    if (!staged.metadataRetryAuthorized) {
      throw new Error(`The existing Storage object for ${staged.file.name} matches the selected file, but metadata absence is not proven. Manual review is required before retrying metadata.`);
    }
  }

  const { data, error } = await supabaseRaw.rpc('add_task_attachments_for_copies', {
    p_task_ids: ids,
    p_storage_path: storagePath,
    p_filename: staged.file.name,
    p_file_size: staged.file.size,
    p_mime_type: staged.file.type,
  });
  const returnedRows = (data as TaskAttachmentRecord[] | null) || [];
  if (!error && ids.every((taskId) => returnedRows.some((row) => row.task_id === taskId))) {
    return returnedRows;
  }

  // A timeout can arrive after the database transaction committed. Only use a successful,
  // RLS-visible read to prove that every intended reference exists; an empty/failed read cannot
  // prove absence, so never delete the Storage object on this ambiguous path.
  const { data: confirmed, error: confirmationError } = await supabaseRaw
    .from('task_attachments')
    .select('*')
    .eq('storage_path', storagePath);
  const confirmedRows = (confirmed as TaskAttachmentRecord[] | null) || [];
  if (!confirmationError && ids.every((taskId) => confirmedRows.some((row) => row.task_id === taskId))) {
    return confirmedRows;
  }
  throw new TaskAttachmentMetadataError(
    `Unable to confirm whether metadata for ${staged.file.name} was saved. The uploaded file was left in Storage to avoid breaking a possible saved reference. Refresh and review the attachment before retrying.${error?.message ? ` Supabase reported: ${error.message}` : ''}`,
    Boolean(error?.code)
  );
};

export const deleteTaskAttachmentReference = async (attachmentId: string): Promise<string | null> => {
  const { data, error } = await supabaseRaw.rpc('delete_task_attachment', {
    p_attachment_id: attachmentId,
  });
  throwIfError(error, 'Unable to delete the attachment reference.');
  return typeof data === 'string' && data.length > 0 ? data : null;
};

export const removeTaskAttachmentObject = async (storagePath: string): Promise<void> => {
  const { error } = await supabaseRaw.storage.from('task-attachments').remove([storagePath]);
  throwIfError(error, 'The final attachment reference was deleted, but Storage cleanup failed.');
};

export const markTaskViewed = async (taskId: string): Promise<void> => {
  const { error } = await supabaseRaw.rpc('mark_task_viewed', { p_task_id: taskId });
  throwIfError(error, 'Unable to mark the task as viewed.');
};

// team_task_activity_feed() (20261118000000_key_task_notifications_team_feed.sql) — the
// team-lead-scoped equivalent of the admin-only Live Activity Feed's public.activities read.
// SECURITY DEFINER; the RPC itself re-checks the caller's role (the four team-lead roles plus
// executive/head_of_technical) regardless of what the UI gates the button on. p_limit is
// clamped server-side to 100 — passing a larger value here is harmless, not a way to bypass it.
export const fetchTeamTaskActivityFeed = async (
  limit = 50,
  before: string | null = null
): Promise<TeamTaskActivityFeedRow[]> => {
  const { data, error } = await supabaseRaw.rpc('team_task_activity_feed', {
    p_limit: limit,
    p_before: before,
  });
  throwIfError(error, 'Unable to load the team activity feed.');
  return (data as TeamTaskActivityFeedRow[] | null) || [];
};

// Maps a team_task_activity_feed() row onto the same ActivityRecord shape LiveActivityFeed.tsx
// already renders for the admin-sourced public.activities feed, so that component can be reused
// as-is for the team-lead view (App.tsx passes mapped rows for team leads, raw activities rows
// for admins). action_type only has 5 values and task_events has 8 event_types, so several map
// onto 'update' — there is no finer-grained icon/category to pick from the shared component's own
// getActionIcon(). details carries the same old_value/new_value raw strings TaskHistoryTab.tsx
// shows for the full per-task History tab, just in English rather than that tab's Arabic
// phrasing, matching LiveActivityFeed's own existing mixed-language convention (Arabic chrome,
// raw English/Latin data values).
export const mapTeamTaskActivityFeedRowToActivityRecord = (row: TeamTaskActivityFeedRow): ActivityRecord => {
  const actionTypeByEventType: Record<TeamTaskActivityFeedRow['event_type'], ActivityRecord['action_type']> = {
    created: 'create',
    status_changed: 'status_change',
    priority_changed: 'update',
    due_date_changed: 'update',
    title_changed: 'update',
    team_changed: 'update',
    assignee_added: 'update',
    assignee_removed: 'update',
  };

  const detailsByEventType: Record<TeamTaskActivityFeedRow['event_type'], string | null> = {
    created: null,
    status_changed: `Status changed from ${row.old_value || '—'} to ${row.new_value || '—'}`,
    priority_changed: `Priority changed from ${row.old_value || '—'} to ${row.new_value || '—'}`,
    due_date_changed: `Due date changed from ${row.old_value || '—'} to ${row.new_value || '—'}`,
    title_changed: `Title changed from "${row.old_value || '—'}" to "${row.new_value || '—'}"`,
    team_changed: `Team changed from ${row.old_value || '—'} to ${row.new_value || '—'}`,
    assignee_added: 'Assignee added',
    assignee_removed: 'Assignee removed',
  };

  return {
    id: row.id,
    user_id: row.actor_id || '',
    action_type: actionTypeByEventType[row.event_type],
    target_type: 'task',
    target_id: row.task_id,
    target_name: row.task_title,
    details: detailsByEventType[row.event_type],
    created_at: row.created_at,
  };
};
