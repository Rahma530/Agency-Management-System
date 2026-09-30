// PDF export for the reporting UI (combined-scope Stage E). Client-side only, via jsPDF — no
// Edge Function, since every input this needs (already-generated narrative text, already-computed
// metrics) is already in the browser by the time a "Download PDF" button is pressed.
//
// ---------------------------------------------------------------------------------------------
// Arabic rendering — the reason this file is more than a thin jsPDF wrapper
// ---------------------------------------------------------------------------------------------
// Every narrative/AI-generated string this feature exports is Arabic (language: 'ar' throughout
// the AI Orchestrator work), and jsPDF's built-in fonts (Helvetica/Times/Courier) have no Arabic
// glyphs at all — plain jsPDF text() would render Arabic content as blank boxes. Two pieces fix
// this, chosen deliberately after checking alternatives rather than guessing:
//
//  1. Amiri (public/fonts/Amiri-Regular.ttf, license copy at public/fonts/Amiri-OFL.txt) — SIL
//     Open Font License 1.1, free to embed in a commercial product's generated documents. Picked
//     over Noto Sans Arabic specifically: Noto Sans Arabic has a filed upstream issue
//     (notofonts/noto-fonts#1927) reporting it renders only ISOLATED letter forms instead of
//     properly joined ones for Arabic Presentation Forms — Amiri (a Naskh print typeface with
//     ~6,000 glyphs) has full, correct Presentation Forms A+B support.
//  2. bidi-shaper (github.com/cc1a2b/bidi-shaper, MIT) for Unicode BiDi (UAX #9) reordering +
//     Arabic contextual shaping. jsPDF's OWN built-in Arabic handling is independently documented
//     to mis-order MIXED Arabic+Latin content (parallax/jsPDF issues #2004, #1816, #2178) — exactly
//     this app's case, since every generated sentence can have an English metric name (ROAS, CPA)
//     embedded in Arabic prose. bidi-shaper's jsPDF adapter hooks doc.text() so every string is
//     pre-shaped into final visual order — using Arabic Presentation Forms characters, which
//     jsPDF's own native Arabic parser does not touch, so the two never double-process the same
//     text (confirmed in bidi-shaper's own adapter docs).
//
// bidi-shaper is a genuinely new library (3 versions published within a two-hour window, no
// real-world track record) — chosen over the mature, widely-referenced alternative
// (`arabic-reshaper` and every JS port of it), which is GPL-3.0-licensed and therefore not safe to
// bundle into this commercial app's client bundle. This file is the one, small, isolated boundary
// around it: if real-world use ever surfaces a rendering bug, only this module needs to change.
//
// ---------------------------------------------------------------------------------------------
// Brand identity
// ---------------------------------------------------------------------------------------------
// No logo image asset exists anywhere in this codebase (checked before this stage started) — the
// header below uses a text wordmark styled in the brand purple instead. The exact spot to swap in
// a real logo via doc.addImage() is marked below.
import { jsPDF } from 'jspdf';
import { installJsPdfShaper } from 'bidi-shaper/jspdf';
import { ClientComparisonRecord } from '../types/database';

// Registers bidi-shaper's preProcessText hook once, globally, on jsPDF's shared API object — every
// doc.text() call on every jsPDF instance created after this runs is shaped/reordered
// automatically. Module-level (runs once per page load), matching bidi-shaper's own documented
// usage exactly.
installJsPdfShaper(jsPDF.API);

// From src/index.css's "Kesra Brand Tokens" — kept as plain hex here rather than reading the CSS
// custom properties at runtime, since jsPDF draws to its own canvas-less document model with no
// access to the page's computed styles.
const BRAND_PURPLE = '#7b2ff7';
const BRAND_PURPLE_DEEP = '#3b1560';
const BRAND_WHITE = '#ffffff';
const BODY_TEXT_COLOR = '#1a1a1a'; // near-black, not the app's light-on-dark theme — PDFs are
// conventionally read/printed on a light background, so this deliberately does not replicate the
// app's own dark UI chrome.

