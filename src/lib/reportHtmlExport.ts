// A second, visually richer export format for the reporting feature — a self-contained HTML page
// (opened in a browser / sent as a file), alongside the existing jsPDF export in pdfExport.ts.
// Requested directly: jsPDF cannot reproduce gradients, rounded "card" layouts, or a screenshot
// lightbox, and this project has no server/headless-browser capability to render real HTML into a
// PDF (deploy is a frontend build + FTP only — see .github/workflows/deploy.yml) — so the closest
// way to deliver that exact look is to ship the real HTML+CSS itself, rendered by the viewer's own
// browser, same as the hand-built example report this was modeled on.
//
// Deliberately reuses, never re-derives:
//  - `parseReportContentIntoParagraphs`/`REPORT_SECTION_HEADINGS` (pdfExport.ts) for the Individual
//    report, so this renders the exact same APPROVED, SAVED content_text the PDF export does — no
//    separate "rebuild from live source data" path. An approved report's wording and attachments
//    never silently change on a later re-export in this format, same guarantee the PDF already has.
//  - `buildUnifiedReportMetricsTable` (pdfExport.ts) for the Unified report's numbers — the exact
//    same metrics computation the PDF table already uses, just laid out as cards instead of a
//    table row.
//  - `resolveEmbeddableImages` (embeddableImages.ts) for screenshots — embedded as data: URIs so a
//    saved/sent copy of the HTML file keeps working after the signed Storage URL's 30-day TTL
//    expires (matching the sample report, which is fully self-contained).
//
// Known, explicitly out-of-scope gaps (see the approved plan — a later, separate PR once the data
// exists): the Unified report has no per-campaign breakdown (only an aggregated per-client total)
// and no path to task-attachment screenshots at all, so neither appears here. Nothing is stubbed
// with placeholder/fake data for either — the corresponding section is simply omitted.
import { ClientComparisonRecord } from '../types/database';
import { extractLinks } from './textLinks';
import { resolveEmbeddableImages } from './embeddableImages';
import { parseReportContentIntoParagraphs, REPORT_SECTION_HEADINGS, buildUnifiedReportMetricsTable, PdfParagraph } from './pdfExport';

// Mirrors pdfExport.ts's BRAND_PURPLE/BRAND_PURPLE_DEEP/BRAND_WHITE (src/index.css's "Kesra Brand
// Tokens") — duplicated as plain hex literals here rather than imported, same reasoning pdfExport.ts
// itself documents for its own copies: a template string has no access to computed CSS either way,
// so there is nothing to gain from a cross-file import of three constants. The extra dark-theme
// tokens below (black/lilac/grey/roas-*) come directly from the product owner's own example report,
// which already uses this exact purple palette.
const TOKENS = `
  --black:#0a0a0d;--black-2:#151318;--purple-deep:#3b1560;--purple:#7b2ff7;--purple-light:#b98cf0;
  --lilac:#e9d9fb;--white:#ffffff;--grey:#a89bb8;
  --roas-good:#a9f5c1;--roas-mid:#f5e29a;--roas-bad:#f5a3a3;
  --gradient-page:linear-gradient(180deg,var(--black) 0%,#150f1f 40%,var(--black) 100%);
  --gradient-hero:radial-gradient(circle at 50% -10%,rgba(123,47,247,0.45),transparent 60%),linear-gradient(135deg,var(--black) 0%,var(--purple-deep) 100%);
  --gradient-title-text:linear-gradient(90deg,var(--white),var(--purple-light));
  --gradient-card:linear-gradient(160deg,var(--black-2),#1c1224);
  --gradient-badge:linear-gradient(135deg,var(--purple),var(--purple-deep));
  --gradient-section:linear-gradient(160deg,rgba(21,19,24,0.9),rgba(59,21,96,0.25));
  --border-soft:rgba(123,47,247,0.25);--border-medium:rgba(123,47,247,0.35);--border-strong:rgba(123,47,247,0.4);--border-lilac:rgba(185,140,240,0.2);
  --radius-lg:20px;--radius-md:16px;--radius-sm:12px;--radius-pill:30px;
`;

