// Static source-text checks (same style as checkReportAiSummaryFreshSources.ts/
// checkReportDraftGroupingPersistence.ts) for "Revert to original sources" — a button for an
// already-open report that rebuilds the draft text from a fresh source manifest with no grouping
// and no AI rephrase, discarding whatever "Group similar entries"/"AI Summary" currently has
// active. Requested after confirming neither existing action does this: Undo only reverses the
// single most recent action, and Clear AI text reverts to the last SAVED version (which may
// itself already be a grouped/AI-rephrased version), not to the raw original sources.
import fs from 'node:fs';

const workspace = fs.readFileSync('src/components/reporting/ReportDraftWorkspace.tsx', 'utf8').replace(/\r\n/g, '\n');

const fnStart = workspace.indexOf('const revertToOriginalSources = async () =>');
const fnEnd = workspace.indexOf('\n  const applySuggestion', fnStart);
const fnBody = workspace.slice(fnStart, fnEnd);
if (fnStart < 0 || fnEnd < 0
  || !fnBody.includes('const manifest = await fetchSourceManifest();')
  || !fnBody.includes("composeManifestContent(manifest, creatorNote, names, creativeSubject, attachmentLinksByTask, undefined, workLogServiceGrouping, effectiveScopeType === 'employee')")
  || !/setDraftTextWithUndo\(\s*composeManifestContent\([^)]*\),\s*undefined\s*\);/.test(fnBody)) {
  throw new Error('revertToOriginalSources must fetch a fresh manifest and compose the draft with NO grouping (undefined), via the one-step-undo setter.');
}

if (!workspace.includes("onClick={revertToOriginalSources}")
  || !workspace.includes('Revert to original sources</button>')) {
  throw new Error('The "Revert to original sources" button is missing from the already-open-report toolbar.');
}

console.log('OK: "Revert to original sources" rebuilds the draft from a fresh, ungrouped, un-rephrased source manifest and is wired into the open-report toolbar with one-step Undo support.');
