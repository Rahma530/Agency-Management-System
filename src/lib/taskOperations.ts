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
