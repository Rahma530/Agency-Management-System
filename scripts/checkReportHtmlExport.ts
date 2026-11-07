// Static shape checks for the new HTML report format (reportHtmlExport.ts) — same spirit as
// checkPdfEmbeddedImages.ts: proves the generated markup has the right shape (brand tokens
// present, every recognized section heading survives into the output), not full visual/runtime
// behavior (no browser here to actually render the page). resolveEmbeddableImages' own fetch()
// calls below point at an unreachable test host on purpose — they fail and are caught internally
// (see embeddableImages.ts), exactly like a real failed attachment fetch, so this stays
// deterministic and offline-safe.
import { ClientComparisonRecord } from '../src/types/database';
import { REPORT_SECTION_HEADINGS } from '../src/lib/pdfExport';
import { buildIndividualReportHtml, buildUnifiedReportHtml, buildReportHtmlAuto } from '../src/lib/reportHtmlExport';
import { serializeStructuredReportText, parseStructuredReportText, STRUCTURED_REPORT_HEADINGS } from '../src/lib/structuredReportText';

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
  // workLogs is the one exception: it's an internal parsing marker never meant for the report's
  // reader (same as it already never showed for a client-scope report's per-service sub-headings),
  // so it's checked separately below as explicitly ABSENT rather than included in this loop.
  Object.entries(REPORT_SECTION_HEADINGS).forEach(([key, heading]) => {
    if (key === 'workLogs') return;
    if (!html.includes(heading)) throw new Error(`Individual report HTML is missing the "${heading}" section.`);
  });
  if (html.includes(REPORT_SECTION_HEADINGS.workLogs)) {
    throw new Error('Individual report HTML must never show the internal "Work logs (primary source)" marker as a visible heading.');
  }
  if (!html.includes('رفعت التصميم')) throw new Error('Work-log entry text did not survive into the HTML report even without its section heading.');
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

// serializeStructuredReportText/parseStructuredReportText (structuredReportText.ts) must round-trip
// the AI task's JSON shape through the plain report-text format used to save it as a draft — and
// buildReportHtmlAuto (ReportDraftWorkspace.tsx's only HTML export entry point) must correctly
// detect, from content_text alone, which of the two shapes a saved report is in, with no AI call.
async function checkStructuredReportRoundTripAndAutoDetect() {
  const structured = {
    executive_summary: {
      paragraph: 'Social media activity grew this period.',
      kpis: [{ label: 'Stories posted', value: '12', note: 'Reached 4500 accounts' }],
      caveat: '',
    },
    sections: [
      { heading: 'Social Media', blocks: [{ title: 'Stories', body: ['Posted 12 stories.', 'Scheduled 3 posts for next week.'] }] },
    ],
    work_by_date: [{ date: '2026-10-10', summary: 'Posted stories and scheduled content.' }],
    upcoming_work: [{ title: 'Next campaign', body: ['Prepare assets for the November push.'] }],
  };

  const text = serializeStructuredReportText(structured);
  if (!text.startsWith(STRUCTURED_REPORT_HEADINGS.executiveSummary)) {
    throw new Error('Serialized structured report text must start with the Executive Summary heading.');
  }
  if (!text.includes('KPI: Stories posted — 12 (Reached 4500 accounts)')) {
    throw new Error('Serialized structured report text is missing its KPI line in the expected format.');
  }

  const parsedBack = parseStructuredReportText(text);
  if (!parsedBack) throw new Error('parseStructuredReportText failed to detect its own serialized output as the structured shape.');
  if (parsedBack.executive_summary.kpis.length !== 1 || parsedBack.executive_summary.kpis[0].value !== '12') {
    throw new Error('Structured report round-trip lost or corrupted a KPI.');
  }
  if (parsedBack.sections.length !== 1 || parsedBack.sections[0].heading !== 'Social Media') {
    throw new Error('Structured report round-trip lost or corrupted a section.');
  }
  // A block's body is an array of separate points (each its own "- " line in the saved text) — the
  // two-item fixture above must round-trip as two distinct items, not get merged back into one.
  const roundTrippedBody = parsedBack.sections[0].blocks[0]?.body;
  if (!roundTrippedBody || roundTrippedBody.length !== 2 || roundTrippedBody[1] !== 'Scheduled 3 posts for next week.') {
    throw new Error(`Structured report round-trip lost or merged a multi-item block body, got ${JSON.stringify(roundTrippedBody)}`);
  }
  if (parsedBack.work_by_date.length !== 1 || parsedBack.work_by_date[0].date !== '2026-10-10') {
    throw new Error('Structured report round-trip lost or corrupted a work-by-date row.');
  }
  if (parsedBack.upcoming_work.length !== 1 || parsedBack.upcoming_work[0].title !== 'Next campaign') {
    throw new Error('Structured report round-trip lost or corrupted an upcoming-work item.');
  }

  // An OLD-shape report (this test's own fixture from checkIndividualReport) must never be
  // misdetected as the new structured shape.
  if (parseStructuredReportText(`${REPORT_SECTION_HEADINGS.workLogs}\nSara: did some work.`) !== null) {
    throw new Error('An old-shape report content_text was wrongly detected as the new structured shape.');
  }

  const autoStructuredHtml = await buildReportHtmlAuto({ title: 'Natural Glow', eyebrow: 'Weekly Report', contentText: text });
  if (!autoStructuredHtml.includes('Posted 12 stories.') || !autoStructuredHtml.includes('Next campaign')) {
    throw new Error('buildReportHtmlAuto did not render the structured shape via the rich template.');
  }
  // A 2+ item body renders as a real <ul> of stacked bullets, not one run-on paragraph (each item
  // goes through renderBodyItemHtml, which wraps its plain text in its own <p>).
  if (!autoStructuredHtml.includes('<ul><li><p>Posted 12 stories.</p></li><li><p>Scheduled 3 posts for next week.</p></li></ul>')) {
    throw new Error('buildReportHtmlAuto did not render a multi-item block body as a <ul> bullet list.');
  }

  const oldShapeText = `${REPORT_SECTION_HEADINGS.workLogs}\nSara: did some work.`;
  const autoOldHtml = await buildReportHtmlAuto({ title: 'Sara', eyebrow: 'Weekly Report', contentText: oldShapeText });
  if (!autoOldHtml.includes('did some work.')) {
    throw new Error('buildReportHtmlAuto did not fall back to the original template for an old-shape report.');
  }

  console.log('OK (3/3): the structured-report text format round-trips through serialize/parse, and buildReportHtmlAuto detects and renders each shape correctly with no AI call.');
}

