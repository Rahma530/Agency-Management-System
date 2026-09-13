import React, { useState } from 'react';
import { History, ChevronDown, ChevronRight } from 'lucide-react';
import { BriefFieldDef, BriefRevisionRecord, UserRecord } from '../types/database';
import { BriefFieldsReadOnly } from './BriefFieldsReadOnly';

interface BriefEditHistoryProps {
  revisions: BriefRevisionRecord[];
  fieldDefs: BriefFieldDef[];
  // A past revision reuses the brief's CURRENT custom questions rather than tracking its own
  // per-version question set — brief_revisions only snapshots answers (`fields`), not the
  // question list itself, since questions rarely change after being added.
  customFieldDefs?: BriefFieldDef[];
  users?: UserRecord[];
}

const timeAgo = (iso: string): string => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

/**
 * Expandable, newest-first list of every past save for a brief. Each row shows who edited it and
 * when; expanding a row renders that version's full field snapshot via the same
 * BriefFieldsReadOnly renderer used for the current version — no field-level diffing this phase,
 * just full versions side by side in time.
 */
export const BriefEditHistory: React.FC<BriefEditHistoryProps> = ({ revisions, fieldDefs, customFieldDefs, users = [] }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  const sorted = [...revisions].sort((a, b) => b.version - a.version);
  const editorName = (userId: string) => users.find((u) => u.id === userId)?.name || userId;

  return (
    <div className="rounded-xl border border-purple-900/30 bg-[#161224]/60 overflow-hidden">
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-stone-300 hover:text-white transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <History className="w-3.5 h-3.5 text-purple-400" />
          <span>Edit History ({sorted.length})</span>
        </span>
        {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>

      {isOpen && (
        <div className="border-t border-purple-900/30 divide-y divide-purple-900/20">
          {sorted.length === 0 ? (
            <p className="p-3 text-xs text-stone-500">No revisions recorded yet.</p>
          ) : (
            sorted.map((rev) => {
              const expanded = expandedVersion === rev.version;
              return (
                <div key={rev.id}>
                  <button
                    onClick={() => setExpandedVersion(expanded ? null : rev.version)}
                    className="w-full px-3 py-2 flex items-center justify-between text-xs hover:bg-purple-950/20 transition-colors"
                  >
                    <span className="flex items-center gap-2 text-stone-300">
                      <span className="font-mono font-bold text-purple-300">v{rev.version}</span>
                      <span>{editorName(rev.edited_by)}</span>
                    </span>
                    <span className="flex items-center gap-2 text-stone-500">
                      <span>{timeAgo(rev.edited_at)}</span>
                      {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    </span>
                  </button>
                  {expanded && (
                    <div className="p-3 bg-black/20">
                      <BriefFieldsReadOnly fields={rev.fields} fieldDefs={fieldDefs} customFieldDefs={customFieldDefs} />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