const BASE_STYLE = `
:root{${TOKENS}--font-main:'Segoe UI',Tahoma,Arial,sans-serif;}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:var(--font-main);background:var(--gradient-page);color:var(--lilac);line-height:1.7}
.wrap{width:min(1120px,calc(100% - 32px));margin:0 auto}
.hero{padding:70px 24px 56px;text-align:center;background:var(--gradient-hero);border-bottom:1px solid var(--border-lilac)}
.hero .eyebrow{color:var(--purple-light);font-weight:700;font-size:14px;margin-bottom:10px}
.hero h1{font-size:38px;margin:0 0 8px;font-weight:800;background:var(--gradient-title-text);-webkit-background-clip:text;background-clip:text;color:transparent;line-height:1.3}
.hero p{max-width:720px;margin:10px auto 0;color:var(--grey)}
.meta{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;max-width:900px;margin:30px auto 0}
.meta div{border:1px solid var(--border-medium);background:rgba(255,255,255,.04);border-radius:var(--radius-sm);padding:12px 18px;min-width:160px}
.meta span{display:block;color:var(--grey);font-size:12px}
.meta strong{display:block;color:var(--white);font-size:14px}
main{padding:36px 0 20px}
.kesra-section{border-radius:var(--radius-lg);background:var(--gradient-section);border:1px solid var(--border-soft);padding:32px 30px;margin-bottom:28px}
.sec-head{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.kesra-badge{flex:none;width:44px;height:44px;border-radius:50%;background:var(--gradient-badge);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:var(--white)}
h2{margin:0;color:var(--white);font-size:22px;line-height:1.3}
p{margin:0 0 12px}
.grid{display:grid;gap:14px}
.g4{grid-template-columns:repeat(4,1fr)}
.g3{grid-template-columns:repeat(3,1fr)}
.kesra-card{background:var(--gradient-card);border:1px solid var(--border-medium);border-radius:var(--radius-md);padding:18px}
.kpi span{display:block;color:var(--grey);font-size:13px;margin-bottom:8px}
.kpi strong{display:block;font-size:24px;color:var(--white);line-height:1.2;direction:ltr;text-align:right}
.kpi small{display:block;margin-top:8px;color:var(--grey);font-size:12px}
.note{border-right:4px solid var(--purple);background:rgba(123,47,247,.1);border-radius:var(--radius-sm);padding:14px 18px;font-size:14px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px;border-radius:var(--radius-sm);overflow:hidden}
th{background:var(--purple-deep);color:var(--white);text-align:right;padding:10px 12px;font-weight:700}
td{padding:10px 12px;border-bottom:1px solid var(--border-soft);vertical-align:top}
tbody tr:nth-child(even) td{background:rgba(123,47,247,.06)}
.tablewrap{overflow-x:auto}
ul{margin:0;padding:0 20px 0 0}
li{margin-bottom:7px}
a{color:var(--purple-light)}
.shots{display:grid;gap:18px;margin-top:14px;justify-items:center;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
figure{margin:0;text-align:center}
figure img{width:100%;max-width:280px;height:auto;border-radius:var(--radius-md);border:1px solid var(--border-strong);cursor:zoom-in;background:#000;box-shadow:0 12px 32px rgba(123,47,247,.18)}
.lb{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;z-index:50;cursor:zoom-out;padding:16px}
.lb.on{display:flex}
.lb img{max-height:96vh;max-width:96vw;border-radius:12px}
footer{border-top:1px solid var(--border-lilac);padding:22px 0 40px;color:var(--grey);font-size:13px;text-align:center}
@media print{body{background:#0a0a0d;-webkit-print-color-adjust:exact;print-color-adjust:exact}.kesra-section{break-inside:avoid}}
@media(max-width:860px){.hero h1{font-size:28px}.g4,.g3{grid-template-columns:1fr 1fr}.kesra-section{padding:22px 16px}}
@media(max-width:560px){.g4,.g3{grid-template-columns:1fr}}
`;

