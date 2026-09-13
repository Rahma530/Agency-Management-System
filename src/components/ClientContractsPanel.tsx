import React, { useEffect, useRef, useState } from 'react';
import { FileSignature, Download, Trash2, FileText, Loader2 } from 'lucide-react';
import { ClientContractRecord, UserRecord } from '../types/database';
import { supabase } from '../lib/supabase';

// Mirrors the client-contracts bucket's own allowed_mime_types / file_size_limit (see
// 20260922100000_client_contracts.sql) — client-side feedback only, Storage enforces both
// server-side regardless.
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png', 'image/webp',
];
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
const SIGNED_URL_TTL_SECONDS = 300;

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

interface ClientContractsPanelProps {
  clientId: string;
  contracts: ClientContractRecord[];
  users: UserRecord[];
  currentUserId: string;
  canUpload: boolean;
  onUpload: (clientId: string, file: File) => Promise<void>;
  onDelete: (contractId: string) => Promise<void>;
}

// Module 12 Phase 6: Sales contract upload — same private-bucket + signed-URL pattern as
// TaskAttachmentList.tsx (Module 4), one level up (client instead of task).
export const ClientContractsPanel: React.FC<ClientContractsPanelProps> = ({
  clientId,
  contracts,
  users,
  currentUserId,
  canUpload,
  onUpload,
  onDelete,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

  const clientContracts = contracts
    .filter((c) => c.client_id === clientId)
    .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  const contractIdsKey = clientContracts.map((c) => c.id).join(',');

  // Private bucket — every download link is a short-lived signed URL, never a permanent
  // public one, same pattern as TaskAttachmentList.tsx / ClientMeetingsPanel.tsx.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        clientContracts.map(async (c) => {
          const { data } = await supabase.storage
            .from('client-contracts')
            .createSignedUrl(c.storage_path, SIGNED_URL_TTL_SECONDS);
          return [c.id, data?.signedUrl || ''] as const;
        })
      );
      if (!cancelled) setSignedUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractIdsKey]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);

    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      setError(`File type not allowed (${file.type || 'unknown'}). Allowed: PDF, Word documents, or scanned images.`);
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setError(`File too large (${formatFileSize(file.size)}) — the limit is 20MB.`);
      return;
    }

    setIsUploading(true);
    try {
      await onUpload(clientId, file);
    } catch (err) {
      console.error(err);
      setError('Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-white flex items-center gap-2">
          <FileSignature className="w-4 h-4 text-purple-400" />
          <span>Signed Contract</span>
        </h3>
        <span className="text-[11px] text-stone-400 font-mono">{clientContracts.length}</span>
      </div>

      {clientContracts.length === 0 ? (
        <p className="text-xs text-stone-500 italic">No contract document uploaded yet.</p>
      ) : (
        <div className="space-y-1.5">
          {clientContracts.map((c) => {
            const uploader = users.find((u) => u.id === c.uploaded_by);
            const isOwn = c.uploaded_by === currentUserId;
            const url = signedUrls[c.id];

            return (
              <div
                key={c.id}
                className="flex items-center gap-2.5 p-2 rounded-lg border"
                style={{ background: 'rgba(21, 19, 24, 0.65)', borderColor: 'var(--border-soft)' }}
              >
                <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 bg-stone-900 border border-stone-800">
                  <FileText className="w-4 h-4 text-purple-300" />
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-white truncate">{c.filename}</p>
                  <p className="text-[10px] text-stone-400">
                    {uploader?.name || 'Unknown'} • {formatFileSize(c.file_size)} • {c.uploaded_at.slice(0, 10)}
                  </p>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <a
                    href={url || undefined}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      if (!url) e.preventDefault();
                    }}
                    className="p-1.5 rounded-lg bg-stone-900 text-stone-300 hover:text-white"
                    title="Download"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                  {isOwn && (
                    <button
                      onClick={() => onDelete(c.id)}
                      className="p-1.5 rounded-lg bg-stone-900 text-stone-300 hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="text-[11px] text-red-400 font-semibold">{error}</p>}

      {canUpload && (
        <div>
          <input ref={fileInputRef} type="file" onChange={handleFileSelect} className="hidden" />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-purple-300 bg-purple-900/30 hover:bg-purple-800/50 hover:text-white border border-purple-700/40 transition-all disabled:opacity-50"
          >
            {isUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSignature className="w-3.5 h-3.5" />}
            <span>{isUploading ? 'Uploading...' : 'Upload Signed Contract'}</span>
          </button>
        </div>
      )}
    </div>
  );
};
