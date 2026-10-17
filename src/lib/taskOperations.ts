import { ActivityRecord, TaskAssigneeLogRecord, TaskAttachmentRecord, TaskAssigneeRecord, TaskCommentRecord, TaskEventRecord, TaskPlatformLinkRecord, TaskPriority, TaskRecord } from '../types/database';
import { buildAttachmentStoragePath, supabaseRaw } from './supabase';
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
  const { data, error } = await supabaseRaw.from('task_assignees').select('*');
  throwIfError(error, 'Unable to load task assignees.');
  return (data as TaskAssigneeRecord[] | null) || [];
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
// — see TaskHistoryTab.tsx's "Older history" section. task_events.created_at has no FK-backed
// "rollout date" of its own, so the earliest row that table has EVER held, across every task, is
// used as the cutoff: anything in the two legacy sources below from before that moment predates
// tracking entirely and is shown; anything from after it is already covered by task_events and
// would otherwise double up. A single global fact, not per-task, so it's fetched at most once per
// session and cached here — every caller after the first gets the already-resolved value (or the
// same in-flight promise) instead of re-querying. Admin-gated by the caller (CrossTeamTaskBoard.tsx)
// before this is ever invoked — not fetched at all for a non-admin viewer.
let earliestTaskEventCutoffPromise: Promise<string | null> | null = null;
export const fetchEarliestTaskEventCutoff = (): Promise<string | null> => {
  if (!earliestTaskEventCutoffPromise) {
    earliestTaskEventCutoffPromise = (async () => {
      const { data, error } = await supabaseRaw
        .from('task_events')
        .select('created_at')
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) {
        earliestTaskEventCutoffPromise = null; // let a later call retry instead of caching a failure
        throw new Error(error.message || 'Unable to load the task history cutoff.');
      }
      const rows = (data as { created_at: string }[] | null) || [];
      return rows[0]?.created_at ?? null;
    })();
  }
  return earliestTaskEventCutoffPromise;
};

// public.activities rows for this one task (target_type='task', target_id=taskId), older than
// the task_events cutoff only (see fetchEarliestTaskEventCutoff above) — beforeCutoff === null
// means task_events has no rows at all yet, so every legacy row still qualifies. RLS on
// activities already restricts this to executive/head_of_technical; the caller additionally never
// invokes this for any other viewer.
export const fetchLegacyTaskActivities = async (
  taskId: string,
  beforeCutoff: string | null
): Promise<ActivityRecord[]> => {
  let query = supabaseRaw
    .from('activities')
    .select('id, user_id, action_type, target_type, target_id, target_name, details, created_at')
    .eq('target_type', 'task')
    .eq('target_id', taskId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (beforeCutoff) query = query.lt('created_at', beforeCutoff);
  const { data, error } = await query;
  throwIfError(error, 'Unable to load legacy task activity.');
  return (data as ActivityRecord[] | null) || [];
};

// public.task_assignee_log rows for this one task, older than the task_events cutoff only — same
// reasoning as fetchLegacyTaskActivities above.
export const fetchLegacyTaskAssigneeLog = async (
  taskId: string,
  beforeCutoff: string | null
): Promise<TaskAssigneeLogRecord[]> => {
  let query = supabaseRaw
    .from('task_assignee_log')
    .select('id, task_id, user_id, action, actor_id, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (beforeCutoff) query = query.lt('created_at', beforeCutoff);
  const { data, error } = await query;
  throwIfError(error, 'Unable to load legacy assignment log.');
  return (data as TaskAssigneeLogRecord[] | null) || [];
};

export const fetchTaskPlatformLinks = async (): Promise<TaskPlatformLinkRecord[]> => {
  const { data, error } = await supabaseRaw.from('task_platform_links').select('*');
  throwIfError(error, 'Unable to load task platforms.');
  return (data as TaskPlatformLinkRecord[] | null) || [];
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
