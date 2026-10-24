// Shared attachment-file constraints — mirrors the brief-attachments Storage bucket's own
// allowed_mime_types / file_size_limit (see 20261130000000_brief_attachments.sql). Client-side
// feedback only; Storage enforces both server-side regardless. Same values as
// lib/clientContracts.ts on purpose — both buckets share the same allowed-type list.
export const BRIEF_ATTACHMENT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png', 'image/webp',
];
export const BRIEF_ATTACHMENT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

export const formatBriefAttachmentFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
