import React, { useEffect, useRef, useState } from 'react';
import {
  Save,
  CheckCircle2,
  Layers,
  Table,
  Edit3,
  Globe,
  Share2,
  Target,
  AlertCircle,
  Lock,
  Palette,
  Plus,
  X,
  Store,
  Fingerprint,
} from 'lucide-react';
import { BriefFieldDef, BriefRecord, BriefRevisionRecord, ServiceType } from '../types/database';
import { SHORT_TEXT_MIN_LENGTH } from '../lib/briefReview';
import { BriefEditHistory } from './BriefEditHistory';

interface DynamicBriefFormProps {
  clientId: string;
  clientName: string;
  serviceType: ServiceType;
  // The global per-service question list, resolved by the caller from the now-dynamic
  // brief_field_schemas table rather than a static import (see data/briefFieldSchemas.ts).
  fieldDefs: BriefFieldDef[];
  existingBrief?: BriefRecord;
  revisions?: BriefRevisionRecord[];
  currentUserId: string;
  canEdit: boolean;
  onSaveBrief: (briefData: {
    client_id: string;
    service_type: ServiceType;
    fields: Record<string, any>;
    version: number;
    submitted_by: string;
    custom_field_defs: BriefFieldDef[];
  }) => Promise<void>;
}

// Draft safety net: sessionStorage-persist unsaved answers so a remount that isn't the user's
// own doing (a stale-data refetch, a future bug of the same shape) doesn't silently destroy
// in-progress work. Keyed per client+service so switching between briefs never mixes drafts.
interface BriefDraft {
  formData: Record<string, any>;
  customFieldDefs: BriefFieldDef[];
  savedAt: number;
}

const briefDraftKey = (clientId: string, serviceType: ServiceType) => `brief_draft_${clientId}_${serviceType}`;

// Reconciliation: a draft only wins if we can't prove a newer save already exists server-side.
// If existingBrief was updated (by anyone) after the draft's own timestamp, the draft is stale —
// discard it rather than silently clobbering someone else's more recent save.
const loadBriefInitialState = (
  clientId: string,
  serviceType: ServiceType,
  existingBrief: BriefRecord | undefined
): { formData: Record<string, any>; customFieldDefs: BriefFieldDef[] } => {
  try {
    const raw = sessionStorage.getItem(briefDraftKey(clientId, serviceType));
    if (raw) {
      const draft = JSON.parse(raw) as Partial<BriefDraft>;
      const existingUpdatedAt = existingBrief?.updated_at ? new Date(existingBrief.updated_at).getTime() : 0;
      if (existingUpdatedAt <= (draft.savedAt || 0)) {
        return { formData: draft.formData || {}, customFieldDefs: draft.customFieldDefs || [] };
      }
      // existingBrief is newer than this draft — someone else's save wins, drop the stale draft.
      sessionStorage.removeItem(briefDraftKey(clientId, serviceType));
    }
  } catch {
    // Corrupt/unavailable sessionStorage — fall through to existingBrief below.
  }
  return { formData: existingBrief?.fields || {}, customFieldDefs: existingBrief?.custom_field_defs || [] };
};

