import React, { useEffect, useRef, useState } from 'react';
import { ShieldCheck, Download, Trash2, FileText, Loader2, RefreshCw } from 'lucide-react';
import { ClientAccessAttachmentRecord } from '../types/database';
import { supabase } from '../lib/supabase';
import {
  CLIENT_ACCESS_ATTACHMENT_ALLOWED_MIME_TYPES,
  CLIENT_ACCESS_ATTACHMENT_MAX_FILE_SIZE_BYTES,
  formatClientAccessAttachmentFileSize,
} from '../lib/clientAccessAttachments';

const SIGNED_URL_TTL_SECONDS = 300;

interface ClientAccessAttachmentsPanelProps {
  clientId: string;
  // Gated the same way the surrounding Client Access section is gated (executive / head_of_
  // technical / am_team_lead / am_agent-of-own-client) — this table has no RLS/grant of its own,
  // every call here goes through a SECURITY DEFINER RPC that re-checks that same role rule itself,
  // so canUpload only controls whether the UI offers the button, never the real access gate.
  canUpload: boolean;
  onFetch: (clientId: string) => Promise<ClientAccessAttachmentRecord[]>;
  onUpload: (clientId: string, file: File, label: string | null) => Promise<ClientAccessAttachmentRecord>;
  onDelete: (clientId: string, attachmentId: string, storagePath: string) => Promise<void>;
}

// Client Access attachments (ID/visa images, etc.) — unlike BriefAttachmentsPanel/
// ClientContractsPanel, this table is never part of the app's eagerly-fetched global state
// (see App.tsx's handleFetchClientAccessAttachments comment), so this panel owns its own
// lazy-loaded list, fetched on mount and on clientId change, same lazy convention as the rest
// of the Client Access section in ClientDashboard.tsx.
export const ClientAccessAttachmentsPanel: React.FC<ClientAccessAttachmentsPanelProps> = ({
  clientId,
  canUpload,
  onFetch,
  onUpload,
  onDelete,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ClientAccessAttachmentRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

  const loadAttachments = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await onFetch(clientId);
      setAttachments(data);
    } catch (err) {
      console.error(err);
      setError('Unable to load attachments.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const attachmentIdsKey = attachments.map((a) => a.id).join(',');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        attachments.map(async (a) => {
          const { data } = await supabase.storage
            .from('client-access-attachments')
            .createSignedUrl(a.storage_path, SIGNED_URL_TTL_SECONDS);
          return [a.id, data?.signedUrl || ''] as const;
        })
      );
      if (!cancelled) setSignedUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentIdsKey]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);

    if (!CLIENT_ACCESS_ATTACHMENT_ALLOWED_MIME_TYPES.includes(file.type)) {
      setError(`File type not allowed (${file.type || 'unknown'}). Allowed: PDF, JPEG, PNG, WEBP.`);
      return;
    }
    if (file.size > CLIENT_ACCESS_ATTACHMENT_MAX_FILE_SIZE_BYTES) {
      setError(`File too large (${formatClientAccessAttachmentFileSize(file.size)}) — the limit is 10MB.`);
      return;
    }

    setIsUploading(true);
    try {
      const inserted = await onUpload(clientId, file, null);
      setAttachments((prev) => [...prev, inserted]);
    } catch (err) {
      console.error(err);
      setError('Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (attachmentId: string, storagePath: string) => {
    try {
      await onDelete(clientId, attachmentId, storagePath);
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
    } catch (err) {
      console.error(err);
      setError('Unable to remove this attachment.');
    }
  };

  const sorted = [...attachments].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));

  return (
    <div className="p-4 rounded-xl border border-red-900/30 bg-[#161224]/80 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-white flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-red-400" />
          <span>Access Documents (ID / Visa)</span>
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-stone-400 font-mono">{sorted.length}</span>
          <button onClick={loadAttachments} className="p-1 rounded text-stone-500 hover:text-white" title="Refresh">
            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-xs text-stone-500 italic">Loading...</p>
      ) : sorted.length === 0 ? (
        <p className="text-xs text-stone-500 italic">No documents uploaded yet.</p>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((a) => {
            const url = signedUrls[a.id];
            return (
              <div
                key={a.id}
                className="flex items-center gap-2.5 p-2 rounded-lg border"
                style={{ background: 'rgba(21, 19, 24, 0.65)', borderColor: 'var(--border-soft)' }}
              >
                <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 bg-stone-900 border border-stone-800">
                  <FileText className="w-4 h-4 text-red-300" />
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-white truncate">{a.label || a.filename}</p>
                  <p className="text-[10px] text-stone-400">
                    {formatClientAccessAttachmentFileSize(a.file_size)} • {a.uploaded_at.slice(0, 10)}
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
                  {canUpload && (
                    <button
                      onClick={() => handleDelete(a.id, a.storage_path)}
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-red-300 bg-red-900/30 hover:bg-red-800/50 hover:text-white border border-red-700/40 transition-all disabled:opacity-50"
          >
            {isUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            <span>{isUploading ? 'Uploading...' : 'Upload Document'}</span>
          </button>
        </div>
      )}
    </div>
  );
};
