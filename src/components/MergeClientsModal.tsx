import React, { useMemo, useState } from 'react';
import { AlertTriangle, Merge, Search, X } from 'lucide-react';
import { ClientRecord, UserRecord } from '../types/database';

type PreviewTable = { moved?: number; deleted_duplicates?: number; count?: number };
type PreviewResult = Record<string, PreviewTable>;

interface MergeClientsModalProps {
  initialCandidateIds: string[];
  clients: ClientRecord[];
  users: UserRecord[];
  onPreviewMerge: (keepId: string, duplicateId: string) => Promise<PreviewResult>;
  onMergeClients: (
    keepId: string,
    duplicateIds: string[]
  ) => Promise<{ succeeded: string[]; failed: { id: string; error: string } | null }>;
  onClose: () => void;
}

const resolveAmName = (client: ClientRecord, users: UserRecord[]): string => {
  const agent = users.find((u) => u.id === client.am_agent_id);
  if (agent) return agent.name;
  const lead = users.find((u) => u.id === client.am_team_lead_id);
  if (lead) return lead.name;
  return 'Unassigned';
};

// Shared by two entry points: AMQueue.tsx's "Merge selected" (2+ checked rows in the Client
// Portfolio table — initialCandidateIds pre-filled, nothing picked as keep yet) and
// ClientDashboard.tsx's single-client "Merge this client" button (initialCandidateIds = just
// that one client, meant to end up as a duplicate once the user searches for who to keep). Either
// way: pick exactly one candidate as "keep" via radio; everything else in the set is a duplicate.
export const MergeClientsModal: React.FC<MergeClientsModalProps> = ({
  initialCandidateIds,
  clients,
  users,
  onPreviewMerge,
  onMergeClients,
  onClose,
}) => {
  const [candidateIds, setCandidateIds] = useState<string[]>(initialCandidateIds);
  const [keepId, setKeepId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [step, setStep] = useState<'select' | 'review' | 'result'>('select');
  const [previews, setPreviews] = useState<Record<string, PreviewResult | 'loading' | 'error'>>({});
  const [confirmText, setConfirmText] = useState('');
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [result, setResult] = useState<{ succeeded: string[]; failed: { id: string; error: string } | null } | null>(null);

  const candidates = candidateIds
    .map((id) => clients.find((c) => c.id === id))
    .filter((c): c is ClientRecord => !!c);
  const duplicateIds = candidateIds.filter((id) => id !== keepId);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return clients
      .filter((c) => !candidateIds.includes(c.id))
      .filter((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || (c.industry || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [clients, candidateIds, searchQuery]);

  const addCandidate = (id: string) => {
    setCandidateIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setSearchQuery('');
  };

  const removeCandidate = (id: string) => {
    setCandidateIds((prev) => prev.filter((c) => c !== id));
    if (keepId === id) setKeepId(null);
  };

  const canReview = !!keepId && duplicateIds.length > 0;

  const handleReview = async () => {
    if (!canReview || !keepId) return;
    setIsLoadingPreviews(true);
    setStep('review');
    const next: Record<string, PreviewResult | 'loading' | 'error'> = {};
    duplicateIds.forEach((id) => { next[id] = 'loading'; });
    setPreviews(next);
    for (const duplicateId of duplicateIds) {
      try {
        const preview = await onPreviewMerge(keepId, duplicateId);
        setPreviews((prev) => ({ ...prev, [duplicateId]: preview }));
      } catch {
        setPreviews((prev) => ({ ...prev, [duplicateId]: 'error' }));
      }
    }
    setIsLoadingPreviews(false);
  };

  const canConfirm = confirmText.trim() === 'MERGE' && !isMerging;

  const handleConfirm = async () => {
    if (!canConfirm || !keepId) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const outcome = await onMergeClients(keepId, duplicateIds);
      setResult(outcome);
      setStep('result');
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Unable to merge these clients.');
    } finally {
      setIsMerging(false);
    }
  };

  const renderPreviewTable = (preview: PreviewResult) => {
    const entries = Object.entries(preview).filter(([, v]) => (v.moved || 0) > 0 || (v.deleted_duplicates || 0) > 0 || (v.count || 0) > 0);
    if (entries.length === 0) return <p className="text-[11px] text-stone-400">No related records found.</p>;
    return (
      <ul className="space-y-1">
        {entries.map(([table, v]) => (
          <li key={table} className="text-[11px] text-stone-300 flex items-center justify-between">
            <span className="font-mono">{table}</span>
            <span>
              {v.count !== undefined && <span>{v.count} record(s) will move</span>}
              {v.moved !== undefined && <span>{v.moved} will move</span>}
              {!!v.deleted_duplicates && (
                <span className="text-red-400 font-bold ml-1.5">· {v.deleted_duplicates} conflicting will be deleted</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        className="w-full max-w-xl rounded-[22px] p-6 space-y-4 shadow-2xl relative max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--gradient-hero)', border: '1px solid var(--border-medium)' }}
      >
        <div className="flex items-start justify-between">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Merge className="w-5 h-5 text-purple-400" />
            Merge Duplicate Clients
          </h3>
          <button onClick={onClose} disabled={isMerging} className="p-1 rounded-lg text-stone-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {step === 'select' && (
          <>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name, id, or industry to add a client..."
                className="w-full pl-9 pr-3 py-2 rounded-xl bg-stone-900/80 border border-stone-700 text-white text-sm"
              />
              {searchResults.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-xl border border-stone-700 bg-stone-900 shadow-xl overflow-hidden">
                  {searchResults.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => addCandidate(c.id)}
                      className="w-full text-left px-3 py-2 text-xs text-stone-200 hover:bg-purple-900/40"
                    >
                      {c.name} <span className="text-stone-500 font-mono">({c.id})</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {candidates.length === 0 && (
                <p className="text-xs text-stone-400 text-center py-4">Search above to add clients to merge.</p>
              )}
              {candidates.map((c) => (
                <div key={c.id} className="p-2.5 rounded-xl bg-stone-900/70 border border-stone-800 flex items-center gap-3">
                  <input
                    type="radio"
                    name="merge-keep"
                    checked={keepId === c.id}
                    onChange={() => setKeepId(c.id)}
                    title="Keep this client"
                  />
                  <div className="flex-1 text-xs text-stone-200">
                    <span className="font-bold text-white">{c.name}</span>{' '}
                    <span className="text-stone-500 font-mono">{c.id}</span>
                    <div className="text-[10px] text-stone-400">
                      {c.industry || 'General Business'} · AM: {resolveAmName(c, users)} · {c.status}
                    </div>
                  </div>
                  {keepId === c.id && (
                    <span className="text-[10px] font-bold text-emerald-400 uppercase shrink-0">Keep</span>
                  )}
                  <button onClick={() => removeCandidate(c.id)} className="p-1 text-stone-500 hover:text-red-400 shrink-0">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="px-4 py-2 rounded-xl text-xs font-bold bg-stone-800 text-stone-300 hover:text-white">
                Cancel
              </button>
              <button
                onClick={handleReview}
                disabled={!canReview}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-purple-700 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-purple-600"
              >
                Review Merge ({duplicateIds.length} duplicate{duplicateIds.length === 1 ? '' : 's'})
              </button>
            </div>
          </>
        )}

        {step === 'review' && (
          <>
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {duplicateIds.map((id) => {
                const client = clients.find((c) => c.id === id);
                const preview = previews[id];
                return (
                  <div key={id} className="p-3 rounded-xl bg-stone-900/70 border border-stone-800">
                    <p className="text-xs font-bold text-white mb-1.5">{client?.name || id} <span className="text-red-400 font-normal">(will be deleted)</span></p>
                    {preview === 'loading' && <p className="text-[11px] text-stone-400">Loading preview...</p>}
                    {preview === 'error' && <p className="text-[11px] text-red-400">Unable to load preview for this client.</p>}
                    {preview && preview !== 'loading' && preview !== 'error' && renderPreviewTable(preview)}
                  </div>
                );
              })}
            </div>

            <div className="p-3 rounded-xl bg-red-950/40 border border-red-800/50 text-xs text-red-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>This cannot be undone. Conflicting rows (shown above) are deleted, not moved.</p>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-stone-400 block mb-1">Type MERGE to confirm:</label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="MERGE"
                disabled={isMerging}
                className="w-full px-3 py-2 rounded-xl bg-stone-900/80 border border-stone-700 text-white text-sm focus:outline-none focus:border-red-500"
              />
            </div>

            {mergeError && <p className="text-xs text-red-400 font-semibold">{mergeError}</p>}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setStep('select')}
                disabled={isMerging}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-stone-800 text-stone-300 hover:text-white"
              >
                Back
              </button>
              <button
                onClick={handleConfirm}
                disabled={!canConfirm || isLoadingPreviews}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-red-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-red-500"
              >
                {isMerging ? 'Merging...' : 'Merge Permanently'}
              </button>
            </div>
          </>
        )}

        {step === 'result' && result && (
          <>
            <div className="space-y-2">
              {result.succeeded.length > 0 && (
                <p className="text-xs text-emerald-400">
                  Merged successfully: {result.succeeded.map((id) => clients.find((c) => c.id === id)?.name || id).join(', ')}
                </p>
              )}
              {result.failed && (
                <>
                  <p className="text-xs text-red-400 font-semibold">
                    Stopped at {clients.find((c) => c.id === result.failed!.id)?.name || result.failed.id}: {result.failed.error}
                  </p>
                  {duplicateIds.filter((id) => !result.succeeded.includes(id) && id !== result.failed!.id).length > 0 && (
                    <p className="text-xs text-stone-400">
                      Not attempted: {duplicateIds
                        .filter((id) => !result.succeeded.includes(id) && id !== result.failed!.id)
                        .map((id) => clients.find((c) => c.id === id)?.name || id)
                        .join(', ')}
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="flex justify-end">
              <button onClick={onClose} className="px-4 py-2 rounded-xl text-xs font-bold bg-purple-700 text-white hover:bg-purple-600">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
