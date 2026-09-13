import React, { useEffect, useRef, useState } from 'react';
import { Video, Upload, Download, Loader2, Info, Save } from 'lucide-react';
import { ClientRecord, MeetingRecord, UserRecord } from '../types/database';
import { supabase } from '../lib/supabase';

// Mirrors the meeting-recordings bucket's own allowed_mime_types/file_size_limit (see
// 20260914110000_meetings_write_and_recordings.sql) — client-side feedback only, Storage
// enforces both server-side regardless.
const ALLOWED_MIME_TYPES = [
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/x-m4a',
];
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024; // 200MB
const SIGNED_URL_TTL_SECONDS = 300;

const formatFileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

interface ClientMeetingsPanelProps {
  client: ClientRecord;
  meetings: MeetingRecord[];
  users: UserRecord[];
  canUpload: boolean;
  onUploadRecording: (clientId: string, meetingDate: string, file: File) => Promise<void>;
  onSaveMeetingNotes: (
    meetingId: string,
    updates: { transcript_text?: string; ai_summary_text?: string }
  ) => Promise<void>;
}

// Module 9, point 5: scaffolding only — recording upload + manual transcript/summary entry.
// transcript_text/ai_summary_text are plain typed text today; there is no real transcription or
// summarization here, and every save label below says so explicitly rather than implying an AI
// wrote it. Real automation is a later phase, once an actual AI API is available.
export const ClientMeetingsPanel: React.FC<ClientMeetingsPanelProps> = ({
  client,
  meetings,
  users,
  canUpload,
  onUploadRecording,
  onSaveMeetingNotes,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [meetingDate, setMeetingDate] = useState(new Date().toISOString().split('T')[0]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [draftNotes, setDraftNotes] = useState<Record<string, { transcript_text: string; ai_summary_text: string }>>({});
  const [savingMeetingId, setSavingMeetingId] = useState<string | null>(null);

  const clientMeetings = meetings
    .filter((m) => m.client_id === client.id)
    .sort((a, b) => b.meeting_date.localeCompare(a.meeting_date));
  const meetingIdsKey = clientMeetings.map((m) => m.id).join(',');

  // Private bucket — every playback/download link is a short-lived signed URL, never a
  // permanent public one, same pattern as TaskAttachmentList.tsx.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        clientMeetings
          .filter((m) => m.recording_url)
          .map(async (m) => {
            const { data } = await supabase.storage
              .from('meeting-recordings')
              .createSignedUrl(m.recording_url!, SIGNED_URL_TTL_SECONDS);
            return [m.id, data?.signedUrl || ''] as const;
          })
      );
      if (!cancelled) setSignedUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingIdsKey]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError(null);

    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      setUploadError(`File type not allowed (${file.type || 'unknown'}). Allowed: MP4/MOV/WebM video or MP3/WAV/M4A audio.`);
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setUploadError(`File too large (${formatFileSize(file.size)}) — the limit is 200MB.`);
      return;
    }

    setIsUploading(true);
    try {
      await onUploadRecording(client.id, meetingDate, file);
    } catch (err) {
      console.error(err);
      setUploadError('Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const getDraft = (meeting: MeetingRecord) =>
    draftNotes[meeting.id] ?? {
      transcript_text: meeting.transcript_text || '',
      ai_summary_text: meeting.ai_summary_text || '',
    };

  const handleSaveNotes = async (meeting: MeetingRecord) => {
    const draft = getDraft(meeting);
    setSavingMeetingId(meeting.id);
    try {
      await onSaveMeetingNotes(meeting.id, draft);
      setDraftNotes((prev) => {
        const next = { ...prev };
        delete next[meeting.id];
        return next;
      });
    } finally {
      setSavingMeetingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div
        className="p-3 rounded-xl text-[11px] flex items-start gap-2"
        style={{ background: 'rgba(123, 47, 247, 0.08)', border: '1px solid var(--border-soft)', color: 'var(--lilac)' }}
      >
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          Scaffolding only — upload a recording and enter the transcript/summary manually. Real automated transcription
          and summarization require an AI service this app does not yet have access to.
        </span>
      </div>

      {canUpload && (
        <div className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-3">
          <h3 className="text-xs font-bold text-white flex items-center gap-2">
            <Video className="w-4 h-4 text-purple-400" />
            <span>Upload Meeting Recording</span>
          </h3>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={meetingDate}
              onChange={(e) => setMeetingDate(e.target.value)}
              className="px-3 py-2 rounded-xl text-xs bg-[#100c1c] border border-purple-900/50 text-white focus:outline-none focus:border-purple-400"
            />
            <input ref={fileInputRef} type="file" onChange={handleFileSelect} className="hidden" />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold text-white shadow-md hover:opacity-90 disabled:opacity-50 transition-all"
              style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
            >
              {isUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              <span>{isUploading ? 'Uploading...' : 'Upload Recording'}</span>
            </button>
          </div>
          {uploadError && <p className="text-[11px] text-red-400 font-semibold">{uploadError}</p>}
        </div>
      )}

      {clientMeetings.length === 0 ? (
        <p className="text-xs text-stone-500 py-6 text-center">No meetings logged yet for this client.</p>
      ) : (
        <div className="space-y-3">
          {clientMeetings.map((meeting) => {
            const amAgent = users.find((u) => u.id === meeting.am_agent_id);
            const url = signedUrls[meeting.id];
            const draft = getDraft(meeting);
            const isDirty =
              draft.transcript_text !== (meeting.transcript_text || '') ||
              draft.ai_summary_text !== (meeting.ai_summary_text || '');

            return (
              <div key={meeting.id} className="p-4 rounded-xl border border-purple-900/30 bg-[#161224]/80 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <p className="text-xs font-bold text-white font-mono">{meeting.meeting_date}</p>
                    <p className="text-[11px] text-stone-400">Logged by {amAgent?.name || 'Unknown'}</p>
                  </div>
                  {meeting.recording_url && (
                    <a
                      href={url || undefined}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => {
                        if (!url) e.preventDefault();
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Recording</span>
                    </a>
                  )}
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-stone-400 block mb-1">
                    Transcript (manually entered — pending real AI transcription)
                  </label>
                  <textarea
                    value={draft.transcript_text}
                    onChange={(e) =>
                      setDraftNotes((prev) => ({ ...prev, [meeting.id]: { ...getDraft(meeting), transcript_text: e.target.value } }))
                    }
                    disabled={!canUpload}
                    rows={3}
                    placeholder="Paste or type the meeting transcript..."
                    className="w-full px-3 py-2 rounded-lg text-xs bg-black/30 border border-stone-800 text-white outline-none focus:border-purple-400 disabled:opacity-60"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-stone-400 block mb-1">
                    Summary (manually entered — pending real AI summarization)
                  </label>
                  <textarea
                    value={draft.ai_summary_text}
                    onChange={(e) =>
                      setDraftNotes((prev) => ({ ...prev, [meeting.id]: { ...getDraft(meeting), ai_summary_text: e.target.value } }))
                    }
                    disabled={!canUpload}
                    rows={2}
                    placeholder="Key takeaways, decisions, action items..."
                    className="w-full px-3 py-2 rounded-lg text-xs bg-black/30 border border-stone-800 text-white outline-none focus:border-purple-400 disabled:opacity-60"
                  />
                </div>

                {canUpload && (
                  <div className="flex items-center justify-end">
                    <button
                      onClick={() => handleSaveNotes(meeting)}
                      disabled={!isDirty || savingMeetingId === meeting.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-purple-200 bg-purple-900/40 hover:bg-purple-800/60 hover:text-white border border-purple-700/40 transition-all disabled:opacity-40"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>{savingMeetingId === meeting.id ? 'Saving...' : 'Save Notes'}</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
