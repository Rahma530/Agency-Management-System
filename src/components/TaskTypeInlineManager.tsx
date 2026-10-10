import React, { useState, useEffect } from 'react';
import { Plus, Settings2, Save, X, EyeOff, Eye } from 'lucide-react';
import { TaskTypeRecord, UserRole } from '../types/database';
import { AGENCY_ROLES } from '../data/roles';

interface TaskTypeInlineManagerProps {
  // Full task_types state from the parent (App.tsx), including inactive rows — this component
  // computes its own scope-filtered views rather than relying on the form's already-computed
  // active-only options list, since "Edit types" also needs inactive rows to reactivate.
  taskTypes: TaskTypeRecord[];
  scopeTeam: string;
  scopeRole?: UserRole;
  onSelectType: (id: string) => void;
  onCreateTaskType: (row: Omit<TaskTypeRecord, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onUpdateTaskType: (id: string, updates: Partial<TaskTypeRecord>) => Promise<void>;
}

type Panel = 'add' | 'edit' | null;

// Stops Enter inside the mini-panel from triggering the parent <form>'s implicit submit. Attached
// on the panel container rather than each input — React's synthetic onKeyDown still bubbles up
// from the actual input before the browser's default "submit on Enter" action for the original
// native event runs, so preventDefault() here reliably suppresses it either way.
const stopEnterSubmit = (e: React.KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
  }
};

/**
 * Inline, manager-only (executive/head_of_technical — gated by the caller) Task Type management
 * panel, shared between CrossTeamTaskBoard's create and edit forms so the add/rename/deactivate
 * flow doesn't exist twice. Writes go through the same onCreateTaskType/onUpdateTaskType props
 * CrossTeamTaskBoard already receives (direct supabase.from('task_types') calls in App.tsx — see
 * handleCreateTaskType/handleUpdateTaskType — never the proxied client). There is no delete
 * control: task_types has no DELETE policy, so retiring a type is always a deactivation.
 */
