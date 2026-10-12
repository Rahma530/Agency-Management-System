import type { CreateTaskFormInput, StagedTaskAttachment } from './taskOperations';

const RECOVERY_PREFIX = 'ams:create-task-recovery:v1:';

export type RecoveryAttachmentStatus = 'pending' | 'metadata_retry' | 'manual_review' | 'confirmed';

export interface RecoveryAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  sha256: string;
  status: RecoveryAttachmentStatus;
  message?: string;
}

export interface TaskCreateRecoveryRecord {
  version: 1;
  workflow: 'create-task';
  userId: string;
  batchId: string;
  input: Omit<CreateTaskFormInput, 'attachments'>;
  attachments: RecoveryAttachment[];
  confirmedClientIds: string[];
  failedClients: Array<{ clientId: string; message: string }>;
  createdAt: string;
  updatedAt: string;
}

const storageKey = (userId: string) => `${RECOVERY_PREFIX}${encodeURIComponent(userId)}`;

export const sha256ForBlob = async (blob: Blob): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const readTaskCreateRecovery = (userId: string): TaskCreateRecoveryRecord | null => {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TaskCreateRecoveryRecord;
    if (parsed.version !== 1 || parsed.workflow !== 'create-task' || parsed.userId !== userId || !parsed.batchId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const saveTaskCreateRecovery = (record: TaskCreateRecoveryRecord): void => {
  localStorage.setItem(storageKey(record.userId), JSON.stringify({ ...record, updatedAt: new Date().toISOString() }));
};

export const clearTaskCreateRecovery = (userId: string, batchId?: string): void => {
  const current = readTaskCreateRecovery(userId);
  if (!batchId || current?.batchId === batchId) localStorage.removeItem(storageKey(userId));
};

export const updateTaskCreateRecovery = (
  userId: string,
  batchId: string,
  update: (current: TaskCreateRecoveryRecord) => TaskCreateRecoveryRecord
): TaskCreateRecoveryRecord | null => {
  const current = readTaskCreateRecovery(userId);
  if (!current || current.batchId !== batchId) return null;
  const next = update(current);
  saveTaskCreateRecovery(next);
  return next;
};

export const createTaskRecovery = async (
  userId: string,
  input: CreateTaskFormInput
): Promise<TaskCreateRecoveryRecord> => {
  const attachments = await Promise.all(input.attachments.map(async ({ id, file }) => ({
    id,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    sha256: await sha256ForBlob(file),
    status: 'pending' as const,
  })));
  const { attachments: _files, ...serializableInput } = input;
  const batchId = input.batchId || crypto.randomUUID();
  return {
    version: 1,
    workflow: 'create-task',
    userId,
    batchId,
    input: { ...serializableInput, batchId },
    attachments,
    confirmedClientIds: [],
    failedClients: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
};

export const matchRecoveryAttachments = async (
  files: StagedTaskAttachment[],
  expected: RecoveryAttachment[]
): Promise<{ matched: StagedTaskAttachment[]; missing: RecoveryAttachment[]; unexpected: string[] }> => {
  const remaining = [...expected];
  const matched: StagedTaskAttachment[] = [];
  const unexpected: string[] = [];
  for (const entry of files) {
    const sha256 = entry.sha256 || await sha256ForBlob(entry.file);
    const index = remaining.findIndex((candidate) =>
      candidate.name === entry.file.name && candidate.size === entry.file.size && candidate.sha256 === sha256
    );
    if (index === -1) {
      unexpected.push(entry.file.name);
      continue;
    }
    const descriptor = remaining.splice(index, 1)[0];
    matched.push({
      id: descriptor.id,
      file: entry.file,
      sha256,
      metadataRetryAuthorized: descriptor.status === 'metadata_retry',
    });
  }
  return { matched, missing: remaining, unexpected };
};