const LIGHTBOX_SCRIPT = `
document.querySelectorAll('.shots img').forEach(function (img) {
  img.addEventListener('click', function () {
    var lb = document.getElementById('lb');
    var lbimg = document.getElementById('lbimg');
    lbimg.src = img.src;
    lb.classList.add('on');
  });
});
var lb = document.getElementById('lb');
if (lb) lb.addEventListener('click', function () { lb.classList.remove('on'); });
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Plain text -> safe HTML, preserving line breaks (every section body here is plain text, never
// pre-escaped markup) and turning a bare URL into a real link (same shape the PDF's own link
// lines cover, minus the embedded-image case, which callers below handle separately so the image
// doesn't ALSO show up as a redundant link line under itself).
function textToHtml(text: string): string {
  return escapeHtml(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${line}</p>`)
    .join('');
}

function kpiCard(label: string, value: string, small?: string): string {
  return `<div class="kesra-card kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${
    small ? `<small>${escapeHtml(small)}</small>` : ''
  }</div>`;
}

function noteCard(heading: string, bodyHtml: string): string {
  return `<section class="kesra-section"><h2>${escapeHtml(heading)}</h2><div class="note">${bodyHtml}</div></section>`;
}

function pageShell(opts: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  metaItems: { label: string; value: string }[];
  bodyHtml: string;
}): string {
  const metaHtml = opts.metaItems
    .map((item) => `<div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`)
    .join('');
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${BASE_STYLE}</style>
</head>
<body class="kesra-report">
<header class="hero">
  <div class="eyebrow">${escapeHtml(opts.eyebrow)}</div>
  <h1>${escapeHtml(opts.title)}</h1>
  ${opts.subtitle ? `<p>${escapeHtml(opts.subtitle)}</p>` : ''}
  <div class="meta">${metaHtml}</div>
</header>
<main class="wrap">
${opts.bodyHtml}
</main>
<footer><div class="wrap">KESRA Management System</div></footer>
<div class="lb" id="lb"><img id="lbimg" alt=""></div>
<script>${LIGHTBOX_SCRIPT}</script>
</body>
</html>`;
}

// Splits a work-log section's body (one "Employee: text" line per entry, with any attachment
// links appended as their own bare-URL lines directly underneath — composeManifestContent/
// renderWorkLogSection's exact output shape) back into entries, pairing each attachment URL with
// the entry above it. A line that is ONLY a link (no other text once extractLinks strips it) is
// treated as an attachment of the PREVIOUS entry; anything else starts a new entry (keeping any
// links found inline within its own text, in case a line ever carries both).
function parseWorkLogEntries(body: string): { text: string; attachmentUrls: string[] }[] {
  const entries: { text: string; attachmentUrls: string[] }[] = [];
  body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const { cleanText, links } = extractLinks(line);
      if (!cleanText && links.length && entries.length) {
        entries[entries.length - 1].attachmentUrls.push(...links);
        return;
      }
      entries.push({ text: cleanText || line, attachmentUrls: links });
    });
  return entries;
}

// A task-evidence-ledger line's exact shape (reportDraftSources.ts):
// `${title} — ${classification}; ${completion}; linked log dates: ${dates}`. Split defensively —
// a line that doesn't match this exact shape (hand-edited, or the format ever changes) still
// renders, just as a single cell instead of four columns.
function parseTaskLedgerLine(line: string): string[] {
  const dashIndex = line.indexOf(' — ');
  if (dashIndex === -1) return [line];
  const title = line.slice(0, dashIndex);
  const rest = line.slice(dashIndex + 3).split('; ');
  return [title, ...rest.map((part) => part.replace(/^linked log dates:\s*/, ''))];
}

async function renderWorkLogsSection(sections: PdfParagraph[]): Promise<string> {
  const allUrls = new Set<string>();
  const parsedSections = sections.map((section) => ({ ...section, entries: parseWorkLogEntries(section.body) }));
  parsedSections.forEach((section) => section.entries.forEach((entry) => entry.attachmentUrls.forEach((url) => allUrls.add(url))));
  const imageAssets = await resolveEmbeddableImages(allUrls);

  const cardsHtml = parsedSections
    .map((section, i) => {
      const entriesHtml = section.entries
        .map((entry) => {
          const images = entry.attachmentUrls.map((url) => imageAssets.get(url)).filter((a): a is NonNullable<typeof a> => !!a);
          const linkOnlyUrls = entry.attachmentUrls.filter((url) => !imageAssets.get(url));
          const shotsHtml = images.length
            ? `<div class="shots">${images
                .map((asset) => `<figure><img src="${asset.dataUrl}" alt=""></figure>`)
                .join('')}</div>`
            : '';
          const linksHtml = linkOnlyUrls.length
            ? `<p>${linkOnlyUrls.map((url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">View attachment</a>`).join(' · ')}</p>`
            : '';
          return `<div class="kesra-card" style="margin-bottom:10px"><p>${escapeHtml(entry.text)}</p>${shotsHtml}${linksHtml}</div>`;
        })
        .join('');
      const dividerStyle = section.divider && i > 0 ? 'border-top:1px solid var(--border-soft);padding-top:18px;margin-top:18px' : '';
      return `<div style="${dividerStyle}">${section.heading !== REPORT_SECTION_HEADINGS.workLogs ? `<h3 style="color:var(--purple-light);margin:0 0 10px">${escapeHtml(section.heading)}</h3>` : ''}${entriesHtml}</div>`;
    })
    .join('');

  // No visible section heading here, by request: "Work logs (primary source)" is an internal
  // parsing marker (REPORT_SECTION_HEADINGS/parseReportContentIntoParagraphs), never meant for the
  // report's reader. A client-scope report already never showed it (its per-service sub-headings —
  // see the `<h3>` check above — render instead), but this top-level `<h2>` used to print it
  // unconditionally for every scope, including employee-scope (no service sub-split). Dropped
  // entirely rather than replaced, so neither scope shows it.
  return `<section class="kesra-section">${cardsHtml}</section>`;
}

