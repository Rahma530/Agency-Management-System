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
//  1. Noto Naskh Arabic (public/fonts/NotoNaskhArabic-Regular.ttf + -Bold.ttf, license copy at
//     public/fonts/NotoNaskhArabic-OFL.txt) — SIL Open Font License 1.1, extracted from the
//     static TTF files inside the npm package @expo-google-fonts/noto-naskh-arabic (also OFL)
//     rather than hand-sourced, so provenance is traceable to a real package release. Used for
//     the ENTIRE PDF now (header wordmark, headings, body, bullets, table) — a single consistent
//     font end to end.
//
//     Cairo was tried first (per an explicit request for a clearer UI-style font) and REJECTED
//     after rendering a real test PDF: despite passing an offline fontTools glyph-coverage check
//     (it has most Arabic Presentation Forms codepoints, including the lam-alef ligatures
//     U+FEFB/FEFC), the ACTUAL rendered output silently dropped standalone/initial alif glyphs in
//     real sentences ("ارتفعت" -> "تفعت", "الاكتساب" -> "لاكتسا", "إلى" -> "لى") — a font data gap
//     narrower than what the offline codepoint check could catch. Tajawal (the first documented
//     fallback) reproduced the exact same failure. Both are UI/display families, not full print-
//     shaping Naskh faces. Noto Naskh Arabic (like the original Amiri) is a traditional Naskh
//     print typeface with complete Presentation Forms A+B coverage, and was verified correct on
//     the SAME test sentence (lam-alef, every hamza form, tashkeel, Arabic-Indic and Western
//     digits, embedded English) before being adopted here — see this PR's description for the
//     rendered comparison.
//  2. bidi-shaper (github.com/cc1a2b/bidi-shaper, MIT) for Unicode BiDi (UAX #9) reordering +
//     Arabic contextual shaping. jsPDF's OWN built-in Arabic handling is independently documented
//     to mis-order MIXED Arabic+Latin content (parallax/jsPDF issues #2004, #1816, #2178) — exactly
//     this app's case, since every generated sentence can have an English metric name (ROAS, CPA)
//     embedded in Arabic prose. bidi-shaper's jsPDF adapter hooks doc.text() so every string is
//     pre-shaped into final visual order — using Arabic Presentation Forms characters, which
//     jsPDF's own native Arabic parser does not touch, so the two never double-process the same
//     text (confirmed in bidi-shaper's own adapter docs). bidi-shaper itself is font-agnostic —
//     the Cairo/Tajawal failures above were real gaps in those fonts' own glyph data, not a
//     bidi-shaper bug (confirmed by swapping only the font, with the exact same code, between all
//     four candidates and reproducing/fixing the same symptom each time).
//
// bidi-shaper is a genuinely new library (3 versions published within a two-hour window, no
// real-world track record) — chosen over the mature, widely-referenced alternative
// (`arabic-reshaper` and every JS port of it), which is GPL-3.0-licensed and therefore not safe to
// bundle into this commercial app's client bundle. This file is the one, small, isolated boundary
// around it: if real-world use ever surfaces a rendering bug, only this module needs to change.
//
// Both font files are static assets under public/fonts/, fetched over HTTP only when a "Download
// PDF" button is actually pressed (loadArabicFontBundle below) — never imported into the JS
// bundle, so this costs 0 bytes of bundle size either way; just a one-time ~390KB combined fetch
// (NotoNaskhArabic-Regular ~195KB + -Bold ~195KB) on first use, cached by the browser after that.
import { jsPDF } from 'jspdf';
import { installJsPdfShaper } from 'bidi-shaper/jspdf';
import { ClientComparisonRecord } from '../types/database';
import { extractLinks } from './textLinks';

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
const LINK_COLOR = '#1a56db'; // standard "visited-safe" hyperlink blue, distinct from BRAND_PURPLE
// so a link never reads as a themed heading/accent.

const NOTO_NASKH_FONT_NAME = 'NotoNaskhArabic';
const NOTO_NASKH_REGULAR_URL = '/fonts/NotoNaskhArabic-Regular.ttf';
const NOTO_NASKH_BOLD_URL = '/fonts/NotoNaskhArabic-Bold.ttf';
const AMIRI_FONT_NAME = 'Amiri';
const AMIRI_REGULAR_URL = '/fonts/Amiri-Regular.ttf';

