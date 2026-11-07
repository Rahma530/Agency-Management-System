// Static source-text checks (same style as checkReportCoreServicesScope.ts) for the "Creative
// Brief auto-display in Tasks" feature requested 2026-11-07: "ال BRIEF الخاص بال UI و ال CREATIVE
// عموما أيا كان ال Client لازم يظهر في كل Task هيترفع ليهم" — whenever a creative assignee is
// selected (New/Edit Task) or already assigned (Task Details), that client's brief for the
// assignee's own specialty must show, read-only. The owner's confirmed design: resolve the ONE
// brief to show from the assignee's ROLE ("هنحدد من role الموظف لو graphic يظهر ليه الخاص بيه لو
// UI يظهر الخاص بيه و هكذا"), shown in BOTH the create/edit modal and the Task Details view
// ("في الاتنين (موصى بيه)"). None of this is exported as a hook-testable unit, so this checks the
// actual component source for the specific patterns the feature depends on.
import fs from 'node:fs';

const board = fs.readFileSync('src/components/CrossTeamTaskBoard.tsx', 'utf8').replace(/\r\n/g, '\n');

// 1) The role -> brief service_type map exists and covers exactly the roles the owner named
// (graphic, UI) under both of this codebase's real UI-designer role spellings (ui_ux_designer is
// the UserRole union member; ui_designer is the real, live production value per capacity.ts's own
// comment on DAILY_WORK_CREATIVE_ROLES) — and deliberately does NOT map video_editor, since no
// ServiceType exists for video work.
const mapStart = board.indexOf('const CREATIVE_ROLE_TO_BRIEF_SERVICE: Record<string, ServiceType> = {');
if (mapStart < 0) {
  throw new Error('CREATIVE_ROLE_TO_BRIEF_SERVICE map is missing — the brief-display feature needs its own role -> service_type map, separate from workLogServiceClassification.ts\'s ROLE_TO_SERVICE (which deliberately pools graphic_designer/video_editor into a shared bucket for a different purpose).');
}
const mapEnd = board.indexOf('};', mapStart);
const mapBody = board.slice(mapStart, mapEnd);
if (!mapBody.includes("graphic_designer: 'graphic_design'")) {
  throw new Error("CREATIVE_ROLE_TO_BRIEF_SERVICE must map graphic_designer -> 'graphic_design'.");
}
if (!mapBody.includes("ui_ux_designer: 'interface'") || !mapBody.includes("ui_designer: 'interface'")) {
  throw new Error("CREATIVE_ROLE_TO_BRIEF_SERVICE must map both ui_ux_designer and ui_designer -> 'interface'.");
}
if (mapBody.includes('video_editor:')) {
  throw new Error('video_editor must NOT be mapped to a ServiceType — no brief category exists for video work; this was a deliberate owner-facing gap, not an oversight.');
}

// 2) The shared resolver dedupes by service_type (one card per distinct creative specialty among
// the selected/assigned people, never one per person) and returns null (not a skipped entry) for
// a role that resolves to a real service_type but has no brief filed yet, so the gap stays visible.
if (!board.includes('function resolveCreativeBriefsForAssignees(')) {
  throw new Error('resolveCreativeBriefsForAssignees is missing.');
}
const resolverStart = board.indexOf('function resolveCreativeBriefsForAssignees(');
const resolverEnd = board.indexOf('\n}', board.indexOf('return results;', resolverStart));
const resolverBody = board.slice(resolverStart, resolverEnd);
if (!resolverBody.includes('seen.has(serviceType)')) {
  throw new Error('resolveCreativeBriefsForAssignees must dedupe by serviceType — two assignees sharing a role must show one brief card, not two identical ones.');
}
if (!resolverBody.includes('briefs.find((b) => b.client_id === clientId && b.service_type === serviceType) || null')) {
  throw new Error('resolveCreativeBriefsForAssignees must resolve a brief by (clientId, serviceType) and fall back to null (shown as "not submitted yet"), never silently dropping the entry.');
}

// 3) The read-only preview component is rendered at all three confirmed locations: the New Task
// form, the Edit Task form, and the Task Details view.
if (!board.includes('const TaskCreativeBriefPreview: React.FC')) {
  throw new Error('TaskCreativeBriefPreview component is missing.');
}
const renderSites = board.split('<TaskCreativeBriefPreview').length - 1;
if (renderSites < 3) {
  throw new Error(`<TaskCreativeBriefPreview> must be rendered at all 3 confirmed locations (New Task form, Edit Task form, Task Details view) — found ${renderSites}.`);
}

// 4) CrossTeamTaskBoardProps declares the two new props as required (not optional) — a render site
// missing either would type-check fine in this project (no @types/react installed) and only fail
// at runtime, same reasoning as checkTaskTypeManagerProps.ts's own required-prop list, which this
// feature's two props were added to.
if (!board.includes('briefs: BriefRecord[];') || !board.includes('briefFieldSchemas: Record<ServiceType, BriefFieldDef[]>;')) {
  throw new Error('CrossTeamTaskBoardProps must declare briefs/briefFieldSchemas as required props.');
}

console.log('OK: Creative Brief auto-display resolves one brief per distinct creative specialty by assignee role (graphic_designer/ui_ux_designer/ui_designer; video_editor intentionally unmapped), and renders in the New Task form, Edit Task form, and Task Details view.');