const ARABIC_FONT_NAME = 'Amiri';
const ARABIC_FONT_FILE = 'Amiri-Regular.ttf';
const ARABIC_FONT_URL = '/fonts/Amiri-Regular.ttf';

let arabicFontBase64Promise: Promise<string> | null = null;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // avoid a single huge String.fromCharCode(...spread) call
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Fetched once per page load (the font file never changes at runtime) and cached — every PDF
// generated after the first reuses the same resolved promise instead of re-fetching ~430KB.
export function loadArabicFontBase64(): Promise<string> {
  if (!arabicFontBase64Promise) {
    arabicFontBase64Promise = fetch(ARABIC_FONT_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${ARABIC_FONT_URL} (HTTP ${res.status}).`);
        return res.arrayBuffer();
      })
      .then(arrayBufferToBase64);
  }
  return arabicFontBase64Promise;
}

export interface PdfParagraph {
  heading: string; // English label (e.g. "Summary") — matches this app's all-English UI chrome
  body: string; // Arabic (or mixed Arabic/English) content
}

export interface PdfBulletList {
  heading: string;
  items: string[];
}

export interface PdfTable {
  headers: string[];
  rows: string[][];
}

export interface ReportPdfOptions {
  filename: string;
  title: string;
  subtitle?: string;
  paragraphs: PdfParagraph[];
  bulletLists?: PdfBulletList[];
  table?: PdfTable;
}

const PAGE_MARGIN = 48;

// Pure given an already-loaded font — kept separate from downloadReportPdf so it can be exercised
// directly (e.g. from a Node script reading the font off disk) without a browser's fetch().
export function buildReportDoc(fontBase64: string, options: ReportPdfOptions): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.addFileToVFS(ARABIC_FONT_FILE, fontBase64);
  doc.addFont(ARABIC_FONT_FILE, ARABIC_FONT_NAME, 'normal');

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - PAGE_MARGIN * 2;
  const headerHeight = 64;
  let y = headerHeight + 32;

  function drawHeader(): void {
    doc.setFillColor(BRAND_PURPLE);
    doc.rect(0, 0, pageWidth, headerHeight, 'F');
    // Text wordmark standing in for a logo (see this file's header comment) — swap for
    // doc.addImage(logoDataUrl, 'PNG', PAGE_MARGIN, 16, width, height) here once a real logo asset
    // exists in this codebase.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(BRAND_WHITE);
    doc.text('KESRA', PAGE_MARGIN, 32);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('Management System', PAGE_MARGIN, 46);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(options.title, pageWidth - PAGE_MARGIN, 30, { align: 'right' });
    if (options.subtitle) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(options.subtitle, pageWidth - PAGE_MARGIN, 45, { align: 'right' });
    }
  }

  function ensureSpace(height: number): void {
    if (y + height > pageHeight - PAGE_MARGIN) {
      doc.addPage();
      drawHeader();
      y = headerHeight + 32;
    }
  }

  function drawHeading(text: string): void {
    ensureSpace(20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(BRAND_PURPLE_DEEP);
    doc.text(text, PAGE_MARGIN, y);
    y += 16;
  }

  // Arabic (or mixed Arabic/English) paragraph — right-aligned, Amiri font, bidi-shaper handles
  // both the letter joining and putting any embedded English/numbers back in correct LTR order
  // within the RTL line. jsPDF wraps (splitTextToSize) internally BEFORE bidi-shaper's hook fires,
  // so wrapping measures raw pre-shaped character widths — a lam-alef ligature can make the real
  // shaped line very slightly narrower than estimated, which only ever wraps a touch
  // conservatively (never overflows the page): an acceptable cosmetic trade-off, not a
  // correctness bug.
  //
  // isOutputVisual: true (on every call below) is load-bearing, not decorative: jsPDF ships its
  // OWN separate built-in bidi pass on a *second* hook (`postProcessText`, distinct from the
  // `preProcessText` hook bidi-shaper uses) that runs unconditionally on every doc.text() call,
  // with no way to opt out by omission. Traced through jsPDF's source (node_modules/jspdf/dist/
  // jspdf.es.js, the `bidiEngineFunction`/`doBidiReorder` functions): with no options at all, its
  // default assumptions (isInputVisual: true, everything else undefined) make it treat
  // bidi-shaper's already-final-visual-order output as raw "visual LTR" input needing conversion
  // to "logical LTR," and it applies a REAL reordering pass — scrambling word order a second time.
  // Confirmed by an actual rendered+extracted test (see the commit report): the Arabic words were
  // individually shaped/joined correctly, but the WORD ORDER within each wrapped line came out
  // reversed relative to the original sentence. Passing isOutputVisual: true here makes every one
  // of doBidiReorder's seven branches evaluate false, so it returns the input completely
  // unchanged — a true no-op — leaving bidi-shaper's own correct reordering as the only one that
  // actually runs. Re-tested after adding this and confirmed correct (see report).
  function drawArabicParagraph(text: string): void {
    doc.setFont(ARABIC_FONT_NAME, 'normal');
    doc.setFontSize(11);
    doc.setTextColor(BODY_TEXT_COLOR);
    const lineHeight = 16;
    const estimatedLines = doc.splitTextToSize(text, contentWidth);
    ensureSpace(estimatedLines.length * lineHeight);
    doc.text(text, pageWidth - PAGE_MARGIN, y, {
      align: 'right',
      maxWidth: contentWidth,
      lineHeightFactor: 1.4,
      isOutputVisual: true,
    });
    y += estimatedLines.length * lineHeight + 10;
  }

  function drawBulletList(items: string[]): void {
    const lineHeight = 16;
    const bulletGap = 14; // reserved space for the bullet marker + gap at the right margin
    items.forEach((item) => {
      doc.setFont(ARABIC_FONT_NAME, 'normal');
      doc.setFontSize(11);
      const lines = doc.splitTextToSize(item, contentWidth - bulletGap);
      ensureSpace(lines.length * lineHeight);
      // Drawn as its own fixed-position glyph at the right margin, deliberately NOT embedded in
      // the Arabic string itself — a trailing "item •" was tried first and visually confirmed
      // (see the commit report) to land on the LEFT edge instead of the right, since bidi
      // reordering places a neutral character adjacent to the end of an RTL logical string at the
      // paragraph's visual end (the left, for RTL) rather than a fixed side. Drawing the bullet
      // separately guarantees it always sits on the right edge, matching Arabic list convention,
      // regardless of what the first/last character of `item` happens to be.
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(BODY_TEXT_COLOR);
      doc.text('•', pageWidth - PAGE_MARGIN, y, { align: 'right' });
      doc.setFont(ARABIC_FONT_NAME, 'normal');
      doc.text(item, pageWidth - PAGE_MARGIN - bulletGap, y, {
        align: 'right',
        maxWidth: contentWidth - bulletGap,
        lineHeightFactor: 1.4,
        isOutputVisual: true,
      });
      y += lines.length * lineHeight + 4;
    });
    y += 6;
  }

  // Plain English/numeric table (service names, metric labels, formatted values) — no Arabic
  // content, so no font switch or shaping needed here at all.
  function drawTable(table: PdfTable): void {
    const colCount = table.headers.length;
    const colWidth = contentWidth / colCount;
    const rowHeight = 20;

    function drawRow(cells: string[], isHeader: boolean): void {
      ensureSpace(rowHeight);
      doc.setFont('helvetica', isHeader ? 'bold' : 'normal');
      doc.setFontSize(9);
      doc.setTextColor(isHeader ? BRAND_WHITE : BODY_TEXT_COLOR);
      if (isHeader) {
        doc.setFillColor(BRAND_PURPLE_DEEP);
        doc.rect(PAGE_MARGIN, y - 14, contentWidth, rowHeight, 'F');
      }
      cells.forEach((cell, i) => {
        doc.text(cell, PAGE_MARGIN + i * colWidth + 6, y);
      });
      if (!isHeader) {
        doc.setDrawColor('#dddddd');
        doc.line(PAGE_MARGIN, y + 6, PAGE_MARGIN + contentWidth, y + 6);
      }
      y += rowHeight;
    }

    drawRow(table.headers, true);
    table.rows.forEach((row) => drawRow(row, false));
    y += 10;
  }

  drawHeader();
  options.paragraphs.forEach((section) => {
    drawHeading(section.heading);
    drawArabicParagraph(section.body);
  });
  (options.bulletLists || []).forEach((list) => {
    if (list.items.length === 0) return;
    drawHeading(list.heading);
    drawBulletList(list.items);
  });
  if (options.table && options.table.rows.length > 0) {
    drawHeading('Metrics');
    drawTable(options.table);
  }

  return doc;
}

export async function downloadReportPdf(options: ReportPdfOptions): Promise<void> {
  const fontBase64 = await loadArabicFontBase64();
  const doc = buildReportDoc(fontBase64, options);
  doc.save(options.filename);
}

// ----------------------------------------------------------------------------
// Shared metrics-table builder for the unified report PDF (combined-scope item E). AM-only caller
// — never receives a viewerServiceFilter, since an AM always sees every subscribed service; this
// deliberately does NOT accept a filter parameter, so it can't accidentally be reused from a
// scoped (department-agent) context without a compile error forcing a second look.
// ----------------------------------------------------------------------------
const SERVICE_METRIC_LABELS: Record<'media_buying' | 'social_media' | 'seo', Record<string, string>> = {
  media_buying: { spend: 'Spend', roas: 'ROAS', conversions: 'Conversions', cpa: 'CPA' },
  social_media: { reach: 'Reach', engagement_rate: 'Engagement Rate', follower_growth: 'Follower Growth' },
  seo: { completed_tasks: 'Completed Tasks', on_time_rate: 'On-Time Rate' },
};

const SERVICE_METRIC_UNITS: Record<'media_buying' | 'social_media' | 'seo', Record<string, string>> = {
  media_buying: { spend: ' SAR', roas: 'x', conversions: '', cpa: ' SAR' },
  social_media: { reach: '', engagement_rate: '%', follower_growth: '' },
  seo: { completed_tasks: '', on_time_rate: '%' },
};

const SERVICE_TITLES: Record<'media_buying' | 'social_media' | 'seo', string> = {
  media_buying: 'Media Buying',
  social_media: 'Social Media',
  seo: 'SEO (Delivery)',
};

function formatMetricValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return 'N/A';
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return `${rounded.toLocaleString()}${unit}`;
}

export function buildUnifiedReportMetricsTable(comparison: ClientComparisonRecord): PdfTable {
  const rows: string[][] = [];
  (['media_buying', 'social_media', 'seo'] as const).forEach((service) => {
    const current = comparison.metrics_current[service] as unknown as Record<string, unknown> | undefined;
    const previous = comparison.metrics_previous[service] as unknown as Record<string, unknown> | undefined;
    if (!current && !previous) return;
    const delta = comparison.delta[service] as Partial<Record<string, number | null>> | undefined;
    const labels = SERVICE_METRIC_LABELS[service];
    const units = SERVICE_METRIC_UNITS[service];
    Object.keys(labels).forEach((metric) => {
      const currentValue = current?.[metric] as number | null | undefined;
      const previousValue = previous?.[metric] as number | null | undefined;
      const changeValue = delta?.[metric];
      rows.push([
        SERVICE_TITLES[service],
        labels[metric],
        formatMetricValue(currentValue, units[metric]),
        formatMetricValue(previousValue, units[metric]),
        changeValue === null || changeValue === undefined ? '—' : `${changeValue > 0 ? '+' : ''}${changeValue}%`,
      ]);
    });
  });
  return { headers: ['Service', 'Metric', 'Current Period', 'Previous Period', 'Change %'], rows };
}
