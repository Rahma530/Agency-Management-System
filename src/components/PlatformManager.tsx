import React, { useState } from 'react';
import { X, Plus, Save, ArrowUp, ArrowDown, EyeOff, Eye } from 'lucide-react';
import { PlatformRecord } from '../types/database';

interface PlatformManagerProps {
  platforms: PlatformRecord[];
  onCreate: (row: Omit<PlatformRecord, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onUpdate: (id: string, updates: Partial<PlatformRecord>) => Promise<void>;
  onClose: () => void;
}

/**
 * Admin screen (executive/head_of_technical only — enforced server-side by
 * platforms_write_rls/platforms_update_rls) for managing the selectable Platform list used on
 * CrossTeamTaskBoard's create/edit forms, chips, and filter. Unlike TaskTypeManager (the
 * structural model this mirrors), platforms aren't scoped to a team or role, so this is a single
 * flat list ordered by sort_order rather than grouped sublists. Reordering swaps sort_order with
 * the adjacent row. There is no delete: retiring a platform sets active=false instead, so tasks
 * already tagged with it keep a valid reference.
 */
export const PlatformManager: React.FC<PlatformManagerProps> = ({ platforms, onCreate, onUpdate, onClose }) => {
  const [newName, setNewName] = useState('');
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const sorted = [...platforms].sort((a, b) => a.sort_order - b.sort_order);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setErrorMsg('Please enter a name.');
      return;
    }
    setIsSaving(true);
    setErrorMsg('');
    try {
      await onCreate({
        name,
        sort_order: sorted.length,
        active: true,
      });
      setNewName('');
      setIsAddingNew(false);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to add this platform.');
    } finally {
      setIsSaving(false);
    }
  };

  const startEdit = (row: PlatformRecord) => {
    setEditingId(row.id);
    setEditName(row.name);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const name = editName.trim();
    if (!name) {
      setErrorMsg('Name cannot be empty.');
      return;
    }
    setIsSaving(true);
    setErrorMsg('');
    try {
      await onUpdate(editingId, { name });
      setEditingId(null);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to save this platform.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleActive = async (row: PlatformRecord) => {
    setIsSaving(true);
    setErrorMsg('');
    try {
      await onUpdate(row.id, { active: !row.active });
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to update this platform.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= sorted.length) return;
    const current = sorted[index];
    const target = sorted[targetIndex];
    setIsSaving(true);
    setErrorMsg('');
    try {
      await Promise.all([
        onUpdate(current.id, { sort_order: target.sort_order }),
        onUpdate(target.id, { sort_order: current.sort_order }),
      ]);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to reorder these platforms.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl p-5 space-y-4"
        style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-white">Manage Platforms</h3>
            <p className="text-[11px] text-stone-400 mt-0.5">
              Platform is optional on every task. Deactivating a platform hides it from new tasks
              but keeps it visible on tasks already tagged with it.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-stone-400 hover:text-white hover:bg-white/5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {errorMsg && (
          <div className="p-2.5 rounded-lg text-xs bg-red-950/30 text-red-300 border border-red-800/40">{errorMsg}</div>
        )}

        <div className="space-y-2">
          {sorted.map((row, index) => {
            const isEditing = editingId === row.id;
            return (
              <div
                key={row.id}
                className="p-3 rounded-xl border flex items-center justify-between gap-2"
                style={{
                  background: 'rgba(10, 10, 13, 0.5)',
                  borderColor: 'var(--border-soft)',
                  opacity: row.active ? 1 : 0.55,
                }}
              >
                {isEditing ? (
                  <div className="flex items-center gap-2 flex-1">
                    <input
                      type="text"
                      dir="auto"
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                    />
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-2.5 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      disabled={isSaving}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
                    >
                      <Save className="w-3 h-3" />
                      Save
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-white truncate" dir="auto">
                        {row.name}
                        {!row.active && <span className="ml-1.5 text-[10px] text-stone-500">Inactive</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleMove(index, -1)}
                        disabled={isSaving || index === 0}
                        className="p-1.5 rounded-lg text-stone-500 hover:text-white hover:bg-white/5 disabled:opacity-30"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleMove(index, 1)}
                        disabled={isSaving || index === sorted.length - 1}
                        className="p-1.5 rounded-lg text-stone-500 hover:text-white hover:bg-white/5 disabled:opacity-30"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => startEdit(row)}
                        className="px-2 py-1 rounded-lg text-[11px] text-purple-300 hover:text-white hover:bg-purple-900/40"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => handleToggleActive(row)}
                        disabled={isSaving}
                        className="p-1.5 rounded-lg text-stone-500 hover:text-white hover:bg-white/5 disabled:opacity-50"
                        title={row.active ? 'Deactivate' : 'Reactivate'}
                      >
                        {row.active ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {isAddingNew ? (
          <div className="p-3 rounded-xl border border-dashed border-purple-700/40 space-y-2">
            <input
              type="text"
              dir="auto"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Platform name"
              className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setIsAddingNew(false)}
                className="px-2.5 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={isSaving}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
              >
                <Plus className="w-3 h-3" />
                Add Platform
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setIsAddingNew(true)}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold text-purple-300 hover:text-white bg-purple-900/20 hover:bg-purple-800/40 border border-purple-700/30 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Platform
          </button>
        )}
      </div>
    </div>
  );
};
