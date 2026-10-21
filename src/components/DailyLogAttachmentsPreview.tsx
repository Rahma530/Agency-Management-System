import React, { useEffect, useState } from 'react';
import { Download, FileText, Film, Image as ImageIcon, Paperclip } from 'lucide-react';
import { TaskAttachmentRecord } from '../types/database';
import { supabase } from '../lib/supabase';

// Read-only, display-only view of a Daily Log's linked tasks' attachments — every attachment type
// (image, PDF, Office doc, video) is shown, per explicit product direction, not images only.
// Deliberately NOT the same component as TaskAttachmentList.tsx: that one owns upload/delete for a
// single task's own attachments inside the task detail panel; this one is purely read-only and
// spans every task linked to one daily log (linked_task_ids can point at more than one task).
//
// Attachment METADATA (task_attachments rows) is already loaded globally into App.tsx's
// `taskAttachments` state (RLS-scoped via task_attachments_select_rls -> task_visible_v2, the same
// gate every other attachment surface in this app already goes through) — this component is handed
// that already-filtered slice via props, never queries task_attachments itself. Only the per-file
// SIGNED URL (never a permanent public link, since the bucket is private) is resolved here, live,
// refreshed whenever the actual attachment set changes — same short-lived-signed-URL pattern
// TaskAttachmentList.tsx already uses for the exact same bucket.
const SIGNED_URL_TTL_SECONDS = 300;

const fileIcon = (mimeType: string) => {
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.startsWith('video/')) return Film;
  return FileText;
};

interface DailyLogAttachmentsPreviewProps {
  // The ids of every task linked to this one daily log (log.linked_task_ids) — a log can link more
  // than one task, so attachments from all of them are shown together, undistinguished by which
  // task they came from (matching how "Tasks linked to this report" already lists them as one set).
  taskIds: string[];
  // Already RLS-scoped (App.tsx's global taskAttachments array) — this component filters to
  // taskIds itself rather than requiring the caller to pre-filter.
  taskAttachments: TaskAttachmentRecord[];
}

export const DailyLogAttachmentsPreview: React.FC<DailyLogAttachmentsPreviewProps> = ({ taskIds, taskAttachments }) => {
  const relevant = taskAttachments.filter((a) => taskIds.includes(a.task_id));
  const attachmentIdsKey = relevant.map((a) => a.id).sort().join(',');
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    if (!relevant.length) {
      setSignedUrls({});
      return;
    }
    (async () => {
      const entries = await Promise.all(
        relevant.map(async (att) => {
          const { data } = await supabase.storage
            .from('task-attachments')
            .createSignedUrl(att.storage_path, SIGNED_URL_TTL_SECONDS);
          return [att.id, data?.signedUrl || ''] as const;
        })
      );
      if (!cancelled) setSignedUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentIdsKey]);

  if (!relevant.length) return null;

  return (
    <div className="pt-2 border-t border-stone-800/80">
      <p className="text-[11px] text-stone-400 font-semibold mb-1.5 flex items-center gap-1.5">
        <Paperclip className="w-3.5 h-3.5 text-purple-400" />
        <span>Attachments from linked tasks:</span>
      </p>
      <div className="flex flex-wrap gap-2">
        {relevant.map((att) => {
          const isImage = att.mime_type.startsWith('image/');
          const Icon = fileIcon(att.mime_type);
          const url = signedUrls[att.id];
          return isImage ? (
            <a
              key={att.id}
              href={url || undefined}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (!url) e.preventDefault();
              }}
              title={att.filename}
              className="block w-12 h-12 rounded-md overflow-hidden border border-stone-700 hover:border-purple-500/60 shrink-0 bg-stone-900"
            >
              {url ? (
                <img src={url} alt={att.filename} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <ImageIcon className="w-4 h-4 text-stone-500" />
                </div>
              )}
            </a>
          ) : (
            <a
              key={att.id}
              href={url || undefined}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (!url) e.preventDefault();
              }}
              title={att.filename}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] bg-stone-800 hover:bg-purple-900/50 text-stone-200 transition-colors border border-stone-700 max-w-[11rem]"
            >
              <Icon className="w-3.5 h-3.5 text-purple-300 shrink-0" />
              <span className="truncate">{att.filename}</span>
              <Download className="w-3 h-3 text-stone-400 shrink-0" />
            </a>
          );
        })}
      </div>
    </div>
  );
};