// A live test surfaced a real gap: a structured-report body point carrying raw attachment links
// (a work-log line listing several product-page URLs together, say) used to render as unbroken,
// unclickable escaped text — this function never called extractLinks/resolveEmbeddableImages the
// way buildIndividualReportHtml already does. Each link must now get its own clickable line
// (resolveEmbeddableImages' own fetch() points at an unreachable test host on purpose — it fails
// and falls back to a plain "View attachment" link, exactly like checkIndividualReport above).
async function checkStructuredReportLinksRenderClickable() {
  const structured = {
    executive_summary: { paragraph: 'Content work continued this period.', kpis: [], caveat: '' },
    sections: [
      {
        heading: 'SEO',
        blocks: [
          {
            title: 'Content',
            body: ['كتابة محتوى جديد لـ 4 منتجات مع الروابط https://wajaha4perfumes.test/a https://wajaha4perfumes.test/b'],
          },
        ],
      },
    ],
    work_by_date: [],
    upcoming_work: [],
  };
  const text = serializeStructuredReportText(structured);
  const html = await buildReportHtmlAuto({ title: 'Wajaha', eyebrow: 'Weekly Report', contentText: text });

  if (!html.includes('كتابة محتوى جديد لـ 4 منتجات مع الروابط')) {
    throw new Error('The body point\'s own text did not survive once its links were pulled out of it.');
  }
  // Two raw URLs must become two separate clickable lines, never left as unbroken inline text.
  const viewAttachmentCount = (html.match(/View attachment<\/a>/g) || []).length;
  if (viewAttachmentCount !== 2) {
    throw new Error(`Expected each of the 2 links to render as its own clickable "View attachment" line, got ${viewAttachmentCount}.`);
  }
  if (!html.includes('href="https://wajaha4perfumes.test/a"') || !html.includes('href="https://wajaha4perfumes.test/b"')) {
    throw new Error('A link in a structured-report body point was not rendered as a real clickable <a href>.');
  }
  if (html.includes('https://wajaha4perfumes.test/a https://wajaha4perfumes.test/b')) {
    throw new Error('Links were left crammed together as raw unbroken text instead of being pulled into their own lines.');
  }

  console.log('OK (4/4): a structured-report body point\'s attachment links render as separate, real clickable lines (and would embed as pictures for a reachable image URL), never as unbroken raw text.');
}

(async () => {
  await checkIndividualReport();
  await checkUnifiedReport();
  await checkStructuredReportRoundTripAndAutoDetect();
  await checkStructuredReportLinksRenderClickable();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