export const DynamicBriefForm: React.FC<DynamicBriefFormProps> = ({
  clientId,
  clientName,
  serviceType,
  fieldDefs,
  existingBrief,
  revisions = [],
  currentUserId,
  canEdit,
  onSaveBrief,
}) => {
  const [activeView, setActiveView] = useState<'edit' | 'spreadsheet'>('edit');
  const [formData, setFormData] = useState<Record<string, any>>(
    () => loadBriefInitialState(clientId, serviceType, existingBrief).formData
  );
  const [customFieldDefs, setCustomFieldDefs] = useState<BriefFieldDef[]>(
    () => loadBriefInitialState(clientId, serviceType, existingBrief).customFieldDefs
  );
  const [isAddingCustomQuestion, setIsAddingCustomQuestion] = useState(false);
  const [customQuestionLabel, setCustomQuestionLabel] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const currentVersion = existingBrief?.version || 1;

  // Re-derive on an actual client/service switch — this component is reused (not remounted)
  // when the caller flips between service tabs on the same open dashboard, so the lazy
  // initializers above only cover the very first mount. Skips its own first run (isFirstRender)
  // so it doesn't redundantly repeat what those initializers already computed. Deliberately not
  // depending on existingBrief itself — that reference can churn on unrelated refetches the same
  // way authenticatedUser did in App.tsx, which is exactly the class of bug this file's own
  // remount protection exists to survive.
  const isFirstRenderRef = useRef(true);
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    const initial = loadBriefInitialState(clientId, serviceType, existingBrief);
    setFormData(initial.formData);
    setCustomFieldDefs(initial.customFieldDefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, serviceType]);

  // Debounced draft save — sessionStorage only (per-tab, cleared on browser close), not a
  // substitute for actually saving the brief. Skipped entirely for a read-only viewer.
  useEffect(() => {
    if (!canEdit) return;
    const handle = setTimeout(() => {
      try {
        const draft: BriefDraft = { formData, customFieldDefs, savedAt: Date.now() };
        sessionStorage.setItem(briefDraftKey(clientId, serviceType), JSON.stringify(draft));
      } catch {
        // sessionStorage unavailable/full — draft persistence is a safety net, not critical path.
      }
    }, 500);
    return () => clearTimeout(handle);
  }, [formData, customFieldDefs, clientId, serviceType, canEdit]);

  const handleFieldChange = (key: string, value: any) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  // Point 11: a one-off question added to THIS client's brief only — never touches the global
  // brief_field_schemas table, never appears on any other client's brief for this service. Always
  // a plain text field — a custom question is meant for an ad hoc note, not a structured
  // tag-list/url input, so there's no type picker here.
  const handleAddCustomQuestion = () => {
    const label = customQuestionLabel.trim();
    if (!label) return;
    const key = `custom_${Date.now().toString().slice(-6)}`;
    setCustomFieldDefs((prev) => [...prev, { key, label, type: 'text' }]);
    setCustomQuestionLabel('');
    setIsAddingCustomQuestion(false);
  };

  const handleRemoveCustomQuestion = (key: string) => {
    setCustomFieldDefs((prev) => prev.filter((f) => f.key !== key));
    setFormData((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleSave = async () => {
    if (!canEdit) return;
    setIsSaving(true);
    setErrorMsg('');
    setSaveSuccess(false);

    try {
      await onSaveBrief({
        client_id: clientId,
        service_type: serviceType,
        fields: formData,
        version: existingBrief ? currentVersion + 1 : 1,
        submitted_by: currentUserId,
        custom_field_defs: customFieldDefs,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      try {
        sessionStorage.removeItem(briefDraftKey(clientId, serviceType));
      } catch {
        // Best-effort cleanup only — a leftover draft just gets superseded by existingBrief's
        // newer updated_at on next load per the reconciliation check above.
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'An error occurred while saving the brief');
    } finally {
      setIsSaving(false);
    }
  };

  const renderServiceIcon = () => {
    switch (serviceType) {
      case 'seo':
        return <Globe className="w-4 h-4 text-emerald-400" />;
      case 'social_media':
        return <Share2 className="w-4 h-4 text-purple-400" />;
      case 'media_buying':
        return <Target className="w-4 h-4 text-amber-400" />;
      case 'interface':
        return <Palette className="w-4 h-4 text-pink-400" />;
      case 'creation':
        return <Store className="w-4 h-4 text-orange-400" />;
      case 'branding':
        return <Fingerprint className="w-4 h-4 text-cyan-400" />;
      default:
        return <Layers className="w-4 h-4 text-stone-400" />;
    }
  };

  const getServiceLabel = () => {
    switch (serviceType) {
      case 'seo':
        return 'Search Engine Optimization (SEO)';
      case 'social_media':
        return 'Social Media Management';
      case 'media_buying':
        return 'Paid Advertising (Media Buying)';
      case 'interface':
        return 'واجهة (UI/UX Interface Design)';
      case 'creation':
        return 'Creation (Store/Website Setup) — إنشاء';
      case 'branding':
        return 'Branding — الهوية البصرية';
      default:
        return serviceType;
    }
  };

  const allFieldDefs = [...fieldDefs, ...customFieldDefs];

  return (
    <div
      className="rounded-[18px] p-5 shadow-lg relative overflow-hidden"
      style={{
        background: 'var(--gradient-card)',
        border: '1px solid var(--border-medium)',
      }}
    >
      {/* Header with Switcher between Edit Form and Spreadsheet View */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 mb-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(123, 47, 247, 0.2)', border: '1px solid var(--border-soft)' }}
          >
            {renderServiceIcon()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-bold text-sm" style={{ color: 'var(--white)' }}>
                Brief Form: {getServiceLabel()}
              </h4>
              <span
                className="text-[11px] px-2.5 py-0.5 rounded-full font-medium"
                style={{
                  background: 'rgba(185, 140, 240, 0.15)',
                  color: 'var(--purple-light)',
                  border: '1px solid var(--border-lilac)',
                }}
              >
                Version v{currentVersion}
              </span>
            </div>
            <p className="text-xs mt-0.5" style={{ color: 'var(--grey)' }}>
              Client: {clientName} — filled in by the Account Manager (AM Agent)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="flex p-1 rounded-xl"
            style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)' }}
          >
            <button
              onClick={() => setActiveView('edit')}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg font-medium transition-all ${
                activeView === 'edit'
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'text-stone-400 hover:text-white'
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" />
              Edit Form
            </button>
            <button
              onClick={() => setActiveView('spreadsheet')}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg font-medium transition-all ${
                activeView === 'spreadsheet'
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'text-stone-400 hover:text-white'
              }`}
            >
              <Table className="w-3.5 h-3.5" />
              Spreadsheet View
            </button>
          </div>

          {canEdit ? (
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-bold transition-all shadow-md"
              style={{
                background: 'var(--gradient-badge)',
                color: 'var(--white)',
                border: '1px solid var(--border-strong)',
                opacity: isSaving ? 0.7 : 1,
              }}
            >
              <Save className="w-3.5 h-3.5" />
              {isSaving ? 'Saving...' : 'Save as New Version'}
            </button>
          ) : (
            <span
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold"
              style={{
                background: 'rgba(168, 155, 184, 0.1)',
                color: 'var(--grey)',
                border: '1px solid var(--border-soft)',
              }}
              title="Only the assigned AM Agent or AM Team Lead can edit this brief"
            >
              <Lock className="w-3.5 h-3.5" />
              View Only
            </span>
          )}
        </div>
      </div>

      <div className="mb-4">
        <BriefEditHistory revisions={revisions} fieldDefs={fieldDefs} customFieldDefs={customFieldDefs} />
      </div>

      {errorMsg && (
        <div
          className="p-3 mb-4 rounded-xl text-xs flex items-center gap-2"
          style={{ background: 'rgba(245, 163, 163, 0.15)', border: '1px solid var(--roas-bad)', color: 'var(--roas-bad)' }}
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          {errorMsg}
        </div>
      )}

      {saveSuccess && (
        <div
          className="p-3 mb-4 rounded-xl text-xs flex items-center gap-2"
          style={{ background: 'rgba(169, 245, 193, 0.15)', border: '1px solid var(--roas-good)', color: 'var(--roas-good)' }}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          Brief saved and documented successfully (Version v{existingBrief ? currentVersion + 1 : 1})
        </div>
      )}

      {/* VIEW 1: Dynamic Form per Service Type */}
      {activeView === 'edit' && (
        <fieldset
          disabled={!canEdit}
          className={`border-0 p-0 m-0 min-w-0 ${!canEdit ? 'opacity-60' : ''}`}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {allFieldDefs.map((field) => {
              const isCustom = customFieldDefs.some((f) => f.key === field.key);
              const fieldValue = formData[field.key];
              const trimmedLength = typeof fieldValue === 'string' ? fieldValue.trim().length : 0;
              const isTooShort =
                (field.type === 'text' || field.type === 'textarea') &&
                trimmedLength > 0 &&
                trimmedLength < SHORT_TEXT_MIN_LENGTH;
              return (
              <div key={field.key} className={field.span === 'full' ? 'md:col-span-2' : ''}>
                <label className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs font-semibold" style={{ color: 'var(--lilac)' }}>
                    {field.label}
                    {field.required && <span className="ml-1.5 text-[10px] text-red-400">*</span>}
                    {isCustom && (
                      <span
                        className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
                        style={{ background: 'rgba(123, 47, 247, 0.15)', color: 'var(--purple-light)' }}
                      >
                        Custom — this client only
                      </span>
                    )}
                  </span>
                  {isCustom && canEdit && (
                    <button
                      type="button"
                      onClick={() => handleRemoveCustomQuestion(field.key)}
                      className="text-stone-500 hover:text-red-400 transition-colors"
                      title="Remove this custom question"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </label>
                {field.type === 'textarea' ? (
                  <textarea
                    rows={field.rows || 2}
                    placeholder={field.placeholder}
                    value={formData[field.key] || ''}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
                    style={{
                      background: 'rgba(10, 10, 13, 0.85)',
                      border: '1px solid var(--border-soft)',
                      color: 'var(--white)',
                    }}
                  />
                ) : field.type === 'tag-list' ? (
                  <input
                    type="text"
                    placeholder={field.placeholder}
                    value={
                      Array.isArray(formData[field.key])
                        ? formData[field.key].join(', ')
                        : formData[field.key] || ''
                    }
                    onChange={(e) =>
                      handleFieldChange(field.key, e.target.value.split(',').map((s) => s.trim()))
                    }
                    className="w-full px-3 py-2 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
                    style={{
                      background: 'rgba(10, 10, 13, 0.85)',
                      border: '1px solid var(--border-soft)',
                      color: 'var(--white)',
                    }}
                  />
                ) : (
                  <input
                    type="text"
                    placeholder={field.placeholder}
                    value={formData[field.key] || ''}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
                    style={{
                      background: 'rgba(10, 10, 13, 0.85)',
                      border: '1px solid var(--border-soft)',
                      color: 'var(--white)',
                    }}
                  />
                )}
                {isTooShort && (
                  <p className="mt-1 text-[10px] text-stone-500">
                    {field.label} looks unusually short — consider adding more detail.
                  </p>
                )}
              </div>
              );
            })}
          </div>

          {canEdit && (
            <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-soft)' }}>
              {isAddingCustomQuestion ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    autoFocus
                    placeholder="Question text (e.g. any competitor to avoid mentioning?)"
                    value={customQuestionLabel}
                    onChange={(e) => setCustomQuestionLabel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddCustomQuestion()}
                    className="flex-1 px-3 py-2 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
                    style={{ background: 'rgba(10, 10, 13, 0.85)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomQuestion}
                    className="px-3 py-2 rounded-xl text-xs font-bold text-white"
                    style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingCustomQuestion(false);
                      setCustomQuestionLabel('');
                    }}
                    className="p-2 rounded-xl text-stone-400 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsAddingCustomQuestion(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-purple-300 hover:text-white bg-purple-900/20 hover:bg-purple-800/40 border border-purple-700/30 transition-all"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Custom Question (this client only)
                </button>
              )}
            </div>
          )}
        </fieldset>
      )}

      {/* VIEW 2: Spreadsheet Tabular Review View */}
      {activeView === 'spreadsheet' && (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border-soft)' }}>
          <table className="w-full text-right text-xs">
            <thead>
              <tr style={{ background: 'rgba(59, 21, 96, 0.4)', borderBottom: '1px solid var(--border-soft)' }}>
                <th className="p-3 font-bold" style={{ color: 'var(--purple-light)', width: '30%' }}>
                  Field
                </th>
                <th className="p-3 font-bold" style={{ color: 'var(--white)' }}>
                  Recorded Value
                </th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'rgba(123, 47, 247, 0.15)' }}>
              {Object.keys(formData).length === 0 ? (
                <tr>
                  <td colSpan={2} className="p-6 text-center text-stone-400">
                    No data entered yet for this brief. Switch to "Edit Form" to fill in the fields.
                  </td>
                </tr>
              ) : (
                Object.entries(formData).map(([key, value]) => (
                  <tr key={key} className="hover:bg-purple-950/20 transition-colors">
                    <td className="p-3 font-medium font-mono text-[11px]" style={{ color: 'var(--lilac)' }}>
                      {key}
                    </td>
                    <td className="p-3" style={{ color: 'var(--white)' }}>
                      {Array.isArray(value) ? (
                        <div className="flex flex-wrap gap-1">
                          {value.map((item, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-0.5 rounded-md text-[10px]"
                              style={{ background: 'rgba(123, 47, 247, 0.25)', color: 'var(--purple-light)' }}
                            >
                              {item}
                            </span>
                          ))}
                        </div>
                      ) : typeof value === 'object' ? (
                        <pre className="text-[10px] text-stone-300 font-mono">{JSON.stringify(value, null, 2)}</pre>
                      ) : (
                        <span className="leading-relaxed whitespace-pre-wrap">{String(value || '—')}</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
