// Static source-text check (same style as checkReportRevertToOriginalSources.ts) for the download
// filename bug reported 2026-11-07: every report's HTML/PDF download used to be named literally
// "report-<period>.html"/"report-<period>.pdf" regardless of which client/employee it was for, so
// downloading different clients' reports for the same week piled up as confusing "(1)", "(2)",
// "(3)" copies in the browser's downloads folder with no way to tell them apart by filename.
// exportHtml/exportPdf aren't exported, so this checks ReportDraftWorkspace.tsx's own source for
// the specific pattern the fix depends on, same reason checkReportRevertToOriginalSources.ts does.
import fs from 'node:fs';

const workspace = fs.readFileSync('src/components/reporting/ReportDraftWorkspace.tsx', 'utf8').replace(/\r\n/g, '\n');

if (workspace.includes('`report-${selectedReport.period || selectedReport.id}.html`')
  || workspace.includes('`report-${selectedReport.period || selectedReport.id}.pdf`')) {
  throw new Error('The download filename must no longer be the literal word "report" for every client/employee — this was the exact collision bug reported.');
}

const htmlExportStart = workspace.indexOf('const exportHtml = async () => {');
const htmlExportEnd = workspace.indexOf('\n\n  return (', htmlExportStart);
const htmlExportBody = workspace.slice(htmlExportStart, htmlExportEnd);
if (htmlExportStart < 0
  || !htmlExportBody.includes('downloadHtmlReport(html, `${safeFilenamePart(subjectName)}-${selectedReport.period || selectedReport.id}.html`);')) {
  throw new Error('exportHtml must name the downloaded file after the report\'s own subjectName (client/employee), not a generic "report" literal.');
}

const pdfExportStart = workspace.indexOf('const exportPdf = async () => {');
const pdfExportEnd = workspace.indexOf('\n  const requestAiSummary', pdfExportStart);
const pdfExportBody = workspace.slice(pdfExportStart, pdfExportEnd);
if (pdfExportStart < 0
  || !pdfExportBody.includes('filename: `${safeFilenamePart(subjectName)}-${selectedReport.period || selectedReport.id}.pdf`,')) {
  throw new Error('exportPdf must name the downloaded file after the report\'s own subjectName (client/employee), not a generic "report" literal.');
}

console.log('OK: downloaded report files (HTML and the currently-hidden PDF) are named after the report\'s own client/employee, never a generic "report-<period>" literal that collides across different subjects.');
