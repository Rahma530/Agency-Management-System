// Static source-text check (same style as checkReportDraftGroupingPersistence.ts/
// checkReportRevertToOriginalSources.ts) guarding a real, reported bug: the report-switch effect
// in ReportDraftWorkspace.tsx used to depend on the whole `reports` array (a prop mirroring
// App.tsx's GLOBAL list of every report in the system). That array gets a brand-new reference on
// any unrelated mutation anywhere in the app (another bulk task action, another report being
// saved, a background refetch) — not only when the report actually open in this workspace changes.
// Depending on it directly meant any of those unrelated refreshes silently re-ran the effect
// mid-session and wiped activeWorkLogGroups/undoSnapshot/previewManifest/draftText back to the
// last saved version, with no page refresh and no action on the open report at all — exactly the
// reported "Group similar entries, then AI Summary un-merges it again" symptom. The fix: read the
// report list through a ref (always current, but not reactive) and key the effect only on
// `selectedReportId`.
import fs from 'node:fs';

const workspace = fs.readFileSync('src/components/reporting/ReportDraftWorkspace.tsx', 'utf8').replace(/\r\n/g, '\n');

if (!workspace.includes('const reportsRef = useRef(reports);') || !workspace.includes('reportsRef.current = reports;')) {
  throw new Error('reportsRef mirror (declared once, updated every render) is missing.');
}

const effectStart = workspace.indexOf('useEffect(() => {\n    // A previously-pulled preview is scoped to whichever report was open');
if (effectStart < 0) throw new Error('Could not locate the report-switch effect by its lead comment.');
const effectEnd = workspace.indexOf('\n  const createDraft = async', effectStart);
const effectBody = workspace.slice(effectStart, effectEnd);

if (!effectBody.includes('reportsRef.current.find((item) => item.id === selectedReportId)')) {
  throw new Error('The report-switch effect must look up the open report via reportsRef.current, not the reactive `reports` prop.');
}
if (!/\}, \[selectedReportId\]\);/.test(effectBody)) {
  throw new Error('The report-switch effect must depend ONLY on [selectedReportId] — adding `reports` back in reintroduces the reset-on-unrelated-refetch bug.');
}
if (/\breports\b(?!Ref)/.test(effectBody.replace(/\/\/.*$/gm, ''))) {
  // Any bare `reports` reference left in the (non-comment) effect body, other than `reportsRef`,
  // means something is reading the reactive prop directly again inside this effect.
  throw new Error('The report-switch effect must not read the reactive `reports` prop directly anywhere in its body.');
}

console.log('OK: the report-switch effect depends only on selectedReportId and reads the open report through a non-reactive ref, so an unrelated global `reports` refetch elsewhere in the app can no longer silently reset the in-progress draft/grouping/undo state.');
