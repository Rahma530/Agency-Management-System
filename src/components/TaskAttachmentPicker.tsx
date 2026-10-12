import React, { useRef, useState } from 'react';
import { FileText, Paperclip, Trash2 } from 'lucide-react';
import { StagedTaskAttachment } from '../lib/taskOperations';
import { formatTaskAttachmentSize, validateTaskAttachmentFile } from '../lib/taskAttachmentValidation';

interface TaskAttachmentPickerProps {
  files: StagedTaskAttachment[];
  onChange: (files: StagedTaskAttachment[]) => void;
  disabled?: boolean;
}

export const TaskAttachmentPicker: React.FC<TaskAttachmentPickerProps> = ({ files, onChange, disabled }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = '';
    if (selected.length === 0) return;
    const invalid = selected.map(validateTaskAttachmentFile).find(Boolean);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    onChange([
      ...files,
      ...selected.map((file) => ({ id: crypto.randomUUID(), file })),
    ]);
  };

  return (
    <div className="space-y-2">
      {files.map((entry) => (
        <div key={entry.id} className="flex items-center gap-2 rounded-lg border border-stone-800 bg-stone-900 px-2.5 py-2">
          <FileText className="h-4 w-4 shrink-0 text-purple-300" />
          <span className="min-w-0 flex-1 truncate text-xs text-stone-200">{entry.file.name}</span>
          <span className="text-[10px] text-stone-500">{formatTaskAttachmentSize(entry.file.size)}</span>
          <button
            type="button"
            onClick={() => onChange(files.filter((file) => file.id !== entry.id))}
            disabled={disabled}
            className="rounded p-1 text-stone-400 hover:text-red-400 disabled:opacity-50"
            title="Remove staged attachment"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {error && <p className="text-[11px] font-semibold text-red-400">{error}</p>}
      <input ref={inputRef} type="file" multiple onChange={handleFiles} className="hidden" />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="flex items-center gap-1.5 rounded-lg border border-purple-700/40 bg-purple-900/30 px-3 py-1.5 text-[11px] font-bold text-purple-300 hover:bg-purple-800/50 hover:text-white disabled:opacity-50"
      >
        <Paperclip className="h-3.5 w-3.5" />
        Add attachments
      </button>
    </div>
  );
};
