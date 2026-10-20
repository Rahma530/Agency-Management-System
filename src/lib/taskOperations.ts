import { TaskAttachmentRecord, TaskAssigneeRecord, TaskPriority, TaskRecord } from '../types/database';
import { buildAttachmentStoragePath, supabaseRaw } from './supabase';
import { sha256ForBlob } from './taskCreateRecovery';

export interface CapacitySnapshotRow {
  user_id: string;
  used_capacity: number;
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
  allClients?: boolean;
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

export interface TaskMutationContext {
  impersonationSessionId?: string | null;
}

const requestKey = () => crypto.randomUUID();

export const transitionTask = async (
  task: TaskRecord,
  action: string,
  payload: Record<string, unknown> = {},
  context: TaskMutationContext = {}
): Promise<TaskRecord> => {
  if (task.row_version == null) throw new Error('Refresh this task before changing its status.');
  const { data, error } = await supabaseRaw.rpc('transition_task_v2', {
    p_task_id: task.id,
    p_action: action,
    p_payload: payload,
    p_expected_row_version: task.row_version,
    p_request_key: requestKey(),
    p_impersonation_session_id: context.impersonationSessionId ?? null,
  });
  throwIfError(error, 'Unable to change task status.');
  const row = asTaskRow(data);
  if (!row) throw new Error('Task status change returned no row.');
  return row;
};

export const mutateTask = async (
  task: TaskRecord,
  changes: Record<string, unknown>,
  context: TaskMutationContext = {}
): Promise<TaskRecord> => {
  if (task.row_version == null) throw new Error('Refresh this task before editing it.');
  const { data, error } = await supabaseRaw.rpc('mutate_task_v2', {
    p_task_id: task.id,
    p_expected_row_version: task.row_version,
    p_changes: changes,
    p_request_key: requestKey(),
    p_impersonation_session_id: context.impersonationSessionId ?? null,
  });
  throwIfError(error, 'Unable to update task.');
  const row = asTaskRow(data);
  if (!row) throw new Error('Task update returned no row.');
  return row;
};

export const archiveTask = async (
  task: TaskRecord,
  restore: boolean,
  reason: string | null,
  context: TaskMutationContext = {}
): Promise<TaskRecord> => {
  if (task.row_version == null) throw new Error('Refresh this task before changing its archive state.');
  const { data, error } = await supabaseRaw.rpc('archive_task_v2', {
    p_task_id: task.id,
    p_restore: restore,
    p_reason: reason,
    p_expected_row_version: task.row_version,
    p_request_key: requestKey(),
    p_impersonation_session_id: context.impersonationSessionId ?? null,
  });
  throwIfError(error, restore ? 'Unable to restore task.' : 'Unable to archive task.');
  const row = asTaskRow(data);
  if (!row) throw new Error('Archive operation returned no task row.');
  return row;
};

export const removeUserFromOpenTasks = async (
  userId: string,
  context: TaskMutationContext = {}
): Promise<number> => {
  const { data, error } = await supabaseRaw.rpc('remove_user_from_open_tasks_v2', {
    p_user_id: userId,
    p_request_key: requestKey(),
    p_impersonation_session_id: context.impersonationSessionId ?? null,
  });
  throwIfError(error, 'Unable to remove the deactivated employee from open tasks.');
  const row = Array.isArray(data) ? data[0] : data;
  return Number((row as { affected_count?: number } | null)?.affected_count ?? 0);
};

export const fetchTaskAssignees = async (): Promise<TaskAssigneeRecord[]> => {
  const { data, error } = await supabaseRaw.from('task_assignees').select('*');
  throwIfError(error, 'Unable to load task assignees.');
  return (data as TaskAssigneeRecord[] | null) || [];
};

export const setTaskAssignees = async (
  task: TaskRecord,
  userIds: string[],
  context: TaskMutationContext = {}
): Promise<TaskRecord> => {
  if (task.row_version == null) throw new Error('Refresh this task before changing assignees.');
  const { data, error } = await supabaseRaw.rpc('set_task_assignees_v2', {
    p_task_id: task.id,
    p_user_ids: [...new Set(userIds.filter(Boolean))],
    p_expected_row_version: task.row_version,
    p_request_key: requestKey(),
    p_impersonation_session_id: context.impersonationSessionId ?? null,
  });
  throwIfError(error, 'Unable to update task assignees.');
  const row = asTaskRow(data);
  if (!row) throw new Error('Assignment update returned no task row.');
  return row;
};

export const createTaskCopies = async (
  input: CreateTaskCopiesInput,
  context: TaskMutationContext = {}
): Promise<CreateTaskCopiesResult> => {
  const clientIds = input.clientIds.filter(Boolean);
  if (!input.allClients && clientIds.length === 0) throw new Error('Select at least one client.');
  if (!input.batchId) throw new Error('A stable batch ID is required for safe retries.');

  const { data, error } = await supabaseRaw.rpc('create_task_bulk_v2', {
    p_request_key: input.batchId,
    p_selection_mode: input.allClients ? 'all_clients' : 'explicit',
    p_client_ids: input.allClients ? null : clientIds,
    p_payload: {
      title: input.title,
      description: input.description,
      team: input.team,
      due_date: input.dueDate,
      priority: input.priority,
      estimated_hours: input.estimatedHours ?? null,
      task_type: input.taskType ?? null,
      task_type_other: input.taskTypeOther ?? null,
      parent_task_id: input.parentTaskId ?? null,
      assignee_ids: [...new Set(input.assigneeIds.filter(Boolean))],
    },
    p_impersonation_session_id: context.impersonationSessionId ?? null,
  });
  throwIfError(error, 'Unable to create task copies.');
  const rows = (data as Array<{
    requested_client_id: string;
    success: boolean;
    task_id: string | null;
    error_message: string | null;
  }> | null) || [];
  const successfulRows = rows.filter((row) => row.success && row.task_id);
  const successfulClientIds = successfulRows.map((row) => row.requested_client_id);
  const taskIds = successfulRows.map((row) => row.task_id as string);
  let tasks: TaskRecord[] = [];
  if (taskIds.length > 0) {
    const { data: taskRows, error: taskError } = await supabaseRaw.from('tasks').select('*').in('id', taskIds);
    throwIfError(taskError, 'Task copies were created but could not be refreshed.');
    tasks = (taskRows as TaskRecord[] | null) || [];
  }
  const failures = rows.filter((row) => !row.success).map((row) => ({
    clientId: row.requested_client_id,
    message: row.error_message || 'This task copy was not created.',
  }));
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
