// Standalone render-and-inspect check (same pattern as the PDF font verification work in PR
// #132): builds a real PDF via the actual exported buildReportDoc, with real Noto Naskh Arabic
// font files read off disk, then inspects the raw PDF bytes for `/Subtype /Link` annotation
// objects to confirm every extracted link became a real clickable annotation — not just visibly
// blue/underlined text.
import fs from 'node:fs';
import { buildReportDoc, ArabicFontBundle } from '../src/lib/pdfExport';
import { extractLinks, reattachLinks } from '../src/lib/textLinks';

function loadFontBundle(): ArabicFontBundle {
  const normal = fs.readFileSync('public/fonts/NotoNaskhArabic-Regular.ttf').toString('base64');
  const bold = fs.readFileSync('public/fonts/NotoNaskhArabic-Bold.ttf').toString('base64');
  return { name: 'NotoNaskhArabic', normal, bold };
}

function countLinkAnnotations(pdfBytes: Uint8Array): number {
  // jsPDF emits plain, uncompressed PDF object streams for annotation dictionaries (never inside
  // a /FlateDecode content stream), so a literal substring count of the annotation dictionary's
  // own "/Subtype /Link" is a reliable, dependency-free way to count them from the raw bytes.
  const text = Buffer.from(pdfBytes).toString('latin1');
  const matches = text.match(/\/Subtype\s*\/Link/g);
  return matches ? matches.length : 0;
}

const LONG_GOOGLE_DOC_URL = 'https://docs.google.com/document/d/1AbCDeFGhIJKlmNOPqrSTUvWXyz0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/edit?usp=sharing';
const LONG_GOOGLE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1zyxWVUtsrqpONMLkjiHGFedCBA9876543210-ZYXWVUTSRQPONMLKJIHGFEDCBA/edit#gid=0';

async function main() {
  const fontBundle = loadFontBundle();

  const doc = buildReportDoc(fontBundle, {
    filename: 'test.pdf',
    title: 'عميل تجريبي',
    subtitle: 'من 2026-10-01 إلى 2026-10-18',
    paragraphs: [
      {
        heading: 'Final Report',
        body: `راجع ملف الحملة على الرابط ${LONG_GOOGLE_DOC_URL} ثم أرسل ملاحظاتك.`,
      },
    ],
    bulletLists: [
      {
        heading: 'Evidence',
        items: [
          `تم رفع تقرير الأداء هنا: ${LONG_GOOGLE_SHEET_URL}`,
          'بند عادي بلا أي رابط.',
        ],
      },
    ],
  });

  const pdfBytes = doc.output('arraybuffer') as ArrayBuffer;
  const linkCount = countLinkAnnotations(new Uint8Array(pdfBytes));
  // 2 links total (one from the paragraph body, one from the first bullet item — the second
  // bullet has no link and must not add one), but drawLinkLines gives each wrapped sub-line of a
  // long URL its own clickable annotation (point ب: "كل سطر فرعي قابل للضغط"), so a long Google
  // Docs/Sheets URL that wraps across 2 lines at this page width/font size contributes 2
  // annotations, not 1 — hence 4 total for these two long URLs, not 2. A regression that drops
  // annotations entirely (e.g. back to plain unclickable text) would show up as 0, and one that
  // stops wrapping sub-lines individually would show up as 2.
  if (linkCount !== 4) {
    throw new Error(`Expected exactly 4 Link annotations (2 long URLs x 2 wrapped sub-lines each), got ${linkCount}.`);
  }
  console.log('OK (1/3): a real PDF with a long, wrapping paragraph link and a long, wrapping bullet link produces one /Subtype /Link annotation per wrapped sub-line (4 total).');
}

// extractLinks/reattachLinks round-trip (point ب's work_items requirement): a link survives
// being stripped out, "rephrased" (simulated — the clean text changes completely), and
// reattached, unchanged, by id.
{
  const original = 'أنهى سارة رفع الملف هنا https://docs.google.com/document/d/abc123/edit وأغلقت المهمة.';
  const { cleanText, links } = extractLinks(original);
  if (links.length !== 1 || links[0] !== 'https://docs.google.com/document/d/abc123/edit') {
    throw new Error('extractLinks did not pull out exactly the one URL present.');
  }
  if (cleanText.includes('https://')) throw new Error('extractLinks left the URL inside the cleaned text.');

  // Simulate AI Summary completely rewriting the clean text — the link must still come back
  // exactly as it was, never altered by the "rephrasing".
  const rephrasedCleanText = 'قامت سارة بتحميل الملف وأتمّت إغلاق المهمة بنجاح.';
  const finalText = reattachLinks(rephrasedCleanText, links);
  if (!finalText.includes('https://docs.google.com/document/d/abc123/edit')) {
    throw new Error('reattachLinks did not bring the original link back.');
  }
  if (!finalText.startsWith(rephrasedCleanText)) {
    throw new Error('reattachLinks must keep the rephrased text itself untouched, with the link appended on its own line.');
  }
  console.log('OK (2/3): extractLinks/reattachLinks round-trip a link unchanged through a full text rewrite.');
}

// A work item with no link must round-trip with no links field and no stray line added.
{
  const { cleanText, links } = extractLinks('نص عادي بلا أي رابط إطلاقاً.');
  if (links.length !== 0) throw new Error('extractLinks must return no links when there is none.');
  if (reattachLinks(cleanText, links) !== cleanText) {
    throw new Error('reattachLinks must be a no-op when there are no links.');
  }
  console.log('OK (3/3): a work item with no link is left exactly as-is.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
