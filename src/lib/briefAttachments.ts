// Shared attachment-file constraints — mirrors the brief-attachments Storage bucket's own
// allowed_mime_types / file_size_limit (see 20261130000000_brief_attachments.sql, widened by
// 20261203000000_brief_attachments_expand_mime_types.sql to also include Excel/PowerPoint and
// HEIC/HEIF — an AM Team Lead's real upload was rejected by the original PDF/Word/jpg/png/webp-only
// list). Client-side feedback only; Storage enforces both server-side regardless.
export const BRIEF_ATTACHMENT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
];
export const BRIEF_ATTACHMENT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

export const formatBriefAttachmentFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
