// Shared contract-file constraints — mirrors the client-contracts Storage bucket's own
// allowed_mime_types / file_size_limit (see 20260922100000_client_contracts.sql). Client-side
// feedback only; Storage enforces both server-side regardless. Shared by ClientContractsPanel.tsx
// (post-registration upload) and ClientRegistrationModal.tsx (the required upload at registration)
// so the two validation rules never drift apart.
export const CONTRACT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png', 'image/webp',
];
export const CONTRACT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

export const formatContractFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
