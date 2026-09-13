import { BriefFieldDef, BriefFieldSchemaRow, ServiceType } from '../types/database';

// Re-exported for backward compatibility with existing call sites that import these types from
// here — the canonical definitions now live in types/database.ts alongside BriefFieldSchemaRow,
// since the field list itself moved from this file's static BRIEF_FIELD_SCHEMAS object into the
// database (brief_field_schemas table) so it can be edited from the app instead of requiring a
// code change + redeploy. See BriefFieldSchemaEditor.tsx.
export type { BriefFieldDef, BriefFieldType } from '../types/database';

/**
 * A small, safe set of Tailwind class strings for a field's read-only display styling
 * (value/chip color), offered as named presets in BriefFieldSchemaEditor.tsx rather than a
 * free-text CSS input — picking from a fixed list can never produce a broken class name, an
 * invisible-text color, or an injected style, the way a raw text field could.
 */
export const VALUE_STYLE_PRESETS: { name: string; swatchClass: string; className: string }[] = [
  { name: 'Default (stone)', swatchClass: 'bg-stone-400', className: 'text-xs text-stone-200' },
  { name: 'White (bold)', swatchClass: 'bg-white', className: 'text-xs font-bold text-white' },
  { name: 'Purple', swatchClass: 'bg-purple-400', className: 'text-xs font-bold text-purple-300' },
  { name: 'Emerald', swatchClass: 'bg-emerald-400', className: 'text-xs font-bold text-emerald-300' },
  { name: 'Sky', swatchClass: 'bg-sky-400', className: 'text-sm font-bold text-sky-400 font-mono' },
  { name: 'Amber', swatchClass: 'bg-amber-400', className: 'text-xs font-bold text-amber-300' },
  { name: 'Pink', swatchClass: 'bg-pink-400', className: 'text-xs font-bold text-pink-300' },
  { name: 'Monospace (stone)', swatchClass: 'bg-stone-400', className: 'text-xs text-stone-200 font-mono whitespace-pre-line' },
];

export const CHIP_STYLE_PRESETS: { name: string; swatchClass: string; className: string }[] = [
  { name: 'Purple', swatchClass: 'bg-purple-500', className: 'bg-purple-950/60 text-purple-300 border-purple-800/40' },
  { name: 'Pink', swatchClass: 'bg-pink-500', className: 'bg-pink-950/60 text-pink-300 border-pink-800/40' },
  { name: 'Sky', swatchClass: 'bg-sky-500', className: 'bg-sky-950/60 text-sky-300 border-sky-800/40' },
  { name: 'Emerald', swatchClass: 'bg-emerald-500', className: 'bg-emerald-950/60 text-emerald-300 border-emerald-800/40' },
  { name: 'Amber', swatchClass: 'bg-amber-500', className: 'bg-amber-950/60 text-amber-300 border-amber-800/40' },
];

/** Maps a raw brief_field_schemas DB row (snake_case) to the camelCase shape the form/read-only
 * renderers already consume — keeps DynamicBriefForm.tsx/BriefFieldsReadOnly.tsx's field-rendering
 * JSX unchanged even though the underlying source moved from a static import to a fetched table. */
export function toBriefFieldDef(row: BriefFieldSchemaRow): BriefFieldDef {
  return {
    key: row.key,
    label: row.label,
    type: row.type,
    placeholder: row.placeholder || undefined,
    span: row.span || undefined,
    rows: row.rows || undefined,
    fallback: row.fallback || undefined,
    valueClassName: row.value_class_name || undefined,
    chipClassName: row.chip_class_name || undefined,
    required: row.required,
  };
}

/** Groups a flat brief_field_schemas fetch into the per-service-type, sort_order-sorted shape
 * every consumer needs — the exact same Record<ServiceType, BriefFieldDef[]> shape the old static
 * BRIEF_FIELD_SCHEMAS object had, so every existing `schemas[serviceType] || []` lookup still
 * works unchanged. */
export function groupBriefFieldSchemas(rows: BriefFieldSchemaRow[]): Record<ServiceType, BriefFieldDef[]> {
  const result: Record<ServiceType, BriefFieldDef[]> = {
    seo: [],
    social_media: [],
    media_buying: [],
    creative: [],
  };
  const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order);
  for (const row of sorted) {
    result[row.service_type].push(toBriefFieldDef(row));
  }
  return result;
}
