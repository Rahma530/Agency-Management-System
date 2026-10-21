// Static source-text checks (same style as checkReportAiSummaryFreshSources.ts) for the fix where
// "AI Summary" and "Group similar entries" used to silently undo each other: AI Summary always
// rebuilt one work item per raw log row (losing any earlier merge), and Group similar entries
// always re-read each log's raw original text (losing any earlier AI rephrase). Both actions now
// read and update a shared activeWorkLogGroups state instead, so running one after the other
// carries the other's result forward rather than discarding it.
import fs from 'node:fs';

const workspace = fs.readFileSync('src/components/reporting/ReportDraftWorkspace.tsx', 'utf8').replace(/\r\n/g, '\n');

// activeWorkLogGroups must exist as its own state, separate from draftText/previewManifest, and
// must be reset whenever those are reset for a report/scope switch — otherwise a merge/rephrase
// from one report or scope could leak into another.
if (!workspace.includes('const [activeWorkLogGroups, setActiveWorkLogGroups] = useState<WorkItemGroup[] | undefined>(undefined);')) {
  throw new Error('activeWorkLogGroups state is missing.');
}

// workItemsFromOriginalSources must accept the active grouping and build one work item PER GROUP
// (not one per raw log row) when a grouping is active, so AI Summary rephrases merged lines as a
// single item instead of exploding them back into their original individual lines.
const helperStart = workspace.indexOf('const workItemsFromOriginalSources = async (');
const helperEnd = workspace.indexOf('\n  const buildPreview', helperStart);
const helperBody = workspace.slice(helperStart, helperEnd);
if (helperStart < 0 || helperEnd < 0
  || !helperBody.includes('groups?: WorkItemGroup[]')
  || !helperBody.includes('const effectiveGroups: WorkItemGroup[] = groups && groups.length')
  || !helperBody.includes('return { items, groups: effectiveGroups };')) {
  throw new Error('workItemsFromOriginalSources no longer groups by the active WorkItemGroup[] before building AI Summary work items.');
}

// requestAiSummary must pass the currently active grouping into workItemsFromOriginalSources, and
// must carry the AI's rephrased wording back onto that SAME grouping (not drop it) afterward.
const aiStart = workspace.indexOf('const requestAiSummary = async () =>');
const aiEnd = workspace.indexOf('\n  // "Group similar entries"', aiStart);
const aiBody = workspace.slice(aiStart, aiEnd);
if (aiStart < 0 || aiEnd < 0
  || !aiBody.includes('workItemsFromOriginalSources(manifest.sources, activeWorkLogGroups)')
  || !aiBody.includes('const nextGroups = effectiveGroups.map((group) => ({ ids: group.ids, text: rephrasedById.get(group.ids[0]) ?? group.text }));')
  || !aiBody.includes('setDraftTextWithUndo(result.text, nextGroups);')) {
  throw new Error('AI Summary no longer preserves the active grouping (or its own rephrase) across the request.');
}

// groupSimilarEntries must read each log's CURRENTLY active text (an AI Summary's rephrase, if one
// is still active for that exact, unmerged log) instead of always its raw original wording — this
// is what lets grouping run after AI Summary without reverting every line.
const groupStart = workspace.indexOf('const groupSimilarEntries = async () =>');
const groupEnd = workspace.indexOf('\n  const applySuggestion', groupStart);
const groupBody = workspace.slice(groupStart, groupEnd);
if (groupStart < 0 || groupEnd < 0
  || !groupBody.includes('const activeTextById = new Map<string, string>();')
  || !groupBody.includes("text: activeTextById.get(source.source_id) ?? String(source.snapshot.summary_text || '').trim(),")
  || !groupBody.includes('setDraftTextWithUndo(composeManifestContent(manifest, creatorNote, names, creativeSubject, attachmentLinksByTask, result.result.groups, workLogServiceGrouping, effectiveScopeType === \'employee\'), result.result.groups);')) {
  throw new Error('Group similar entries no longer groups from the currently active (possibly AI-rephrased) text.');
}

// The one-step Undo must restore BOTH the text and the grouping/rephrase state that was active
// right before the last AI Summary / Group similar entries / Clear AI text action — otherwise an
// Undo could leave activeWorkLogGroups out of sync with the text it just restored.
if (!workspace.includes('const [undoSnapshot, setUndoSnapshot] = useState<{ text: string; groups: WorkItemGroup[] | undefined } | null>(null);')
  || !workspace.includes('setUndoSnapshot({ text: draftText, groups: activeWorkLogGroups });')
  || !workspace.includes('setActiveWorkLogGroups(undoSnapshot.groups);')) {
  throw new Error('Undo no longer restores the active grouping/rephrase state alongside the draft text.');
}

console.log('OK: AI Summary and Group similar entries now carry each other\'s result forward (merge survives a rephrase, rephrase survives a later merge) instead of silently undoing one another, and Undo restores both together.');