export const TaskTypeInlineManager: React.FC<TaskTypeInlineManagerProps> = ({
  taskTypes,
  scopeTeam,
  scopeRole,
  onSelectType,
  onCreateTaskType,
  onUpdateTaskType,
}) => {
  const [panel, setPanel] = useState<Panel>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newIsOther, setNewIsOther] = useState(false);
  const [scopeChoice, setScopeChoice] = useState<'team' | 'role'>(scopeRole ? 'role' : 'team');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  // Set right after a successful create; cleared once the new row shows up in the `taskTypes`
  // prop and gets auto-selected. onCreateTaskType resolves to void (App.tsx's handler doesn't
  // return the persisted row), and by the time the awaited call below returns, this component
  // hasn't necessarily re-rendered with the parent's updated taskTypes state yet — so the match
  // is done reactively in the effect below instead of synchronously after the await.
  const [pendingSelect, setPendingSelect] = useState<{ scope_type: 'team' | 'role'; scope_value: string; label: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // If the assignee is cleared while "Role" is chosen, fall back to "Team" rather than leaving a
  // disabled option selected.
  useEffect(() => {
    if (!scopeRole && scopeChoice === 'role') setScopeChoice('team');
  }, [scopeRole, scopeChoice]);

  useEffect(() => {
    if (!pendingSelect) return;
    const match = taskTypes.find(
      (t) =>
        t.scope_type === pendingSelect.scope_type &&
        t.scope_value === pendingSelect.scope_value &&
        t.label === pendingSelect.label
    );
    if (match) {
      onSelectType(match.id);
      setPendingSelect(null);
    }
  }, [taskTypes, pendingSelect, onSelectType]);

  // Every row belonging to either scope currently in play — active AND inactive, since "Edit
  // types" needs the inactive ones to reactivate, and this doubles as the existing-count basis
  // for a new row's sort_order (same logic as TaskTypeManager.tsx's admin screen).
  const relevantRows = taskTypes.filter(
    (t) =>
      (t.scope_type === 'team' && t.scope_value === scopeTeam) ||
      (t.scope_type === 'role' && !!scopeRole && t.scope_value === scopeRole)
  );

  const roleLabel = scopeRole ? AGENCY_ROLES[scopeRole]?.englishTitle || scopeRole : null;

  const togglePanel = (next: 'add' | 'edit') => {
    setErrorMsg('');
    setPanel((current) => (current === next ? null : next));
  };

  const handleCreate = async () => {
    const label = newLabel.trim();
    if (!label) {
      setErrorMsg('Please enter a label.');
      return;
    }
    const scopeValue = scopeChoice === 'team' ? scopeTeam : (scopeRole as string);
    const existingCount = taskTypes.filter(
      (t) => t.scope_type === scopeChoice && t.scope_value === scopeValue
    ).length;
    setIsSaving(true);
    setErrorMsg('');
    try {
      await onCreateTaskType({
        scope_type: scopeChoice,
        scope_value: scopeValue,
        label,
        is_other: newIsOther,
        sort_order: existingCount,
        is_active: true,
      });
      setPendingSelect({ scope_type: scopeChoice, scope_value: scopeValue, label });
      setNewLabel('');
      setNewIsOther(false);
      setPanel(null);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to add this task type.');
    } finally {
      setIsSaving(false);
    }
  };

  const startRename = (row: TaskTypeRecord) => {
    setErrorMsg('');
    setRenamingId(row.id);
    setRenameValue(row.label);
  };

  const handleSaveRename = async () => {
    if (!renamingId) return;
    const label = renameValue.trim();
    if (!label) {
      setErrorMsg('Label cannot be empty.');
      return;
    }
    setIsSaving(true);
    setErrorMsg('');
    try {
      await onUpdateTaskType(renamingId, { label });
      setRenamingId(null);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to save this task type.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleActive = async (row: TaskTypeRecord) => {
    setIsSaving(true);
    setErrorMsg('');
    try {
      await onUpdateTaskType(row.id, { is_active: !row.is_active });
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to update this task type.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => togglePanel('add')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold transition-all ${
            panel === 'add' ? 'text-white bg-purple-900/50' : 'text-purple-300 hover:text-white hover:bg-purple-900/30'
          }`}
        >
          <Plus className="w-3 h-3" />
          Add type
        </button>
        <button
          type="button"
          onClick={() => togglePanel('edit')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold transition-all ${
            panel === 'edit' ? 'text-white bg-white/10' : 'text-stone-400 hover:text-white hover:bg-white/5'
          }`}
        >
          <Settings2 className="w-3 h-3" />
          Edit types
        </button>
      </div>

      {errorMsg && (
        <div className="p-2 rounded-lg text-[11px] bg-red-950/30 text-red-300 border border-red-800/40">{errorMsg}</div>
      )}

      {panel === 'add' && (
        <div className="p-2.5 rounded-lg border border-dashed border-purple-700/40 space-y-2" onKeyDown={stopEnterSubmit}>
          <input
            type="text"
            dir="auto"
            autoFocus
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Task type label"
            className="w-full px-2 py-1.5 rounded-lg text-[11px] bg-stone-900 border border-stone-800 text-white"
          />
          <div className="flex items-center gap-3 flex-wrap text-[11px] text-stone-300">
            <label className="flex items-center gap-1">
              <input type="radio" checked={scopeChoice === 'team'} onChange={() => setScopeChoice('team')} />
              Team: {scopeTeam}
            </label>
            <label className={`flex items-center gap-1 ${!scopeRole ? 'opacity-50' : ''}`}>
              <input
                type="radio"
                checked={scopeChoice === 'role'}
                disabled={!scopeRole}
                onChange={() => setScopeChoice('role')}
              />
              Role: {roleLabel || '—'}
            </label>
            {!scopeRole && <span className="text-[10px] text-amber-400">choose an assignee first</span>}
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-stone-300">
            <input type="checkbox" checked={newIsOther} onChange={(e) => setNewIsOther(e.target.checked)} />
            This is the "Other" option (free-text on the task form)
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPanel(null)}
              className="px-2 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={isSaving}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
            >
              <Plus className="w-3 h-3" />
              Save
            </button>
          </div>
        </div>
      )}

      {panel === 'edit' && (
        <div
          className="p-2.5 rounded-lg border border-stone-800 space-y-1.5 max-h-56 overflow-y-auto"
          onKeyDown={stopEnterSubmit}
        >
          {relevantRows.length === 0 && (
            <p className="text-[11px] text-stone-500">No task types yet for this scope.</p>
          )}
          {relevantRows.map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between gap-2 py-1"
              style={{ opacity: row.is_active ? 1 : 0.55 }}
            >
              {renamingId === row.id ? (
                <div className="flex items-center gap-1.5 flex-1">
                  <input
                    type="text"
                    dir="auto"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    className="flex-1 px-2 py-1 rounded-lg text-[11px] bg-stone-900 border border-stone-800 text-white"
                  />
                  <button
                    type="button"
                    onClick={() => setRenamingId(null)}
                    className="px-1.5 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveRename}
                    disabled={isSaving}
                    className="px-1.5 py-1 rounded-lg text-[11px] text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
                  >
                    <Save className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <>
                  <span className="text-[11px] text-stone-200 truncate" dir="auto">
                    {row.label}
                    {row.is_other && <span className="ml-1 text-amber-400">(Other)</span>}
                    {!row.is_active && <span className="ml-1 text-stone-500">Inactive</span>}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => startRename(row)}
                      className="px-1.5 py-0.5 rounded-lg text-[10px] text-purple-300 hover:text-white hover:bg-purple-900/40"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleActive(row)}
                      disabled={isSaving}
                      className="p-1 rounded-lg text-stone-500 hover:text-white hover:bg-white/5 disabled:opacity-50"
                      title={row.is_active ? 'Deactivate' : 'Reactivate'}
                    >
                      {row.is_active ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
