import React, { useState } from 'react';
import { X, AlertCircle } from 'lucide-react';
import { ClientRecord, DailyLogRecord, TaskRecord, TaskStatus } from '../types/database';

interface DailyLogEditModalProps {
  log: DailyLogRecord;
  clients: ClientRecord[];
  // Full tasks list — filtered internally to the log author's own tasks, same as each host's own
  // linked-tasks checklist.
  tasks: TaskRecord[];
  onSave: (updates: {
    date: string;
    summary_text: string;
    linked_task_ids: string[];
    client_id: string | null;
  }) => Promise<void>;
  onClose: () => void;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  completed: 'Completed',
  blocked: 'Blocked',
  closed: 'Closed',
};

// Single-row edit form for an existing daily_logs entry, shared by DailyOperationsModule.tsx,
// MyWorkHub.tsx and ReportsHub.tsx. Unlike the create form, this never splits into multiple
// clients — editing changes the one row in place, so Client here is a plain single <select>, not
// DailyLogClientPicker's multi-select checklist. The caller (onSave) is responsible for actually
// calling onUpdateDailyLog and for the 7-day-own-log eligibility check (lib/dailyLogs.ts) that
// decides whether this modal is ever opened at all.
export const DailyLogEditModal: React.FC<DailyLogEditModalProps> = ({ log, clients, tasks, onSave, onClose }) => {
  const [date, setDate] = useState(log.date);
  const [clientId, setClientId] = useState(log.client_id || '');
  const [summaryText, setSummaryText] = useState(log.summary_text);
  const [linkedTaskIds, setLinkedTaskIds] = useState<string[]>(log.linked_task_ids || []);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownTasks = tasks.filter((t) => t.assigned_to === log.user_id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!summaryText.trim()) return;
    setIsSaving(true);
    try {
      await onSave({
        date,
        summary_text: summaryText.trim(),
        linked_task_ids: linkedTaskIds,
        client_id: clientId || null,
      });
    } catch (err: any) {
      setError(err?.message || 'Unable to update this log.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        className="w-full max-w-xl rounded-[20px] p-6 space-y-4 border shadow-2xl relative"
        style={{ background: 'var(--surface-dark)', borderColor: 'var(--border-strong)' }}
      >
        <div className="flex items-start justify-between pb-3 border-b border-stone-800">
          <h3 className="text-sm font-bold text-white">Edit Daily Log</h3>
          <button onClick={onClose} className="p-1 rounded-lg text-stone-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-xl text-xs flex items-center justify-between gap-3 bg-[rgba(245,163,163,0.15)] border border-[var(--roas-bad)] text-[var(--roas-bad)]">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="font-semibold">{error}</span>
            </div>
            <button type="button" onClick={() => setError(null)} className="text-xs opacity-70 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-[11px] font-semibold text-stone-400 block mb-1">Report Date:</label>
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full p-2.5 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-stone-400 block mb-1">Client (optional):</label>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full p-2.5 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500"
            >
              <option value="" className="bg-stone-900 text-stone-400">-- Not specific to one client --</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id} className="bg-stone-900 text-white">
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-stone-300 block mb-1.5">
              Summary of work and next steps:
            </label>
            <textarea
              rows={4}
              required
              value={summaryText}
              onChange={(e) => setSummaryText(e.target.value)}
              className="w-full p-3 rounded-xl text-xs bg-stone-900 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-500"
            />
          </div>

          {ownTasks.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-stone-300 block mb-1.5">Linked tasks:</label>
              <div className="max-h-36 overflow-y-auto p-2.5 rounded-xl bg-stone-900/90 border border-stone-800 space-y-1.5">
                {ownTasks.map((t) => {
                  const isChecked = linkedTaskIds.includes(t.id);
                  return (
                    <label
                      key={t.id}
                      className="flex items-center gap-2 p-1.5 rounded hover:bg-stone-800 cursor-pointer text-xs text-stone-300"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          setLinkedTaskIds(
                            e.target.checked
                              ? [...linkedTaskIds, t.id]
                              : linkedTaskIds.filter((id) => id !== t.id)
                          );
                        }}
                        className="rounded border-stone-700 text-purple-600 focus:ring-0"
                      />
                      <span className="font-semibold text-white">{t.title}</span>
                      <span className="text-[10px] text-stone-500 ml-auto">({STATUS_LABELS[t.status]})</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-bold text-stone-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-5 py-2 rounded-xl text-xs font-bold text-white transition-all shadow-lg hover:opacity-90 disabled:opacity-50"
              style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
