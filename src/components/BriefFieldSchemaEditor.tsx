import React, { useState } from 'react';
import { X, Plus, Trash2, Save, GripVertical } from 'lucide-react';
import { BriefFieldSchemaRow, BriefFieldType, ServiceType } from '../types/database';
import { VALUE_STYLE_PRESETS, CHIP_STYLE_PRESETS } from '../data/briefFieldSchemas';

interface BriefFieldSchemaEditorProps {
  serviceType: ServiceType;
  rows: BriefFieldSchemaRow[];
  onCreate?: (row: Omit<BriefFieldSchemaRow, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onUpdate?: (id: string, updates: Partial<BriefFieldSchemaRow>) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onClose: () => void;
}

const FIELD_TYPES: { value: BriefFieldType; label: string }[] = [
  { value: 'text', label: 'Text (single line)' },
  { value: 'textarea', label: 'Text (multi-line)' },
  { value: 'url', label: 'URL / Link' },
  { value: 'tag-list', label: 'Tag List (comma-separated)' },
];

const SERVICE_LABELS: Record<ServiceType, string> = {
  seo: 'SEO',
  social_media: 'Social Media',
  media_buying: 'Media Buying',
  creative: 'Creative',
};

const emptyDraft = (serviceType: ServiceType, sortOrder: number): Omit<BriefFieldSchemaRow, 'id' | 'created_at' | 'updated_at'> => ({
  service_type: serviceType,
  key: '',
  label: '',
  type: 'text',
  placeholder: '',
  span: 'half',
  rows: null,
  fallback: '',
  value_class_name: null,
  chip_class_name: null,
  required: false,
  sort_order: sortOrder,
});

/**
 * Global, per-service-type brief question editor (point 10). Editing here changes what every NEW
 * brief for this service_type shows going forward — existing submitted briefs keep whatever
 * answers they already have in `fields`, untouched by schema edits. Style is chosen from a fixed
 * preset list rather than free-text CSS, so no edit here can ever produce a broken class name or
 * invisible text.
 */
export const BriefFieldSchemaEditor: React.FC<BriefFieldSchemaEditorProps> = ({
  serviceType,
  rows,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}) => {
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newDraft, setNewDraft] = useState(emptyDraft(serviceType, rows.length));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<BriefFieldSchemaRow>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order);

  const startEdit = (row: BriefFieldSchemaRow) => {
    setEditingId(row.id);
    setEditDraft({ ...row });
  };

  const handleSaveEdit = async () => {
    if (!editingId || !onUpdate) return;
    setIsSaving(true);
    setErrorMsg('');
    try {
      await onUpdate(editingId, editDraft);
      setEditingId(null);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to save this question.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!onDelete) return;
    if (!window.confirm('Remove this question from the global schema? Existing briefs keep any answer already saved for it.')) return;
    setIsSaving(true);
    try {
      await onDelete(id);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!onCreate) return;
    const key = newDraft.key.trim() || newDraft.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const label = newDraft.label.trim();
    if (!label) {
      setErrorMsg('Please enter a question label.');
      return;
    }
    setIsSaving(true);
    setErrorMsg('');
    try {
      await onCreate({ ...newDraft, key, label });
      setIsAddingNew(false);
      setNewDraft(emptyDraft(serviceType, rows.length + 1));
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to add this question.');
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
            <h3 className="text-sm font-bold text-white">Manage Brief Questions — {SERVICE_LABELS[serviceType]}</h3>
            <p className="text-[11px] text-stone-400 mt-0.5">
              Changes here apply to every NEW brief for this service going forward. Existing submitted briefs are
              unaffected.
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
          {sorted.map((row) => {
            const isEditing = editingId === row.id;
            return (
              <div
                key={row.id}
                className="p-3 rounded-xl border"
                style={{ background: 'rgba(10, 10, 13, 0.5)', borderColor: 'var(--border-soft)' }}
              >
                {isEditing ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={editDraft.label || ''}
                        onChange={(e) => setEditDraft((d) => ({ ...d, label: e.target.value }))}
                        placeholder="Question label"
                        className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                      />
                      <select
                        value={editDraft.type || 'text'}
                        onChange={(e) => setEditDraft((d) => ({ ...d, type: e.target.value as BriefFieldType }))}
                        className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                      >
                        {FIELD_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                    <input
                      type="text"
                      value={editDraft.placeholder || ''}
                      onChange={(e) => setEditDraft((d) => ({ ...d, placeholder: e.target.value }))}
                      placeholder="Placeholder text (optional)"
                      className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
                    />
                    <div className="flex items-center gap-3 flex-wrap">
                      <label className="flex items-center gap-1.5 text-[11px] text-stone-300">
                        <input
                          type="checkbox"
                          checked={!!editDraft.required}
                          onChange={(e) => setEditDraft((d) => ({ ...d, required: e.target.checked }))}
                        />
                        Required
                      </label>
                      <select
                        value={editDraft.span || 'half'}
                        onChange={(e) => setEditDraft((d) => ({ ...d, span: e.target.value as 'full' | 'half' }))}
                        className="px-2 py-1 rounded-lg text-[11px] bg-stone-900 border border-stone-800 text-white"
                      >
                        <option value="half">Half width</option>
                        <option value="full">Full width</option>
                      </select>
                    </div>
                    {editDraft.type === 'tag-list' ? (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] text-stone-400">Chip color:</span>
                        {CHIP_STYLE_PRESETS.map((p) => (
                          <button
                            key={p.name}
                            type="button"
                            title={p.name}
                            onClick={() => setEditDraft((d) => ({ ...d, chip_class_name: p.className }))}
                            className={`w-6 h-6 rounded-full ${p.swatchClass} ${editDraft.chip_class_name === p.className ? 'ring-2 ring-white' : ''}`}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] text-stone-400">Display color:</span>
                        {VALUE_STYLE_PRESETS.map((p) => (
                          <button
                            key={p.name}
                            type="button"
                            title={p.name}
                            onClick={() => setEditDraft((d) => ({ ...d, value_class_name: p.className }))}
                            className={`w-6 h-6 rounded-full ${p.swatchClass} ${editDraft.value_class_name === p.className ? 'ring-2 ring-white' : ''}`}
                          />
                        ))}
                      </div>
                    )}
                    <div className="flex justify-end gap-2 pt-1">
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
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <GripVertical className="w-3.5 h-3.5 text-stone-600 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-white truncate">
                          {row.label}
                          {row.required && <span className="ml-1.5 text-[10px] text-red-400">*</span>}
                        </p>
                        <p className="text-[10px] text-stone-500 font-mono">{row.key} · {row.type}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => startEdit(row)}
                        className="px-2 py-1 rounded-lg text-[11px] text-purple-300 hover:text-white hover:bg-purple-900/40"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(row.id)}
                        className="p-1.5 rounded-lg text-stone-500 hover:text-red-400 hover:bg-red-950/30"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {isAddingNew ? (
          <div className="p-3 rounded-xl border border-dashed border-purple-700/40 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                autoFocus
                value={newDraft.label}
                onChange={(e) => setNewDraft((d) => ({ ...d, label: e.target.value }))}
                placeholder="Question label"
                className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
              />
              <select
                value={newDraft.type}
                onChange={(e) => setNewDraft((d) => ({ ...d, type: e.target.value as BriefFieldType }))}
                className="px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
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
                Add Question
              </button>
            </div>
          </div>
        ) : (
          onCreate && (
            <button
              onClick={() => setIsAddingNew(true)}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold text-purple-300 hover:text-white bg-purple-900/20 hover:bg-purple-800/40 border border-purple-700/30 transition-all"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Question to Global Schema
            </button>
          )
        )}
      </div>
    </div>
  );
};
