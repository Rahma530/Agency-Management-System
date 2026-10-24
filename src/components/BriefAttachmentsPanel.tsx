import React, { useEffect, useRef, useState } from 'react';
import { Paperclip, Download, Trash2, FileText, Loader2 } from 'lucide-react';
import { BriefAttachmentRecord, UserRecord } from '../types/database';
import { supabase } from '../lib/supabase';
import {
  BRIEF_ATTACHMENT_ALLOWED_MIME_TYPES,
  BRIEF_ATTACHMENT_MAX_FILE_SIZE_BYTES,
  formatBriefAttachmentFileSize,
} from '../lib/briefAttachments';

const SIGNED_URL_TTL_SECONDS = 300;

interface BriefAttachmentsPanelProps {
  briefId: string;
  attachments: BriefAttachmentRecord[];
  users: UserRecord[];
  // Same gate drives upload AND delete — caller passes canEditServiceBrief(...) for this brief,
  // which already mirrors brief_attachments_insert_rls/delete_rls at the DB level.
  canUpload: boolean;
  onUpload: (briefId: string, file: File) => Promise<void>;
  onDelete: (attachmentId: string) => Promise<void>;
}

// Brief attachments — same private-bucket + signed-URL pattern as ClientContractsPanel.tsx, one
// level down (brief instead of client).
export const BriefAttachmentsPanel: React.FC<BriefAttachmentsPanelProps> = ({
  briefId,
  attachments,
  users,
  canUpload,
  onUpload,
  onDelete,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

  const briefAttachments = attachments
    .filter((a) => a.brief_id === briefId)
    .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  const attachmentIdsKey = briefAttachments.map((a) => a.id).join(',');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        briefAttachments.map(async (a) => {
          const { data } = await supabase.storage
            .from('brief-attachments')
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

    if (!BRIEF_ATTACHMENT_ALLOWED_MIME_TYPES.includes(file.type)) {
      setError(`File type not allowed (${file.type || 'unknown'}). Allowed: PDF, Word documents, or images.`);
      return;
    }
    if (file.size > BRIEF_ATTACHMENT_MAX_FILE_SIZE_BYTES) {
      setError(`File too large (${formatBriefAttachmentFileSize(file.size)}) — the limit is 20MB.`);
      return;
    }

    setIsUploading(true);
    try {
      await onUpload(briefId, file);
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
          <Paperclip className="w-4 h-4 text-purple-400" />
          <span>Attachments</span>
        </h3>
        <span className="text-[11px] text-stone-400 font-mono">{briefAttachments.length}</span>
      </div>

      {briefAttachments.length === 0 ? (
        <p className="text-xs text-stone-500 italic">No files attached to this brief yet.</p>
      ) : (
        <div className="space-y-1.5">
          {briefAttachments.map((a) => {
            const uploader = users.find((u) => u.id === a.uploaded_by);
            const url = signedUrls[a.id];

            return (
              <div
                key={a.id}
                className="flex items-center gap-2.5 p-2 rounded-lg border"
                style={{ background: 'rgba(21, 19, 24, 0.65)', borderColor: 'var(--border-soft)' }}
              >
                <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 bg-stone-900 border border-stone-800">
                  <FileText className="w-4 h-4 text-purple-300" />
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-white truncate">{a.filename}</p>
                  <p className="text-[10px] text-stone-400">
                    {uploader?.name || 'Unknown'} • {formatBriefAttachmentFileSize(a.file_size)} • {a.uploaded_at.slice(0, 10)}
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
                      onClick={() => onDelete(a.id)}
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
            {isUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
            <span>{isUploading ? 'Uploading...' : 'Add Attachment'}</span>
          </button>
        </div>
      )}
    </div>
  );
};
