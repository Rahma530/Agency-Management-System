// Shared attachment-file constraints — mirrors the client-access-attachments Storage bucket's own
// allowed_mime_types / file_size_limit (see 20261201000000_client_access_attachments.sql). ID/visa
// photos and short PDFs only, so a smaller cap and no Word documents (unlike brief-attachments/
// client-contracts).
export const CLIENT_ACCESS_ATTACHMENT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
];
export const CLIENT_ACCESS_ATTACHMENT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export const formatClientAccessAttachmentFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
