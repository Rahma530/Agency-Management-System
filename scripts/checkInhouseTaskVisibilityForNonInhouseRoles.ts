// Static source-text check for the 2026-11-07 bug fix: an Inhouse task (its client is Kesraa or
// Fast Growth) must never become invisible to its own creator/assignee just because their role
// has no access to the Inhouse tab at all. Concrete report: Hasnaa (social_media_agent) created
// an Inhouse task and assigned it to May (graphic_designer) — neither role has 'inhouse' in
// allowedModules (src/data/roles.ts), so the task vanished from both of them: excluded from the
// main Tasks tab's `externalTasks` by the unconditional `!isInhouseTask(...)` filter, and
// unreachable via the Inhouse tab they can't open.
//
// First attempt (rejected by the owner): leak the Inhouse task into the main Tasks tab instead.
// Correct fix (this check): the Inhouse tab itself opens for anyone who is the creator or an
// assignee of at least one Inhouse task (hasOwnInhouseWork) — dynamic, not a role/team check,
// since the motivating case (a Social Media Agent) isn't on any Creative/Video/Programming team.
// The main Tasks tab keeps unconditionally excluding every Inhouse task (externalTasks is back to
// its original form) — the task now lives only on the Inhouse tab, not duplicated into Tasks.
// A non-admin viewer who only has the tab via hasOwnInhouseWork gets the Task Board straight away,
// with no Tasks/Clients sub-view switch (that switch, and the Clients sub-view/InhouseClientsPanel
// itself, stay admin-only — out of scope per the owner's own wording, "their own tasks").
import fs from 'node:fs';

const appSrc = fs.readFileSync('src/App.tsx', 'utf8').replace(/\r\n/g, '\n');

// 1. externalTasks/activeTasksCount must be back to the original unconditional exclusion — no
//    leaking an Inhouse task into the main Tasks tab.
const externalTasksStart = appSrc.indexOf('const externalTasks = useMemo(');
if (externalTasksStart < 0) throw new Error('Could not locate externalTasks in App.tsx.');
const externalTasksEnd = appSrc.indexOf('\n  );', externalTasksStart);
const externalTasksBody = appSrc.slice(externalTasksStart, externalTasksEnd);
if (!externalTasksBody.includes('tasks.filter((t) => !isInhouseTask(t, clients))')) {
  throw new Error('externalTasks must unconditionally exclude every Inhouse task again — the Inhouse-tab fix (hasOwnInhouseWork) replaces leaking the task into the main Tasks tab, it does not coexist with it.');
}
if (externalTasksBody.includes('currentUserHasInhouseAccess')) {
  throw new Error('externalTasks must not reference the old, rejected currentUserHasInhouseAccess gating.');
}

const activeTasksCountLine = appSrc.slice(appSrc.indexOf('const activeTasksCount ='), appSrc.indexOf('const onboardingClientsCount ='));
if (!activeTasksCountLine.includes('tasks.filter((t) => !isTaskDone(t.status) && !isInhouseTask(t, clients))')) {
  throw new Error('activeTasksCount must match externalTasks’s unconditional Inhouse exclusion.');
}

// 2. hasOwnInhouseWork: dynamic creator-or-assignee check over inhouseTasks.
if (!appSrc.includes('const hasOwnInhouseWork = useMemo(')) {
  throw new Error('hasOwnInhouseWork must exist — the dynamic (data-driven) check for Inhouse tab access beyond the 3 admin roles.');
}
const hasOwnInhouseWorkStart = appSrc.indexOf('const hasOwnInhouseWork = useMemo(');
const hasOwnInhouseWorkBody = appSrc.slice(hasOwnInhouseWorkStart, appSrc.indexOf('\n  );', hasOwnInhouseWorkStart));
if (!hasOwnInhouseWorkBody.includes('inhouseTasks.some(')) {
  throw new Error('hasOwnInhouseWork must be derived from inhouseTasks (the same Inhouse-only task set the Inhouse tab itself renders), not the full unscoped tasks array.');
}
if (!hasOwnInhouseWorkBody.includes('t.created_by === currentUser.id') || !hasOwnInhouseWorkBody.includes('resolveTaskAssigneeIds(t.id, taskAssignees, t.assigned_to).includes(currentUser.id)')) {
  throw new Error('hasOwnInhouseWork must check both creator (created_by) and assignee (resolveTaskAssigneeIds) — the owner’s own example (Hasnaa created, May assigned) needs both sides covered.');
}
// Broadened 2026-11-07 (owner report: the tab vanished for Hasnaa/May/Fatima once their one
// qualifying task was no longer current, even though she'd also assigned all three to Kesraa/Fast
// Growth via InhouseClientsPanel's own per-service agent assignment) — a standing public.assignments
// row for an is_inhouse client must grant access on its own, independent of any task's current state.
if (!hasOwnInhouseWorkBody.includes('assignments.some(')) {
  throw new Error('hasOwnInhouseWork must also check public.assignments for a standing agent assignment to an is_inhouse client — a task creator/assignee check alone misses an agent the owner assigned via InhouseClientsPanel but who has no current qualifying task.');
}
if (!hasOwnInhouseWorkBody.includes('a.agent_id === currentUser.id') || !hasOwnInhouseWorkBody.includes('isInhouseClient(c)')) {
  throw new Error('hasOwnInhouseWork’s assignments check must match the signed-in user as agent_id, scoped to a client flagged is_inhouse (isInhouseClient) — not any assignment on any client.');
}

