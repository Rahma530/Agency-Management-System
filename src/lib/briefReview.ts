import { BriefFieldDef, BriefRecord } from '../types/database';

// Brief review assistant (Module 9, point 1): rule-based, no model call. Module 2 has no
// mandatory-field validation of any kind today — DynamicBriefForm.tsx's handleSave saves
// formData unconditionally, and BriefFieldDef had no `required` concept until this phase added
// one (see data/briefFieldSchemas.ts). So this is genuinely new, not a rename of existing
// validation — and everything here is advisory (flags, never blocks saving).

export type BriefReviewSeverity = 'missing_required' | 'too_short' | 'unusual_gap';

export interface BriefReviewIssue {
  fieldKey: string;
  fieldLabel: string;
  severity: BriefReviewSeverity;
  message: string;
}

const SHORT_TEXT_MIN_LENGTH = 15;
// A field left blank here, but filled in by at least this share of other submitted briefs for
// the same service, is worth flagging even when it isn't marked `required`.
const UNUSUAL_GAP_FILL_RATE_THRESHOLD = 0.7;
// Below this many other briefs, a fill-rate percentage is too noisy to act on (e.g. "1 of 1
// other briefs fills this in" tells you nothing).
const MIN_OTHER_BRIEFS_FOR_GAP_CHECK = 3;

function fieldValueLength(value: any): number {
  if (value == null) return 0;
  if (Array.isArray(value)) return value.length; // tag-list: number of tags, not string length
  return String(value).trim().length;
}

function isFieldEmpty(value: any): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim().length === 0;
}

// `allBriefs` can be every brief across every service and client — filtered here to the same
// service_type and the brief under review excluded, so callers can just pass the full array they
// already have in scope rather than pre-filtering.
//
// `fieldDefs` is the caller-resolved global schema for brief.service_type (from the now-dynamic
// brief_field_schemas table, grouped via data/briefFieldSchemas.ts's groupBriefFieldSchemas) —
// this used to be a static import, but the schema can change at runtime now, so it's the caller's
// job to pass the current list rather than this module reading a fixed one. Only the global
// schema is checked here, not a brief's own custom_field_defs — a one-off custom question has no
// `required` concept, so there's nothing this review assistant could usefully flag about it.
export function reviewBrief(brief: BriefRecord, allBriefs: BriefRecord[], fieldDefs: BriefFieldDef[]): BriefReviewIssue[] {
  const issues: BriefReviewIssue[] = [];
  const others = allBriefs.filter((b) => b.id !== brief.id && b.service_type === brief.service_type);

  for (const def of fieldDefs) {
    const value = brief.fields?.[def.key];
    const empty = isFieldEmpty(value);

    if (def.required && empty) {
      issues.push({
        fieldKey: def.key,
        fieldLabel: def.label,
        severity: 'missing_required',
        message: `${def.label} is required but not filled in.`,
      });
      continue;
    }

    if (!empty && (def.type === 'text' || def.type === 'textarea') && fieldValueLength(value) < SHORT_TEXT_MIN_LENGTH) {
      issues.push({
        fieldKey: def.key,
        fieldLabel: def.label,
        severity: 'too_short',
        message: `${def.label} looks unusually short — consider adding more detail.`,
      });
    }

    if (empty && !def.required && others.length >= MIN_OTHER_BRIEFS_FOR_GAP_CHECK) {
      const filledCount = others.filter((b) => !isFieldEmpty(b.fields?.[def.key])).length;
      const fillRate = filledCount / others.length;
      if (fillRate >= UNUSUAL_GAP_FILL_RATE_THRESHOLD) {
        issues.push({
          fieldKey: def.key,
          fieldLabel: def.label,
          severity: 'unusual_gap',
          message: `${def.label} is left blank here, but ${Math.round(fillRate * 100)}% of other ${brief.service_type.replace(
            '_',
            ' '
          )} briefs fill it in.`,
        });
      }
    }
  }

  return issues;
}

// Simple presence-based score for a compact badge — filled fields / total fields, out of 100.
// Doesn't factor in issue severity (a "too short" field still counts as filled); reviewBrief's
// issue list is the detailed view, this is just the at-a-glance number.
export function briefCompletenessScore(brief: BriefRecord, fieldDefs: BriefFieldDef[]): number {
  if (fieldDefs.length === 0) return 100;
  const filled = fieldDefs.filter((def) => !isFieldEmpty(brief.fields?.[def.key])).length;
  return Math.round((filled / fieldDefs.length) * 100);
}
