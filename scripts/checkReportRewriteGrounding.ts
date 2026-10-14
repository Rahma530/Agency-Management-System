import { buildSavedReportFacts } from '../supabase/functions/ai-router/reportRewriteGrounding';

const facts = buildSavedReportFacts([
  { source_kind: 'daily_log', source_date: '2026-10-12', snapshot: { summary_text: 'Completed 12 deliverables' } },
  { source_kind: 'task', source_date: '2026-10-13', snapshot: { title: 'Launch reel', work_kind: 'video', status: 'completed', evidence_dates: ['2026-10-12'] } },
]);
if (facts.length !== 2 || !facts[0].includes('Completed 12 deliverables') || !facts[1].includes('Launch reel')) {
  throw new Error('Saved source snapshots were not converted into provider facts.');
}
for (const invalid of [
  [{ source_kind: 'unknown', source_date: '2026-10-12', snapshot: {} }],
  [{ source_kind: 'daily_log', source_date: '2026-10-12', snapshot: null }],
  Array.from({ length: 201 }, () => ({ source_kind: 'daily_log', source_date: '2026-10-12', snapshot: { summary_text: 'x' } })),
]) {
  let rejected = false;
  try { buildSavedReportFacts(invalid); } catch { rejected = true; }
  if (!rejected) throw new Error('Invalid or unbounded saved evidence was accepted.');
}
console.log('OK: REPORT_REWRITE facts are built only from bounded, supported saved source snapshots.');
