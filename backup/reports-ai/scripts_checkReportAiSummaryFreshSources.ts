import fs from 'node:fs';

const readSource = (path: string) => fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const hub = readSource('src/components/ReportsHub.tsx');
const workspace = readSource('src/components/reporting/ReportDraftWorkspace.tsx');
const app = readSource('src/App.tsx');

// Each click must produce a new, current-period comparison instead of resolving an existing row
// by scope/period. The normal persistence path may still upsert that current comparison.
if (!hub.includes('const generateComparisonForSummary')
  || !hub.includes('const comparison = await onGenerateComparison(')
  || !hub.includes('resolvedScope,\n      mode,')
  || hub.includes('ensureComparisonForSummary as resolveOrGenerateComparison')) {
  throw new Error('AI Summary can still reuse a same-period comparison instead of generating a fresh request.');
}

// AI Summary must fetch the server-authorized original manifest on every click and build work
// items solely from that result, never from draft text, a saved source ledger, or an old preview.
const requestStart = workspace.indexOf('const requestAiSummary = async () =>');
const requestEnd = workspace.indexOf('\n  const applySuggestion', requestStart);
const requestBody = workspace.slice(requestStart, requestEnd);
if (requestStart < 0 || requestEnd < 0
  || !requestBody.includes('const manifest = await fetchSourceManifest();')
  || !requestBody.includes('workItemsFromOriginalSources(manifest.sources)')
  || requestBody.indexOf('fetchSourceManifest()') > requestBody.indexOf('onRequestAiSummary(')
  || workspace.includes('const workItemsForAiSummary')
  || workspace.includes('previewManifest ? previewManifest.sources : sources')) {
  throw new Error('AI Summary does not start each request from a newly fetched original source manifest.');
}
if (!workspace.includes('never\n  // reads draftText, report_content_versions, or a prior summary.')) {
  throw new Error('AI source boundary between originals, report text, and prior summaries is undocumented.');
}

// Compare remains available, but the workspace opens as a normal period summary.
if (!hub.includes("useState<ReportMode>('period_summary')")) {
  throw new Error('Reports Workspace still opens with Compare selected.');
}

// The app boundary still invokes ai-router for the current payload; no cached summary is returned.
if (!app.includes("supabaseRaw.functions.invoke('ai-router'") || !app.includes("task: 'CAMPAIGN_SUMMARY'")) {
  throw new Error('AI Summary no longer invokes ai-router for the current request.');
}

console.log('OK: AI Summary always rebuilds its source manifest and comparison per click, does not feed prior report text back into AI, and Compare is off by default.');
