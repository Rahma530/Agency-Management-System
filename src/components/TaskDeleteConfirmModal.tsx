import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface TaskDeleteConfirmModalProps {
  taskNames: string[];
  subtaskCount: number;
  commentCount: number;
  attachmentCount: number;
  isDeleting: boolean;
  error: string | null;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

// Shared by the single-task delete button (Task Details modal) and the multi-select bulk delete
// button (Table view) — both pass in whatever computeTaskDeletionPreview (lib/taskOperations.ts)
// already told them about the subtree this selection will take down. Typing the literal word
// DELETE is the only way to enable the confirm button — this action is permanent (delete_tasks()
// is a real hard delete, not a status change or soft-archive).
export const TaskDeleteConfirmModal: React.FC<TaskDeleteConfirmModalProps> = ({
  taskNames,
  subtaskCount,
  commentCount,
  attachmentCount,
  isDeleting,
  error,
  onConfirm,
  onClose,
}) => {
  const [confirmText, setConfirmText] = useState('');
  const canConfirm = confirmText.trim() === 'DELETE' && !isDeleting;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        className="w-full max-w-md rounded-[22px] p-6 space-y-4 shadow-2xl relative"
        style={{ background: 'var(--gradient-hero)', border: '1px solid var(--border-medium)' }}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 text-red-400">
            <AlertTriangle className="w-5 h-5" />
            <h3 className="text-base font-bold text-white">Delete {taskNames.length > 1 ? `${taskNames.length} tasks` : 'task'} permanently?</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-stone-400 hover:text-white" disabled={isDeleting}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-3 rounded-xl bg-stone-900/80 border border-stone-800 text-xs text-stone-300 space-y-1 max-h-32 overflow-y-auto">
          {taskNames.map((name, i) => (
            <p key={i} className="font-semibold text-stone-200">{name}</p>
          ))}
        </div>

        <div className="p-3 rounded-xl bg-red-950/40 border border-red-800/50 text-xs text-red-300 space-y-1">
          <p>This cannot be undone. It will also permanently remove:</p>
          <ul className="list-disc list-inside font-semibold">
            <li>{subtaskCount} subtask{subtaskCount === 1 ? '' : 's'}</li>
            <li>{commentCount} comment{commentCount === 1 ? '' : 's'}</li>
            <li>{attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}</li>
          </ul>
        </div>

        <div>
          <label className="text-[11px] font-semibold text-stone-400 block mb-1">
            Type DELETE to confirm:
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="DELETE"
            disabled={isDeleting}
            className="w-full px-3 py-2 rounded-xl bg-stone-900/80 border border-stone-700 text-white text-sm focus:outline-none focus:border-red-500"
          />
        </div>

        {error && (
          <p className="text-xs text-red-400 font-semibold">{error}</p>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2 rounded-xl text-xs font-bold bg-stone-800 text-stone-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className="px-4 py-2 rounded-xl text-xs font-bold bg-red-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-red-500"
          >
            {isDeleting ? 'Deleting...' : 'Delete Permanently'}
          </button>
        </div>
      </div>
    </div>
  );
};
