export interface SavedReportSourceRow {
  source_kind: string;
  source_date: string;
  snapshot: unknown;
}

export function buildSavedReportFacts(rows: SavedReportSourceRow[]): string[] {
  if (rows.length > 200) throw new Error('The report has too many saved sources for one rewrite request.');
  return rows.map((source) => {
    if (!source.snapshot || typeof source.snapshot !== 'object' || Array.isArray(source.snapshot)) {
      throw new Error('A saved report source snapshot is invalid.');
    }
    const snapshot = source.snapshot as Record<string, unknown>;
    let fact: string;
    if (source.source_kind === 'task') {
      const dates = Array.isArray(snapshot.evidence_dates)
        ? snapshot.evidence_dates.filter((value): value is string => typeof value === 'string').join(', ')
        : source.source_date;
      fact = `${source.source_date}: task evidence — ${String(snapshot.title || '')}; inferred kind: ${String(snapshot.work_kind || 'unclassified')}; status: ${String(snapshot.status || '')}; linked work-log dates: ${dates}`;
    } else if (source.source_kind === 'daily_log' || source.source_kind === 'extra_note') {
      fact = `${source.source_date}: ${String(snapshot.summary_text || snapshot.note_text || '')}`;
    } else {
      throw new Error('A saved report source kind is unsupported.');
    }
    if (fact.length > 1000) throw new Error('A saved report source is too large for one rewrite request.');
    return fact;
  });
}
