import React from 'react';
import { ExternalLink } from 'lucide-react';
import { BriefFieldDef } from '../types/database';

interface BriefFieldsReadOnlyProps {
  fields: Record<string, any>;
  // The global per-service question list, resolved by the caller from the now-dynamic
  // brief_field_schemas table (via data/briefFieldSchemas.ts's groupBriefFieldSchemas) — no
  // longer a static import, since the schema can change at runtime.
  fieldDefs: BriefFieldDef[];
  // This specific brief's one-off custom questions (BriefRecord.custom_field_defs), rendered
  // appended after the global list. Omit when not available (e.g. a historical revision snapshot
  // reuses the parent brief's current custom questions rather than tracking its own).
  customFieldDefs?: BriefFieldDef[];
}

/**
 * Pure read-only renderer for a brief's fields, driven by the caller-supplied field-definition
 * list so every consumer (the per-service specialist queue, the AM Brief Repository, past
 * revisions in the Edit History, the Client Portal) shows the exact same fields with the exact
 * same bespoke styling — no per-consumer field duplication.
 */
export const BriefFieldsReadOnly: React.FC<BriefFieldsReadOnlyProps> = ({ fields, fieldDefs, customFieldDefs = [] }) => {
  const allFieldDefs = [...fieldDefs, ...customFieldDefs];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {allFieldDefs.map((field) => {
        const value = fields[field.key];
        return (
          <div
            key={field.key}
            className={`p-3 rounded-xl bg-purple-950/30 border border-purple-900/30 space-y-1 ${
              field.span === 'full' ? 'sm:col-span-2' : ''
            }`}
          >
            <span className="text-[11px] text-stone-400 block">{field.label}</span>
            {field.type === 'tag-list' ? (
              <div className="flex flex-wrap gap-1.5">
                {Array.isArray(value) && value.length > 0 ? (
                  value.map((item: string, idx: number) => (
                    <span
                      key={idx}
                      className={`px-2.5 py-0.5 rounded text-xs font-semibold uppercase border ${field.chipClassName || ''}`}
                    >
                      {item}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-white">{value || field.fallback || 'Not specified'}</span>
                )}
              </div>
            ) : field.type === 'url' ? (
              value ? (
                <a
                  href={value}
                  target="_blank"
                  rel="noreferrer"
                  className={`hover:underline flex items-center gap-1 break-all ${field.valueClassName || 'text-xs font-bold text-purple-300'}`}
                >
                  <span>{value}</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              ) : (
                <p className="text-xs text-stone-400">{field.fallback || 'Not specified'}</p>
              )
            ) : (
              <p className={`leading-relaxed ${field.valueClassName || 'text-xs text-stone-200'}`}>
                {value || field.fallback || 'Not specified'}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};
