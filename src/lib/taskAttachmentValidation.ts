export const TASK_ATTACHMENT_ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv', 'text/plain',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
] as const;

export const TASK_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

export const formatTaskAttachmentSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const validateTaskAttachmentFile = (file: File): string | null => {
  if (!TASK_ATTACHMENT_ALLOWED_MIME_TYPES.includes(file.type as (typeof TASK_ATTACHMENT_ALLOWED_MIME_TYPES)[number])) {
    return `File type not allowed (${file.type || 'unknown'}). Allowed: images, PDF/Office documents, and MP4/MOV/WebM video.`;
  }
  if (file.size > TASK_ATTACHMENT_MAX_BYTES) {
    return `File too large (${formatTaskAttachmentSize(file.size)}) — the limit is 50MB.`;
  }
  return null;
};
