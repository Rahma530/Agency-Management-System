// Static shape checks for the new HTML report format (reportHtmlExport.ts) — same spirit as
// checkPdfEmbeddedImages.ts: proves the generated markup has the right shape (brand tokens
// present, every recognized section heading survives into the output), not full visual/runtime
// behavior (no browser here to actually render the page). resolveEmbeddableImages' own fetch()
// calls below point at an unreachable test host on purpose — they fail and are caught internally
// (see embeddableImages.ts), exactly like a real failed attachment fetch, so this stays
// deterministic and offline-safe.
import { ClientComparisonRecord } from '../src/types/database';
import { REPORT_SECTION_HEADINGS } from '../src/lib/pdfExport';
import { buildIndividualReportHtml, buildUnifiedReportHtml } from '../src/lib/reportHtmlExport';

const BRAND_PURPLE_HEX = '#7b2ff7';

async function checkIndividualReport() {
  const contentText = [
    `${REPORT_SECTION_HEADINGS.workLogs}\nSara: رفعت التصميم https://example-storage.test/task-attachments/abc/photo.jpg`,
    `${REPORT_SECTION_HEADINGS.creativeSummary}\nDesign tasks evidenced by linked work logs: 3 (confirmed completed in period: 1)`,
    `${REPORT_SECTION_HEADINGS.taskLedger}\nFix homepage banner — design (content-inferred); confirmed completed in period; linked log dates: 2026-10-10, 2026-10-12`,
    `${REPORT_SECTION_HEADINGS.employeeContext}\n2026-10-11 — Took a half day for a doctor's appointment.`,
    `${REPORT_SECTION_HEADINGS.creatorContext}\nFocus on delivery speed this period.`,
  ].join('\n\n');

  const html = await buildIndividualReportHtml({ title: 'Employee Report', subtitle: 'Sara — 2026-10-10 to 2026-10-21', contentText });

  if (!html.startsWith('<!doctype html>')) throw new Error('Individual report HTML must be a complete standalone document.');
  if (!html.includes(BRAND_PURPLE_HEX)) throw new Error('Individual report HTML must use the Kesra brand purple token.');
  Object.values(REPORT_SECTION_HEADINGS).forEach((heading) => {
    if (!html.includes(heading)) throw new Error(`Individual report HTML is missing the "${heading}" section.`);
  });
  if (!html.includes('Fix homepage banner')) throw new Error('Task evidence ledger content did not survive into the HTML report.');
  console.log('OK (1/2): buildIndividualReportHtml renders every known section from a saved content_text, with the brand palette applied.');
}

async function checkUnifiedReport() {
  const comparison: ClientComparisonRecord = {
    id: 'cmp-test',
    client_id: 'client-test',
    agent_id: null,
    row_kind: 'comparison',
    period_current: '2026-10',
    period_previous: '2026-09',
    metrics_current: { media_buying: { spend: 5000, roas: 3.5, conversions: 120, cpa: 41.6 } },
    metrics_previous: { media_buying: { spend: 4000, roas: 3.1, conversions: 100, cpa: 40 } },
    delta: { media_buying: { spend: 25, roas: 12.9, conversions: 20, cpa: 4 } },
    ai_recommendations_text: null,
  };

  const html = await buildUnifiedReportHtml({
    title: 'Unified Client Report',
    subtitle: '2026-10 vs 2026-09',
    narrative: 'Media buying performance improved this period.',
    recommendations: ['Scale the top-performing campaign.'],
    comparison,
  });

  if (!html.startsWith('<!doctype html>')) throw new Error('Unified report HTML must be a complete standalone document.');
  if (!html.includes(BRAND_PURPLE_HEX)) throw new Error('Unified report HTML must use the Kesra brand purple token.');
  if (!html.includes('Media Buying')) throw new Error('Unified report HTML is missing its metrics cards.');
  if (!html.includes('Scale the top-performing campaign.')) throw new Error('Unified report HTML is missing its recommendations.');
  console.log('OK (2/2): buildUnifiedReportHtml renders metrics cards and narrative/recommendations from a ClientComparisonRecord.');
}

(async () => {
  await checkIndividualReport();
  await checkUnifiedReport();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