// 3. The nav tab link must open for hasOwnInhouseWork in addition to the 3 admin roles.
const navGateStart = appSrc.indexOf("{(userRoleInfo.allowedModules.includes('inhouse') || hasOwnInhouseWork) && (");
if (navGateStart < 0) {
  throw new Error('The Inhouse nav tab must render for userRoleInfo.allowedModules.includes(\'inhouse\') OR hasOwnInhouseWork, not the admin check alone.');
}

// 4. The Tasks/Clients sub-view switch, and the Clients sub-view itself, must stay admin-only —
//    a non-admin hasOwnInhouseWork viewer goes straight to the Task Board with no switch shown.
const inhouseTabStart = appSrc.indexOf("{activeTab === 'inhouse' && (");
if (inhouseTabStart < 0) throw new Error('Could not locate the Inhouse tab content block in App.tsx.');
const inhouseTabBody = appSrc.slice(inhouseTabStart, appSrc.indexOf('\n            )}\n\n            {/* Tab 4', inhouseTabStart));
if (!inhouseTabBody.includes("{userRoleInfo.allowedModules.includes('inhouse') && (\n                  <div className=\"flex items-center gap-2\">")) {
  throw new Error('The Tasks/Clients sub-view switch must be gated to userRoleInfo.allowedModules.includes(\'inhouse\') only — a hasOwnInhouseWork-only viewer should not see it.');
}
if (!inhouseTabBody.includes("!userRoleInfo.allowedModules.includes('inhouse') || inhouseView === 'tasks' ? (")) {
  throw new Error('A non-admin hasOwnInhouseWork viewer must render the Task Board directly (inhouseView defaults to \'tasks\' and they never see a switch to leave it), not the admin-only Clients sub-view.');
}

// 5. 2026-11-07 follow-up bug (owner report, screenshot): the nav link opened for Hasnaa, but
//    clicking it still hit the AccessDenied screen — isModuleAllowed() (data/roles.ts) is a pure
//    role-table lookup with no idea hasOwnInhouseWork exists, and 3 separate route/nav guards in
//    this file called it directly, independently of the sidebar link's own (already-fixed) gate:
//    the #/portal/:slug/:module hashchange handler, handleTabChange, and the top-level render-gate
//    that actually swaps in <AccessDenied>. All three must go through the canAccessModule wrapper
//    instead, or a user can see the tab and still be blocked from opening it.
if (!appSrc.includes("const canAccessModule = (role: UserRole, moduleId: AppModuleId): boolean =>\n    isModuleAllowed(role, moduleId) || (moduleId === 'inhouse' && hasOwnInhouseWork);")) {
  throw new Error('canAccessModule must exist as a thin wrapper that ORs hasOwnInhouseWork into isModuleAllowed() for the \'inhouse\' module only — isModuleAllowed() itself must stay a pure role lookup (it\'s reused for other employees\' eligibility elsewhere, e.g. reportAgentEligibility.ts).');
}
if (!appSrc.includes('if (!canAccessModule(authenticatedUser.role, requestedModule)) {')) {
  throw new Error('The #/portal/:slug/:module hashchange route guard must call canAccessModule, not isModuleAllowed directly — this is the exact path a direct Inhouse link/refresh goes through.');
}
if (!appSrc.includes('if (!canAccessModule(authenticatedUser.role, newTab)) {')) {
  throw new Error('handleTabChange (the sidebar click handler) must call canAccessModule, not isModuleAllowed directly.');
}
if (!appSrc.includes(') : !canAccessModule(currentUser.role, activeTab) ? (')) {
  throw new Error('The top-level render-gate that actually decides whether <AccessDenied> replaces the tab content must call canAccessModule, not isModuleAllowed directly — this was the exact screen in the owner’s bug report.');
}
// hasOwnInhouseWork must be declared before every one of these guards (not just before the nav
// link far below) — the hashchange effect's closure is only re-created when its dependency array
// changes, so hasOwnInhouseWork must also be a dependency or a just-loaded user stays blocked.
if (appSrc.indexOf('const hasOwnInhouseWork = useMemo(') > appSrc.indexOf('if (!canAccessModule(authenticatedUser.role, requestedModule)) {')) {
  throw new Error('hasOwnInhouseWork must be declared before the hashchange route guard that uses it (moved near userRoleInfo, not left by the Inhouse tab’s other memos further down).');
}
if (!appSrc.includes('}, [authenticatedUser?.id, hasOwnInhouseWork]);')) {
  throw new Error('The hashchange effect must list hasOwnInhouseWork in its dependency array — it can flip from false to true shortly after mount once tasks/taskAssignees load, and the \'hashchange\' listener would otherwise keep using a stale-false closure for a direct Inhouse link.');
}

console.log('OK: an Inhouse task’s own creator/assignee now gets the Inhouse tab itself (scoped to their own tasks, Task Board only, no admin Clients sub-view) instead of the task leaking into the main Tasks tab; the main Tasks tab keeps excluding every Inhouse task unconditionally for everyone; and every route/nav guard (hashchange, handleTabChange, the render-gate) agrees with the sidebar link, not just the link itself.');
