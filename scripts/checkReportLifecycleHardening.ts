import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20261107300000_report_workspace_lifecycle_hardening.sql', 'utf8');
const lockdown = fs.readFileSync('supabase/migrations/20261107400000_report_workspace_direct_write_lockdown.sql', 'utf8');
const workspace = fs.readFileSync('src/components/reporting/ReportDraftWorkspace.tsx', 'utf8');
const reportsHub = fs.readFileSync('src/components/ReportsHub.tsx', 'utf8');
const comparisonDisplay = fs.readFileSync('src/components/reporting/ComparisonDisplay.tsx', 'utf8');
const app = fs.readFileSync('src/App.tsx', 'utf8');
const router = fs.readFileSync('supabase/functions/ai-router/index.ts', 'utf8');
const portal = fs.readFileSync('src/components/clientPortal/ClientPortalView.tsx', 'utf8');
const legacyView = fs.readFileSync('src/components/reporting/MonthlyReportDraftView.tsx', 'utf8');
const config = fs.readFileSync('supabase/config.toml', 'utf8');
const transactionTests = fs.readFileSync('supabase/verification/20261107300001_report_workspace_lifecycle_transaction_tests.sql', 'utf8');
const required = [
  'create_report_draft_v2', 'preview_report_sources_v2', 'employee_scope_mode',
  "status='final'", 'Final or archived reports are immutable', 'delete_report_permanently',
  'report_deletion_tombstones', 'Archive the report before permanent deletion', 'content_hash',
  'save_report_version_v2', 'archive_report_v2', 'approve_report_v2',
  "type='client' and status='final' and archived_at is null", 'for update',
];
for (const fragment of required) {
  if (!migration.includes(fragment)) throw new Error(`Lifecycle migration is missing: ${fragment}`);
}
for (const fragment of [
  'revoke update (status,approved_by,approved_at,comparison_id,period,client_id,type,updated_at)',
  "revoke insert (%s) on table public.%I from public, anon, authenticated",
]) {
  if (!lockdown.includes(fragment)) throw new Error(`Direct-write lockdown is missing: ${fragment}`);
}
if (!migration.includes("p_employee_scope_mode='selected_clients' and cardinality(v_ids)=0")) {
  throw new Error('Selected Clients can be empty on the server.');
}
if (!migration.includes('not public.report_scope_accessible(id, null)')) {
  throw new Error('Selected client ids are not server-authorized.');
}
if (/report_scope_accessible\([^,()]+\)/.test(migration)) {
  throw new Error('A report_scope_accessible call is missing its agent-id argument.');
}
if (!migration.includes("'legacy-'||md5(concat_ws")) {
  throw new Error('Legacy report creation is not idempotent.');
}
if (!reportsHub.includes('-- Select an agent --') || !workspace.includes('Select All') || !workspace.includes('Clear All')
  || !workspace.includes('confirmDiscard') || !workspace.includes('creationKey.current ||= crypto.randomUUID()')) {
  throw new Error('Top-bar employee selection, workspace multi-select, unsaved guard, or duplicate-submit protection is missing.');
}
if (app.includes("from('reports').insert") || app.includes("from('reports').update")) {
  throw new Error('A direct legacy reports write bypass remains in App.tsx.');
}
if (!router.includes("from('report_source_items')") || !router.includes('are always discarded below')) {
  throw new Error('REPORT_REWRITE is not grounded from saved server-side source items.');
}
if (!workspace.includes("rpc('save_report_version_v2'") || !workspace.includes("rpc('archive_report_v2'")
  || !workspace.includes("rpc('approve_report_v2'") || !workspace.includes('draftText !== currentVersion.content_text')) {
  throw new Error('Workspace does not enforce concurrency RPCs or saved-version-only actions.');
}
// Unified single-page Reports tab (no Create/Workspace/Saved/Archived/Activity tabs, no "Setup"
// heading, no second scope/period picker anymore) — checks the functional sections/top-bar
// controls exist instead of the old tab/section labels.
for (const label of ['Reports (', 'All My Clients (', 'Specific Client', 'Pull sources']) {
  if (!reportsHub.includes(label) && !workspace.includes(label)) throw new Error(`Reports UI section is missing: ${label}`);
}
if (reportsHub.includes('>Setup<') || workspace.includes('Versioned Report Workspace')) {
  throw new Error('A removed section heading ("Setup" / "Versioned Report Workspace") is still present.');
}
// Comparison merged into the top bar (point 1): the old separate "Comparison" section title and
// its own two "Comparison Report"/"Period Report" mode buttons are gone, replaced by a single
// "مقارنة" toggle in the top bar's scope row, with its results (Calculate/Save-as-report/the
// saved list) now living right under the draft instead of under their own section.
if (/<span>Comparison<\/span>/.test(reportsHub) || reportsHub.includes('>Comparison Report<') || reportsHub.includes('>Period Report<')) {
  throw new Error('The old separate "Comparison" section/title or its two mode buttons are still present.');
}
if (!reportsHub.includes('مقارنة') || !reportsHub.includes('Calculate comparison') || !reportsHub.includes('Save selected as report')) {
  throw new Error('The مقارنة toggle, or the comparison results (Calculate/Save as report) now expected under the draft, is missing.');
}
// Point 3: both "التقرير"/"سجل النشاط" tabs stay mounted (CSS display only) rather than
// unmounting, so a tab switch can't drop an unsaved draft or this page's own search/filter state.
if (!reportsHub.includes('سجل النشاط')
  || !reportsHub.includes("activeTab === 'activity' ? undefined : { display: 'none' }")
  || !reportsHub.includes("activeTab === 'report' ? undefined : { display: 'none' }")) {
  throw new Error('The Activity tab is missing, or a tab is unmounted instead of CSS-hidden.');
}
// Point 4: Weekly/Monthly/Quarterly/Yearly + Custom-range shortcuts, reusing
// reportingEngine.ts's resolveComparisonPeriods (same logic PeriodSelector.tsx already uses).
for (const label of ['أسبوعي', 'شهري', 'ربع سنوي', 'سنوي', 'فترة مخصصة']) {
  if (!reportsHub.includes(label)) throw new Error(`Period shortcut button is missing: ${label}`);
}
if (!reportsHub.includes('applyPeriodShortcut') || !reportsHub.includes('resolveComparisonPeriods')) {
  throw new Error("Period shortcuts are not wired to reportingEngine.ts's resolveComparisonPeriods.");
}
if (/\n\s+canGenerateReport(?:\s|=)/.test(reportsHub)
  || (reportsHub.match(/onGenerateAiSummary=\{onGenerateAiSummary\}/g) || []).length > 1) {
  throw new Error('Comparison cards still duplicate report or AI generation actions.');
}
if (!comparisonDisplay.includes("archiveMode?: 'active' | 'archived' | 'all'")
  || !comparisonDisplay.includes("r.archived_at ? 'Open / Restore' : 'Open'")) {
  throw new Error('Saved and archived report lists are not separated or actionable.');
}
if (!workspace.includes("rpc('delete_report_permanently'")
  || !workspace.includes('Original tasks, activity logs, campaigns, and client data are not deleted')
  || !workspace.includes('but the report cannot be restored')) {
  throw new Error('Permanent-delete UI does not use the lifecycle RPC or explain its destructive scope.');
}
if (!portal.includes(".eq('status', 'final').is('archived_at', null)")) throw new Error('Portal query is not final-and-active only.');
if (!legacyView.includes('intentionally not re-derived') || legacyView.includes('computeClientTaskCompletionStats')) {
  throw new Error('Legacy reports can still change from live Task/Brief data.');
}
if (!config.includes('[functions.ai-router]') || !config.includes('verify_jwt = true')) throw new Error('ai-router JWT verification is not enabled.');
for (const behavior of ['stale preview hash', 'idempotent retry', 'final report was editable', 'ordinary agent deleted', 'content_hash']) {
  if (!transactionTests.includes(behavior)) throw new Error(`Rollback behavior verification is missing: ${behavior}`);
}
console.log('OK: lifecycle migration contains explicit scopes, final immutability, archive/delete separation, tombstones, locking, and portal filtering.');
