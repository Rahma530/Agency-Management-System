// Static source-text checks (same style as checkReportRevertToOriginalSources.ts/
// checkReportAiSummaryFreshSources.ts) for the "All Services" scope narrowing requested
// 2026-11-07: a client-scope report's mandatory-even-empty section treatment must apply ONLY to
// the three core, genuinely-recurring services (SEO, Social Media, Media Buying) — not to one-off
// services (واجهة/الانشاء/branding/graphic_design), which must only ever appear when the report
// was explicitly scoped to exactly that one service, and only if it actually has content.
// renderWorkLogSection/workLogServiceGrouping are not exported (same reason
// checkReportRevertToOriginalSources.ts reads source text rather than importing), so this checks
// the actual function source for the specific patterns the fix depends on.
import fs from 'node:fs';

const workspace = fs.readFileSync('src/components/reporting/ReportDraftWorkspace.tsx', 'utf8').replace(/\r\n/g, '\n');

// 1) The WorkLogServiceGrouping shape carries the report's own active single-service filter.
if (!workspace.includes('activeServiceFilter: ServiceType | null')) {
  throw new Error('WorkLogServiceGrouping must carry activeServiceFilter so renderWorkLogSection can tell "All Services" apart from a single-service-scoped report.');
}

const groupingStart = workspace.indexOf('const workLogServiceGrouping = useMemo(() => {');
const groupingEnd = workspace.indexOf('\n  // Point 2:', groupingStart);
const groupingBody = workspace.slice(groupingStart, groupingEnd);
if (groupingStart < 0 || groupingEnd < 0
  || !groupingBody.includes('CLIENT_SERVICES.includes(effectiveClientServiceFilter as ServiceType)')
  || !groupingBody.includes('return { client, usersById, assignedServicesByUser, activeServiceFilter };')) {
  throw new Error('workLogServiceGrouping must derive activeServiceFilter from effectiveClientServiceFilter, narrowed to a real ServiceType (never the synthetic "own_entries" value).');
}

// 2) renderWorkLogSection's ordered-keys logic: core services are the ONLY ones unconditionally
// included; a non-core service is included only when it's this report's own active filter AND it
// actually has bucketed content.
const fnStart = workspace.indexOf('function renderWorkLogSection(');
const fnEnd = workspace.indexOf('\nfunction composeManifestContent(', fnStart);
const fnBody = workspace.slice(fnStart, fnEnd);
if (fnStart < 0 || fnEnd < 0) throw new Error('Could not locate renderWorkLogSection in ReportDraftWorkspace.tsx.');

if (!fnBody.includes('const coreSubscribedServices = PRIORITY_SERVICE_ORDER.filter((service) => subscribedServices.has(service));')) {
  throw new Error('Only PRIORITY_SERVICE_ORDER (SEO/Social Media/Media Buying) may be unconditionally mandatory-even-empty.');
}
if (fnBody.includes('CLIENT_SERVICES.filter((service) => !PRIORITY_SERVICE_ORDER.includes(service) && subscribedServices.has(service))')) {
  throw new Error('A one-off service (واجهة/الانشاء/branding/graphic_design) must no longer be forced mandatory just for being subscribed — this was the exact bug reported.');
}
if (!fnBody.includes('serviceGrouping.activeServiceFilter')
  || !/selectedNonCoreService\s*=\s*\n?\s*filteredService\s*&&\s*\n?\s*!PRIORITY_SERVICE_ORDER\.includes\(filteredService\)\s*&&\s*\n?\s*subscribedServices\.has\(filteredService\)\s*&&\s*\n?\s*buckets\.has\(filteredService\)/.test(fnBody)) {
  throw new Error('A non-core service must only be included when it IS this report\'s own active filter, is subscribed, AND actually has bucketed content.');
}

console.log('OK: "All Services" mandatory-even-empty sections are limited to SEO/Social Media/Media Buying; one-off services (واجهة/الانشاء/branding/graphic_design) only ever appear when a report is explicitly scoped to exactly that one service and it has real content.');