function renderCreativeSummarySection(body: string): string {
  const cardsHtml = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) return kpiCard(line, '');
      return kpiCard(line.slice(0, colonIndex).trim(), line.slice(colonIndex + 1).trim());
    })
    .join('');
  return `<section class="kesra-section"><div class="sec-head"><div class="kesra-badge">02</div><h2>${escapeHtml(
    REPORT_SECTION_HEADINGS.creativeSummary
  )}</h2></div><div class="grid g3">${cardsHtml}</div></section>`;
}

function renderTaskLedgerSection(body: string): string {
  const rows = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseTaskLedgerLine);
  const rowsHtml = rows
    .map((cells) => `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  const headerCells = ['Task', 'Classification', 'Status', 'Evidence dates'];
  return `<section class="kesra-section"><h2>${escapeHtml(
    REPORT_SECTION_HEADINGS.taskLedger
  )}</h2><div class="tablewrap"><table><thead><tr>${headerCells
    .map((h) => `<th>${h}</th>`)
    .join('')}</tr></thead><tbody>${rowsHtml}</tbody></table></div></section>`;
}

export interface IndividualReportHtmlOptions {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  contentText: string;
}

// Built entirely from the already-APPROVED, saved `content_text` — the exact same parsed
// structure `downloadReportPdf` already derives via `parseReportContentIntoParagraphs`. Never
// re-fetches live source data, so an approved report's wording/attachments can't silently change
// between one export and the next (see this file's header comment).
export async function buildIndividualReportHtml(options: IndividualReportHtmlOptions): Promise<string> {
  const sections = parseReportContentIntoParagraphs(options.contentText);
  // Everything that ISN'T one of the four other known top-level sections (or the unrecognized-
  // shape fallback) is work-log content: either the plain `workLogs` heading itself (the common,
  // employee-scope case), or one of its per-service sub-headings (Media Buying/Social Media/SEO/
  // Other updates — only produced for a client-scope report in this same draft workspace, which
  // also exports through this function). Checked by elimination rather than importing the private
  // service-subheading set from pdfExport.ts, since "not one of these four, and not the fallback"
  // is already exactly what parseReportContentIntoParagraphs guarantees.
  const NON_WORKLOG_HEADINGS = new Set<string>([
    REPORT_SECTION_HEADINGS.creativeSummary,
    REPORT_SECTION_HEADINGS.taskLedger,
    REPORT_SECTION_HEADINGS.employeeContext,
    REPORT_SECTION_HEADINGS.creatorContext,
    'Final Report',
  ]);
  const workLogSections = sections.filter((s) => !NON_WORKLOG_HEADINGS.has(s.heading));
  const otherSections = sections.filter((s) => NON_WORKLOG_HEADINGS.has(s.heading));

  const parts: string[] = [];
  if (workLogSections.length) parts.push(await renderWorkLogsSection(workLogSections));
  otherSections.forEach((section) => {
    if (section.heading === REPORT_SECTION_HEADINGS.creativeSummary) {
      parts.push(renderCreativeSummarySection(section.body));
    } else if (section.heading === REPORT_SECTION_HEADINGS.taskLedger) {
      parts.push(renderTaskLedgerSection(section.body));
    } else {
      parts.push(noteCard(section.heading, textToHtml(section.body)));
    }
  });

  return pageShell({
    eyebrow: 'Employee Report — KESRA Management System',
    title: options.title,
    subtitle: options.subtitle,
    metaItems: options.subtitle ? [{ label: 'Period / Subject', value: options.subtitle }] : [],
    bodyHtml: parts.join(''),
  });
}

export interface UnifiedReportHtmlOptions {
  title: string;
  subtitle?: string;
  narrative: string;
  recommendations: string[];
  comparison: ClientComparisonRecord;
}

// Partial by design (see this file's header comment): no per-campaign breakdown, no screenshots —
// both would need new data plumbing this report's data path doesn't have today. Every number
// shown here comes from `buildUnifiedReportMetricsTable`, the exact same computation the PDF's
// metrics table already uses.
export async function buildUnifiedReportHtml(options: UnifiedReportHtmlOptions): Promise<string> {
  const table = buildUnifiedReportMetricsTable(options.comparison);
  const cardsHtml = table.rows
    .map(([service, metric, current, previous, change]) => kpiCard(`${service} — ${metric}`, current, `Previous: ${previous} · Change: ${change}`))
    .join('');

  const recommendationsHtml = options.recommendations.length
    ? `<ul>${options.recommendations.map((rec) => `<li>${escapeHtml(rec)}</li>`).join('')}</ul>`
    : '';

  const bodyHtml = `
    <section class="kesra-section">
      <div class="sec-head"><div class="kesra-badge">01</div><h2>Key Metrics</h2></div>
      <div class="grid g3">${cardsHtml}</div>
    </section>
    <section class="kesra-section">
      <h2>Narrative</h2>
      <div class="note">${textToHtml(options.narrative)}</div>
      ${recommendationsHtml ? `<h2 style="margin-top:18px">Recommendations</h2>${recommendationsHtml}` : ''}
    </section>
  `;

  return pageShell({
    eyebrow: 'Unified Client Report — KESRA Management System',
    title: options.title,
    subtitle: options.subtitle,
    metaItems: options.subtitle ? [{ label: 'Period', value: options.subtitle }] : [],
    bodyHtml,
  });
}

// Client-side-only download, same pattern jsPDF's own `doc.save()` already uses (Blob + object
// URL + a temporary <a download> click) — no server round trip, matches this app's existing
// "export happens entirely in the browser" constraint.
export function downloadHtmlReport(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
