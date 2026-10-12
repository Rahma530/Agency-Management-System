import React, { useEffect, useRef, useState } from 'react';
import { Paperclip, Download, Trash2, FileText, Image as ImageIcon, Film, Loader2 } from 'lucide-react';
import { TaskAttachmentRecord, UserRecord } from '../types/database';
import { supabase } from '../lib/supabase';
import {
  formatTaskAttachmentSize,
  validateTaskAttachmentFile,
} from '../lib/taskAttachmentValidation';

// Mirrors the bucket's own allowed_mime_types / file_size_limit (see the
// task_attachments migration) — enforced there too, server-side; this is
// just for immediate client-side feedback before a doomed upload is even
// attempted.
const SIGNED_URL_TTL_SECONDS = 300;

const fileIcon = (mimeType: string) => {
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.startsWith('video/')) return Film;
  return FileText;
};

interface TaskAttachmentListProps {
  taskId: string;
  attachments: TaskAttachmentRecord[];
  users: UserRecord[];
  currentUserId: string;
  onUpload: (taskId: string, file: File) => Promise<void>;
  onDelete: (attachmentId: string) => Promise<void>;
}

export const TaskAttachmentList: React.FC<TaskAttachmentListProps> = ({
  taskId,
  attachments,
  users,
  currentUserId,
  onUpload,
  onDelete,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

  const taskAttachments = attachments.filter((a) => a.task_id === taskId);
  const attachmentIdsKey = taskAttachments.map((a) => a.id).join(',');

  // Private bucket — every preview/download link is a short-lived signed
  // URL, fetched fresh whenever the attachment list changes, never a
  // permanent public link stored anywhere.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        taskAttachments.map(async (att) => {
          const { data } = await supabase.storage
            .from('task-attachments')
            .createSignedUrl(att.storage_path, SIGNED_URL_TTL_SECONDS);
          return [att.id, data?.signedUrl || ''] as const;
        })
      );
      if (!cancelled) {
        setSignedUrls(Object.fromEntries(entries));
      }
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

    const validationError = validateTaskAttachmentFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsUploading(true);
    try {
      await onUpload(taskId, file);
    } catch (err) {
      console.error(err);
      setError('Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      {taskAttachments.length === 0 ? (
        <p className="text-xs text-stone-500 italic">No attachments yet.</p>
      ) : (
        <div className="space-y-1.5">
          {taskAttachments.map((att) => {
            const uploader = users.find((u) => u.id === att.uploaded_by);
            const isOwn = att.uploaded_by === currentUserId;
            const isImage = att.mime_type.startsWith('image/');
            const Icon = fileIcon(att.mime_type);
            const url = signedUrls[att.id];

            return (
              <div
                key={att.id}
                className="flex items-center gap-2.5 p-2 rounded-lg border"
                style={{ background: 'rgba(21, 19, 24, 0.65)', borderColor: 'var(--border-soft)' }}
              >
                {isImage && url ? (
                  <img
                    src={url}
                    alt={att.filename}
                    className="w-9 h-9 rounded-md object-cover shrink-0 border border-stone-800"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 bg-stone-900 border border-stone-800">
                    <Icon className="w-4 h-4 text-purple-300" />
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-white truncate">{att.filename}</p>
                  <p className="text-[10px] text-stone-400">
                    {uploader ? uploader.name : att.uploaded_by ? 'Unknown employee' : 'Unknown'} •{' '}
                    {formatTaskAttachmentSize(att.file_size)}
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
                      onClick={() => onDelete(att.id)}
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

      <div>
        <input ref={fileInputRef} type="file" onChange={handleFileSelect} className="hidden" />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-purple-300 bg-purple-900/30 hover:bg-purple-800/50 hover:text-white border border-purple-700/40 transition-all disabled:opacity-50"
        >
          {isUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
          <span>{isUploading ? 'Uploading...' : 'Attach File'}</span>
        </button>
      </div>
    </div>
  );
};
