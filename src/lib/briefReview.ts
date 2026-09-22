import { BriefFieldDef, BriefRecord } from '../types/database';

// Brief review assistant (Module 9, point 1): rule-based, no model call. Module 2 has no
// mandatory-field validation of any kind today — DynamicBriefForm.tsx's handleSave saves
// formData unconditionally, and BriefFieldDef had no `required` concept until this phase added
// one (see data/briefFieldSchemas.ts). So this is genuinely new, not a rename of existing
// validation — and everything here is advisory (flags, never blocks saving).
//
// unusual_gap (a non-required field left blank here but filled in by most other briefs for the
// same service) was removed along with the Review Checklist panel that was its only UI surface —
// DynamicBriefForm.tsx now shows missing_required inline as a required-field asterisk and
// too_short inline under the affected field, neither of which needs a cross-brief comparison.

export type BriefReviewSeverity = 'missing_required' | 'too_short';

export interface BriefReviewIssue {
  fieldKey: string;
  fieldLabel: string;
  severity: BriefReviewSeverity;
  message: string;
}

// Exported so DynamicBriefForm.tsx's inline too_short warning (shown directly under the affected
// field, not through reviewBrief() below) uses the exact same threshold as ServiceBriefsRoutingView
// and ClientDashboard's issue-count badges, which still call reviewBrief() for every severity.
export const SHORT_TEXT_MIN_LENGTH = 15;

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

// `allBriefs` is no longer read inside this function (it only ever fed the removed unusual_gap
// check) but stays in the signature so ServiceBriefsRoutingView.tsx and ClientDashboard.tsx's
// existing reviewBrief(brief, briefs, fieldDefs) call sites don't need to change.
//
// `fieldDefs` is the caller-resolved global schema for brief.service_type (from the now-dynamic
// brief_field_schemas table, grouped via data/briefFieldSchemas.ts's groupBriefFieldSchemas) —
// this used to be a static import, but the schema can change at runtime now, so it's the caller's
// job to pass the current list rather than this module reading a fixed one. Only the global
// schema is checked here, not a brief's own custom_field_defs — a one-off custom question has no
// `required` concept, so there's nothing this review assistant could usefully flag about it.
export function reviewBrief(brief: BriefRecord, allBriefs: BriefRecord[], fieldDefs: BriefFieldDef[]): BriefReviewIssue[] {
  const issues: BriefReviewIssue[] = [];

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
