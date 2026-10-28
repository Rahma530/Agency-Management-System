import React, { useEffect, useState } from 'react';
import { Download, FileText, Trash2 } from 'lucide-react';
import { DailyLogAttachmentRecord, UserRecord } from '../types/database';
import { supabase } from '../lib/supabase';
import { formatTaskAttachmentSize } from '../lib/taskAttachmentValidation';

const SIGNED_URL_TTL_SECONDS = 300;

interface DailyLogAttachmentsListProps {
  dailyLogId: string;
  attachments: DailyLogAttachmentRecord[];
  users?: UserRecord[];
  // Only the log's own author can delete (daily_log_attachments_delete_rls is uploader-only) —
  // the caller passes this already resolved, same convention as BriefAttachmentsPanel's canUpload.
  canDelete?: boolean;
  onDelete?: (attachmentId: string) => Promise<void>;
}

// Compact, read-mostly attachment list for an existing daily log entry — same private-bucket +
// signed-URL pattern as BriefAttachmentsPanel.tsx, one level down (daily log instead of brief).
// Upload happens only at log-creation time (via TaskAttachmentPicker in the create form itself,
// see MyWorkHub.tsx/DailyOperationsModule.tsx), so this component is display + delete only.
export const DailyLogAttachmentsList: React.FC<DailyLogAttachmentsListProps> = ({
  dailyLogId,
  attachments,
  users = [],
  canDelete,
  onDelete,
}) => {
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const logAttachments = attachments
    .filter((a) => a.daily_log_id === dailyLogId)
    .sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at));
  const attachmentIdsKey = logAttachments.map((a) => a.id).join(',');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        logAttachments.map(async (a) => {
          const { data } = await supabase.storage
            .from('daily-log-attachments')
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

  if (logAttachments.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {logAttachments.map((a) => {
        const uploader = users.find((u) => u.id === a.uploaded_by);
        const url = signedUrls[a.id];
        return (
          <div
            key={a.id}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] bg-stone-900 border border-stone-800"
            title={`${a.filename} • ${formatTaskAttachmentSize(a.file_size)}${uploader ? ` • ${uploader.name}` : ''}`}
          >
            <FileText className="w-3 h-3 text-purple-300 shrink-0" />
            <span className="max-w-[120px] truncate text-stone-300">{a.filename}</span>
            <a
              href={url || undefined}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (!url) e.preventDefault();
              }}
              className="text-stone-500 hover:text-white"
              title="Download"
            >
              <Download className="w-3 h-3" />
            </a>
            {canDelete && onDelete && (
              <button
                type="button"
                onClick={() => onDelete(a.id)}
                className="text-stone-500 hover:text-red-400"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
