// Static source-text check for the 2026-11-07 bug fix: an Inhouse task (its client is Kesraa or
// Fast Growth) must never become invisible to its own creator/assignee just because their role
// has no access to the Inhouse tab at all. Concrete report: Hasnaa (social_media_agent) created
// an Inhouse task and assigned it to May (graphic_designer) — neither role has 'inhouse' in
// allowedModules (src/data/roles.ts), so the task vanished from both of them: excluded from the
// main Tasks tab's `externalTasks` by the pre-fix unconditional `!isInhouseTask(...)` filter, and
// unreachable via the Inhouse tab they can't open.
//
// Fix: externalTasks/activeTasksCount now only exclude an Inhouse task when the current viewer
// actually HAS the Inhouse tab to see it on instead (executive/head_of_technical/
// marketing_manager) — never for someone with no other place to find their own task. This is a
// pure frontend filtering change; task_visible_v2 (RLS) already granted the creator/assignee
// visibility unconditionally, so no migration or RLS change was needed.
import fs from 'node:fs';

const appSrc = fs.readFileSync('src/App.tsx', 'utf8').replace(/\r\n/g, '\n');

if (!appSrc.includes("const currentUserHasInhouseAccess = userRoleInfo.allowedModules.includes('inhouse');")) {
  throw new Error('currentUserHasInhouseAccess must be derived from userRoleInfo.allowedModules — the same check that gates the Inhouse nav tab itself.');
}

const externalTasksStart = appSrc.indexOf('const externalTasks = useMemo(');
if (externalTasksStart < 0) throw new Error('Could not locate externalTasks in App.tsx.');
const externalTasksEnd = appSrc.indexOf('\n  );', externalTasksStart);
const externalTasksBody = appSrc.slice(externalTasksStart, externalTasksEnd);
if (!externalTasksBody.includes('!isInhouseTask(t, clients) || !currentUserHasInhouseAccess')) {
  throw new Error('externalTasks must keep an Inhouse task visible to a viewer who lacks Inhouse tab access, not just exclude every Inhouse task unconditionally.');
}
if (externalTasksBody.includes('tasks.filter((t) => !isInhouseTask(t, clients))')) {
  throw new Error('externalTasks must not use the old unconditional "!isInhouseTask" filter — that was the exact bug (a creator/assignee with no Inhouse tab access could never see their own task anywhere).');
}

if (!appSrc.includes('(!isInhouseTask(t, clients) || !currentUserHasInhouseAccess)')) {
  throw new Error('activeTasksCount must use the same condition as externalTasks so the badge count and the actual visible list never disagree.');
}

console.log('OK: an Inhouse task stays visible in the main Tasks tab for a viewer whose role has no Inhouse tab access, and is excluded there only for a viewer who can see it on the dedicated Inhouse tab instead.');
