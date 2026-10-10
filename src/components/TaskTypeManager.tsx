import React, { useState } from 'react';
import { X, Plus, Save, ArrowUp, ArrowDown, EyeOff, Eye } from 'lucide-react';
import { TaskTypeRecord } from '../types/database';
import { OPERATIONAL_TEAMS, OperationalTeam } from '../lib/departmentStaffing';
import { AGENCY_ROLES } from '../data/roles';
import { UserRole } from '../types/database';

interface TaskTypeManagerProps {
  taskTypes: TaskTypeRecord[];
  onCreate: (row: Omit<TaskTypeRecord, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onUpdate: (id: string, updates: Partial<TaskTypeRecord>) => Promise<void>;
  onClose: () => void;
}

const ROLE_OPTIONS = Object.values(AGENCY_ROLES) as { role: UserRole; englishTitle: string }[];

type ScopeType = 'team' | 'role';

const scopeValueLabel = (scopeType: ScopeType, scopeValue: string) =>
  scopeType === 'role'
    ? ROLE_OPTIONS.find((r) => r.role === scopeValue)?.englishTitle || scopeValue
    : scopeValue;

const groupKey = (row: TaskTypeRecord) => `${row.scope_type}::${row.scope_value}`;

/**
 * Admin screen (executive/head_of_technical only — enforced server-side by
 * task_types_write_rls/task_types_update_rls) for managing the selectable Task Type list used on
 * CrossTeamTaskBoard's create/edit forms. Rows are grouped by scope (a team or a role); within a
 * group, reordering swaps sort_order with the adjacent row. There is no delete: retiring a type
 * sets is_active=false instead, so tasks that already reference it keep a valid reference.
 */
export const TaskTypeManager: React.FC<TaskTypeManagerProps> = ({ taskTypes, onCreate, onUpdate, onClose }) => {
  const [newScopeType, setNewScopeType] = useState<ScopeType>('team');
  const [newScopeValue, setNewScopeValue] = useState<string>(OPERATIONAL_TEAMS[0]);
  const [newLabel, setNewLabel] = useState('');
  const [newIsOther, setNewIsOther] = useState(false);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const groups = new Map<string, TaskTypeRecord[]>();
  for (const row of taskTypes) {
    const key = groupKey(row);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.sort_order - b.sort_order);
  const sortedGroupKeys = [...groups.keys()].sort();

  const handleCreate = async () => {
    const label = newLabel.trim();
    if (!label) {
      setErrorMsg('Please enter a label.');
      return;
    }
    const existingInGroup = groups.get(`${newScopeType}::${newScopeValue}`) || [];
    setIsSaving(true);
    setErrorMsg('');
    try {
      await onCreate({
        scope_type: newScopeType,
        scope_value: newScopeValue,
        label,
        is_other: newIsOther,
        sort_order: existingInGroup.length,
        is_active: true,
      });
      setNewLabel('');
      setNewIsOther(false);
      setIsAddingNew(false);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to add this task type.');
    } finally {
      setIsSaving(false);
    }
  };

  const startEdit = (row: TaskTypeRecord) => {
    setEditingId(row.id);
    setEditLabel(row.label);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const label = editLabel.trim();
    if (!label) {
      setErrorMsg('Label cannot be empty.');
      return;
    }
    setIsSaving(true);
    setErrorMsg('');
    try {
      await onUpdate(editingId, { label });
      setEditingId(null);
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
      await onUpdate(row.id, { is_active: !row.is_active });
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to update this task type.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleMove = async (list: TaskTypeRecord[], index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= list.length) return;
    const current = list[index];
    const target = list[targetIndex];
    setIsSaving(true);
    setErrorMsg('');
    try {
      await Promise.all([
        onUpdate(current.id, { sort_order: target.sort_order }),
        onUpdate(target.id, { sort_order: current.sort_order }),
      ]);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to reorder these task types.');
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
            <h3 className="text-sm font-bold text-white">Manage Task Types</h3>
            <p className="text-[11px] text-stone-400 mt-0.5">
              Task Type is optional on every task. Deactivating a type hides it from new tasks but
              keeps it visible on tasks already tagged with it.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-stone-400 hover:text-white hover:bg-white/5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {errorMsg && (
          <div className="p-2.5 rounded-lg text-xs bg-red-950/30 text-red-300 border border-red-800/40">{errorMsg}</div>
        )}

        <div className="space-y-4">
          {sortedGroupKeys.map((key) => {
            const list = groups.get(key)!;
            const [scopeType, scopeValue] = key.split('::') as [ScopeType, string];
            return (
              <div key={key} className="space-y-2">
                <p className="text-[11px] font-bold text-purple-300 uppercase tracking-wide">
                  {scopeType === 'team' ? 'Team' : 'Role'}: {scopeValueLabel(scopeType, scopeValue)}
                </p>
                {list.map((row, index) => {
                  const isEditing = editingId === row.id;
                  return (
                    <div
                      key={row.id}
                      className="p-3 rounded-xl border flex items-center justify-between gap-2"
                      style={{
                        background: 'rgba(10, 10, 13, 0.5)',
                        borderColor: 'var(--border-soft)',
                        opacity: row.is_active ? 1 : 0.55,
                      }}
                    >
                      {isEditing ? (
                        <div className="flex items-center gap-2 flex-1">
                          <input
                            type="text"
                            dir="auto"
                            autoFocus
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
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
                              {row.label}
                              {row.is_other && <span className="ml-1.5 text-[10px] text-amber-400">(Other)</span>}
                              {!row.is_active && <span className="ml-1.5 text-[10px] text-stone-500">Inactive</span>}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => handleMove(list, index, -1)}
                              disabled={isSaving || index === 0}
                              className="p-1.5 rounded-lg text-stone-500 hover:text-white hover:bg-white/5 disabled:opacity-30"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleMove(list, index, 1)}
                              disabled={isSaving || index === list.length - 1}
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
                              title={row.is_active ? 'Deactivate' : 'Reactivate'}
                            >
                              {row.is_active ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {isAddingNew ? (
          <div className="p-3 rounded-xl border border-dashed border-purple-700/40 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <select
                value={newScopeType}
                onChange={(e) => {
                  const scopeType = e.target.value as ScopeType;
                  setNewScopeType(scopeType);
                  setNewScopeValue(scopeType === 'team' ? OPERATIONAL_TEAMS[0] : ROLE_OPTIONS[0].role);
                }}
                className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
              >
                <option value="team">Team</option>
                <option value="role">Role</option>
              </select>
              <select
                value={newScopeValue}
                onChange={(e) => setNewScopeValue(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
              >
                {newScopeType === 'team'
                  ? OPERATIONAL_TEAMS.map((team: OperationalTeam) => (
                      <option key={team} value={team}>{team}</option>
                    ))
                  : ROLE_OPTIONS.map((r) => (
                      <option key={r.role} value={r.role}>{r.englishTitle}</option>
                    ))}
              </select>
            </div>
            <input
              type="text"
              dir="auto"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Task type label"
              className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
            />
            <label className="flex items-center gap-1.5 text-[11px] text-stone-300">
              <input type="checkbox" checked={newIsOther} onChange={(e) => setNewIsOther(e.target.checked)} />
              This is the "Other" option (shows a free-text input on the task form)
            </label>
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
                Add Task Type
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setIsAddingNew(true)}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold text-purple-300 hover:text-white bg-purple-900/20 hover:bg-purple-800/40 border border-purple-700/30 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Task Type
          </button>
        )}
      </div>
    </div>
  );
};