export interface ArabicFontBundle {
  name: string;
  // Base64-encoded TTF data for the 'normal' and 'bold' jsPDF font styles, both registered under
  // the same family `name`. Amiri has no separate bold file shipped in this codebase, so the
  // fallback bundle reuses its one file for both styles — jsPDF's own bold SYNTHESIS (faux-bold,
  // via a transform) only applies to a font that has no 'bold' style registered at all, so
  // registering the same data under 'bold' just means Amiri's fallback has no visually distinct
  // bold — an acceptable degradation for an already-exceptional failure path.
  normal: string;
  bold: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // avoid a single huge String.fromCharCode(...spread) call
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchFontBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (HTTP ${res.status}).`);
  return arrayBufferToBase64(await res.arrayBuffer());
}

let arabicFontBundlePromise: Promise<ArabicFontBundle> | null = null;

// Fetched once per page load (the font files never change at runtime) and cached — every PDF
// generated after the first reuses the same resolved promise instead of re-fetching. Falls back to
// the single-weight Amiri bundle only if the Noto Naskh Arabic fetch itself fails (network/404) —
// never for a rendering-quality reason: both fonts render this feature's content correctly
// (verified on a real rendered test PDF — see the header comment above), so either is a safe
// result, just never silently landing on one of the REJECTED Cairo/Tajawal fonts.
export function loadArabicFontBundle(): Promise<ArabicFontBundle> {
  if (!arabicFontBundlePromise) {
    arabicFontBundlePromise = (async () => {
      try {
        const [normal, bold] = await Promise.all([
          fetchFontBase64(NOTO_NASKH_REGULAR_URL),
          fetchFontBase64(NOTO_NASKH_BOLD_URL),
        ]);
        return { name: NOTO_NASKH_FONT_NAME, normal, bold };
      } catch (err) {
        console.error('Noto Naskh Arabic font failed to load, falling back to Amiri:', err);
        const normal = await fetchFontBase64(AMIRI_REGULAR_URL);
        return { name: AMIRI_FONT_NAME, normal, bold: normal };
      }
    })();
  }
  return arabicFontBundlePromise;
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

// Pure given an already-loaded font bundle — kept separate from downloadReportPdf so it can be
// exercised directly (e.g. from a Node script reading the font off disk) without a browser's
// fetch().
export function buildReportDoc(fontBundle: ArabicFontBundle, options: ReportPdfOptions): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const fontFamily = fontBundle.name;
  doc.addFileToVFS(`${fontFamily}-Regular.ttf`, fontBundle.normal);
  doc.addFont(`${fontFamily}-Regular.ttf`, fontFamily, 'normal');
  doc.addFileToVFS(`${fontFamily}-Bold.ttf`, fontBundle.bold);
  doc.addFont(`${fontFamily}-Bold.ttf`, fontFamily, 'bold');

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - PAGE_MARGIN * 2;

  // Title/subtitle are right-aligned Arabic (or mixed) text now (client name + "من ... إلى ...")
  // instead of the short, fixed English labels this header was designed for — so, unlike before,
  // they must wrap (never run past the left edge) and the header's own height must grow to fit
  // however many lines that produces. Measured once, in the same font/size actually drawn, before
  // computing headerHeight — same isOutputVisual:true requirement as every other Arabic doc.text()
  // call below (see drawArabicParagraph's own comment for exactly why).
  doc.setFont(fontFamily, 'bold');
  doc.setFontSize(13);
  const titleLines: string[] = doc.splitTextToSize(options.title, contentWidth);
  doc.setFont(fontFamily, 'normal');
  doc.setFontSize(9);
  const subtitleLines: string[] = options.subtitle ? doc.splitTextToSize(options.subtitle, contentWidth) : [];
  const headerHeight = 24 + titleLines.length * 15 + (subtitleLines.length ? subtitleLines.length * 12 + 4 : 0);
  let y = headerHeight + 32;

  function drawHeader(): void {
    doc.setFillColor(BRAND_PURPLE);
    doc.rect(0, 0, pageWidth, headerHeight, 'F');
    // Text wordmark standing in for a logo (see this file's header comment) — swap for
    // doc.addImage(logoDataUrl, 'PNG', PAGE_MARGIN, 16, width, height) here once a real logo asset
    // exists in this codebase. Drawn in the same font family as everything else on the page, per
    // the "one consistent font throughout" requirement — it's plain ASCII text, so the font switch
    // changes nothing visually here beyond matching letterforms with the rest of the document.
    doc.setFont(fontFamily, 'bold');
    doc.setFontSize(16);
    doc.setTextColor(BRAND_WHITE);
    doc.text('KESRA', PAGE_MARGIN, 32);
    doc.setFont(fontFamily, 'normal');
    doc.setFontSize(9);
    doc.text('Management System', PAGE_MARGIN, 46);

    doc.setFont(fontFamily, 'bold');
    doc.setFontSize(13);
    doc.text(options.title, pageWidth - PAGE_MARGIN, 28, {
      align: 'right',
      maxWidth: contentWidth,
      lineHeightFactor: 1.3,
      isOutputVisual: true,
    });
    if (options.subtitle) {
      doc.setFont(fontFamily, 'normal');
      doc.setFontSize(9);
      doc.text(options.subtitle, pageWidth - PAGE_MARGIN, 28 + titleLines.length * 15 + 10, {
        align: 'right',
        maxWidth: contentWidth,
        lineHeightFactor: 1.3,
        isOutputVisual: true,
      });
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
    doc.setFont(fontFamily, 'bold');
    doc.setFontSize(11);
    doc.setTextColor(BRAND_PURPLE_DEEP);
    doc.text(text, PAGE_MARGIN, y);
    y += 16;
  }

  // Arabic (or mixed Arabic/English) paragraph — right-aligned, Noto Naskh Arabic font, bidi-shaper handles
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
  // A raw "https://..." URL left inside an Arabic paragraph/bullet reads backwards (bidi treats
  // its LTR run as a single unit, but a long URL wrapped across lines by jsPDF's own
  // splitTextToSize can still visually invert against the surrounding RTL text) and is plain,
  // unclickable text. Extracted out of the sentence (extractLinks, textLinks.ts) and drawn here,
  // one per own LTR line below the paragraph/bullet/cell it came from: blue, underlined, and a
  // real clickable annotation (doc.textWithLink) — never embedded back into the Arabic body.
  // Deliberately NOT given isOutputVisual/bidi-shaper treatment: this is already plain ASCII with
  // nothing to reorder or shape, the same assumption drawTable's English cells already rely on.
  function drawLinkLines(links: string[], indent = 0): void {
    const lineHeight = 14;
    links.forEach((link) => {
      doc.setFont(fontFamily, 'normal');
      doc.setFontSize(10);
      const subLines: string[] = doc.splitTextToSize(link, contentWidth - indent);
      ensureSpace(subLines.length * lineHeight);
      doc.setTextColor(LINK_COLOR);
      subLines.forEach((subLine, i) => {
        const lineY = y + i * lineHeight;
        doc.textWithLink(subLine, PAGE_MARGIN + indent, lineY, { url: link, align: 'left' });
        const textWidth = doc.getTextWidth(subLine);
        doc.setDrawColor(LINK_COLOR);
        doc.line(PAGE_MARGIN + indent, lineY + 2, PAGE_MARGIN + indent + textWidth, lineY + 2);
      });
      y += subLines.length * lineHeight + 4;
    });
  }

  function drawArabicParagraph(text: string): void {
    const { cleanText, links } = extractLinks(text);
    doc.setFont(fontFamily, 'normal');
    doc.setFontSize(11);
    doc.setTextColor(BODY_TEXT_COLOR);
    const lineHeight = 16;
    const estimatedLines = doc.splitTextToSize(cleanText, contentWidth);
    ensureSpace(estimatedLines.length * lineHeight);
    doc.text(cleanText, pageWidth - PAGE_MARGIN, y, {
      align: 'right',
      maxWidth: contentWidth,
      lineHeightFactor: 1.4,
      isOutputVisual: true,
    });
    y += estimatedLines.length * lineHeight + 10;
    drawLinkLines(links);
  }

  function drawBulletList(items: string[]): void {
    const lineHeight = 16;
    const bulletGap = 14; // reserved space for the bullet marker + gap at the right margin
    items.forEach((rawItem) => {
      const { cleanText: item, links } = extractLinks(rawItem);
      doc.setFont(fontFamily, 'normal');
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
      doc.setFont(fontFamily, 'normal');
      doc.setTextColor(BODY_TEXT_COLOR);
      doc.text('•', pageWidth - PAGE_MARGIN, y, { align: 'right' });
      doc.setFont(fontFamily, 'normal');
      doc.text(item, pageWidth - PAGE_MARGIN - bulletGap, y, {
        align: 'right',
        maxWidth: contentWidth - bulletGap,
        lineHeightFactor: 1.4,
        isOutputVisual: true,
      });
      y += lines.length * lineHeight + 4;
      // Indented to roughly where the bullet's own text starts, so a link visually belongs to
      // its bullet rather than reading as a new top-level line.
      drawLinkLines(links, bulletGap);
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
      doc.setFont(fontFamily, isHeader ? 'bold' : 'normal');
      doc.setFontSize(9);
      doc.setTextColor(isHeader ? BRAND_WHITE : BODY_TEXT_COLOR);
      if (isHeader) {
        doc.setFillColor(BRAND_PURPLE_DEEP);
        doc.rect(PAGE_MARGIN, y - 14, contentWidth, rowHeight, 'F');
      }
      cells.forEach((cell, i) => {
        // Defensive: today's metrics-table cells are always numeric/English labels, never a URL,
        // but a cell that does contain one still gets a real clickable annotation (same style as
        // the paragraph/bullet link lines) instead of silently rendering dead text.
        const cellLink = !isHeader ? extractLinks(cell).links[0] : undefined;
        if (cellLink) {
          doc.setTextColor(LINK_COLOR);
          doc.textWithLink(cell, PAGE_MARGIN + i * colWidth + 6, y, { url: cellLink });
          const textWidth = doc.getTextWidth(cell);
          doc.setDrawColor(LINK_COLOR);
          doc.line(PAGE_MARGIN + i * colWidth + 6, y + 2, PAGE_MARGIN + i * colWidth + 6 + textWidth, y + 2);
          doc.setTextColor(isHeader ? BRAND_WHITE : BODY_TEXT_COLOR);
        } else {
          doc.text(cell, PAGE_MARGIN + i * colWidth + 6, y);
        }
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
  const fontBundle = await loadArabicFontBundle();
  const doc = buildReportDoc(fontBundle, options);
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
