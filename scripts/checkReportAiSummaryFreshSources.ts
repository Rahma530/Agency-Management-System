import fs from 'node:fs';

const readSource = (path: string) => fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const hub = readSource('src/components/ReportsHub.tsx');
const workspace = readSource('src/components/reporting/ReportDraftWorkspace.tsx');
const app = readSource('src/App.tsx');
const dashboard = readSource('src/components/ClientDashboard.tsx');
const engine = readSource('src/lib/reportingEngine.ts');

// Each click must produce a new, current-period comparison instead of resolving an existing row
// by scope/period. The normal persistence path may still upsert that current comparison.
if (!hub.includes('const generateComparisonForSummary')
  || !hub.includes('const comparison = await onGenerateComparison(')
  || !hub.includes('resolvedScope,\n      mode,')
  || hub.includes('ensureComparisonForSummary as resolveOrGenerateComparison')) {
  throw new Error('ReportsHub.tsx AI Summary can still reuse a same-period comparison instead of generating a fresh request.');
}

// ClientDashboard.tsx has its own, independent "Generate AI Summary" wiring (DirectAiSummaryPanel/
// UnifiedReportPanel) — it must not keep the old reuse-shortcut either.
if (dashboard.includes('ensureComparisonForSummary as resolveOrGenerateComparison')
  || dashboard.includes('resolveOrGenerateComparison(')
  || !dashboard.includes('if (!onGenerateComparison) return null;')) {
  throw new Error('ClientDashboard.tsx AI Summary can still reuse a same-period comparison instead of generating a fresh request.');
}

// The shared lookup-or-generate helper that caused the reuse above must be gone entirely, not
// just unused by its two former callers — otherwise a future caller could wire back into it.
if (engine.includes('export async function ensureComparisonForSummary')) {
  throw new Error('reportingEngine.ts still exports the shared ensureComparisonForSummary reuse-shortcut.');
}

// AI Summary must fetch the server-authorized original manifest on every click and build work
// items solely from that result (plus, now, whatever grouping/rephrase state this same session
// already produced from an earlier fresh fetch — activeWorkLogGroups is never fed from draft
// text, a saved source ledger, or an old preview; see workItemsFromOriginalSources/
// requestAiSummary's own comments), never directly from draft text, a saved source ledger, or an
// old preview.
const requestStart = workspace.indexOf('const requestAiSummary = async () =>');
const requestEnd = workspace.indexOf('\n  const applySuggestion', requestStart);
const requestBody = workspace.slice(requestStart, requestEnd);
if (requestStart < 0 || requestEnd < 0
  || !requestBody.includes('const manifest = await fetchSourceManifest();')
  || !requestBody.includes('workItemsFromOriginalSources(manifest.sources, activeWorkLogGroups)')
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

// The deeper gap: even a freshly-generated comparison/period-summary must be computed from data
// just read from the database, not whatever's already sitting in this tab's React state. This is
// a text-presence check only — it proves the fetch calls are present in handleGenerateComparison,
// not that they run correctly at runtime or race-free against concurrent edits.
const handlerStart = app.indexOf('const handleGenerateComparison = async (');
const handlerEnd = app.indexOf('\n  const createVersionedComparisonDraft', handlerStart);
const handlerBody = app.slice(handlerStart, handlerEnd);
if (handlerStart < 0 || handlerEnd < 0
  || !handlerBody.includes("supabaseRaw.from('clients').select(NON_SENSITIVE_CLIENT_COLUMNS).in('id', clientIds)")
  || !handlerBody.includes("supabaseRaw.from('campaigns').select('*').in('client_id', clientIds)")
  || !handlerBody.includes("supabaseRaw.from('tasks').select('*').in('client_id', clientIds)")
  || !handlerBody.includes("supabase.from('social_insights').select('*').in('client_id', clientIds)")
  || !handlerBody.includes("supabase.from('seo_insights').select('*').in('client_id', clientIds)")
  || !handlerBody.includes('generateClientComparison(freshClients, current, previous!, freshCampaigns, freshTasks, freshSocialInsights, freshSeoInsights, serviceFilter)')
  || !handlerBody.includes('generatePeriodSummary(freshClients, current, freshCampaigns, freshTasks, freshSocialInsights, freshSeoInsights, serviceFilter)')) {
  throw new Error('handleGenerateComparison no longer fetches fresh clients/campaigns/tasks/social_insights/seo_insights before computing metrics.');
}

console.log('OK: AI Summary always rebuilds its source manifest and comparison per click (ReportsHub.tsx and ClientDashboard.tsx alike), computes over freshly-fetched data rather than stale React state, does not feed prior report text back into AI, and Compare is off by default.');
