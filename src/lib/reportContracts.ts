import { ReportPeriod } from './reportPeriods';

export type ReportSubject =
  | { kind: 'client'; clientId: string; subjectUserId: null }
  | { kind: 'employee'; clientId: null; subjectUserId: string };

export interface ReportIdentityContract {
  generatedBy: string;
  subject: ReportSubject;
  responsibleUserId: string | null;
  period: ReportPeriod;
}

export type ReportSourceKind = 'daily_log' | 'extra_note' | 'task';

export interface ReportSourceReference {
  sourceKind: ReportSourceKind;
  sourceId: string;
}

export function reportSourceKey(source: ReportSourceReference): string {
  return `${source.sourceKind}:${source.sourceId}`;
}

// Source type is part of the key so equal ids from daily_logs and extra_notes never collapse.
export function dedupeReportSourceReferences<T extends ReportSourceReference>(sources: T[]): T[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = reportSourceKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
