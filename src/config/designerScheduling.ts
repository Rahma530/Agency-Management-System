// Single source of truth for every constant the designer-scheduling suggestion feature depends
// on (owner decisions). Nothing here reads live data — see src/lib/designerScheduling.ts for the
// pure scheduling algorithm, which imports these rather than hardcoding any of them itself, and
// src/lib/departmentStaffing.ts's getCombinedDepartmentTeams() for the live department -> team
// expansion CREATIVE_DEPARTMENT_KEYS below feeds into.

// 6 tasks fill one working day (owner decision). Never auto-shifts an existing due date, never
// blocks a save — see suggestDueDateAndHours()'s own comment.
export const MAX_TASKS_PER_DAY = 6;

// 1 working day = 8h.
export const WORK_HOURS_PER_DAY = 8;

// 8h / 6 tasks = 1.3333...h (80 minutes) per task — fixed, not dependent on how loaded the
// suggested day already is.
//
// Deliberately a ROUNDED LITERAL (1.33), not `WORK_HOURS_PER_DAY / MAX_TASKS_PER_DAY` computed at
// runtime: 8/6 is a repeating decimal (1.3333333333333333... in IEEE754 double precision), which
// would both show an ugly long value in the Estimated Hours input and risk two separately-computed
// occurrences disagreeing in their last few digits. tasks.estimated_hours is a plain, unconstrained
// `numeric` column (confirmed in canonical_schema_v4.sql: `estimated_hours numeric` — no precision/
// scale limit), so it COULD store the full repeating value if asked to; this rounds to the nearest
// 0.01h (≈0.6 minutes, negligible) purely for a clean, human-readable number, not because the
// column requires it. If that rounding is ever revisited, keep it to a value `step="0.01"` on the
// Estimated Hours <input> (see CrossTeamTaskBoard.tsx) can represent exactly.
export const ESTIMATED_HOURS_PER_TASK = 1.33;

// Work week is Saturday - Thursday; Friday is off. Date.prototype.getUTCDay(): 0=Sunday,
// 1=Monday, ..., 5=Friday, 6=Saturday.
export const DAY_OFF_WEEKDAY = 5;

// How far forward the suggester will look for an open working day before giving up and falling
// back to the nearest working day anyway, flagged with a warning (never blocks). A day this far
// out being solidly booked for every single day is vanishingly unlikely in practice; this bound
// only exists so the search loop is provably finite.
export const SUGGESTION_LOOKAHEAD_DAYS = 60;

// Anchor into the LIVE departments config (src/lib/departmentStaffing.ts's
// getCombinedDepartmentTeams(), backed by the department_member_teams table) — deliberately NOT
// a hardcoded team-name list. Each key here is looked up in that live config to get its actual
// team(s); today that resolves to {'Creative & Design': ['Creative & Design', 'Video
// Production']}, covering graphic_designer/video_editor/ui_ux_designer, but this file never
// hardcodes that expansion itself — a future department rename or split in the admin screen is
// picked up automatically by isCreativeAssignee()/getCreativeTeams() in
// src/lib/designerScheduling.ts. marketing_manager is excluded there by ROLE, not by team (their
// own team, 'Marketing', never overlaps this list anyway, but the owner wants it explicit and
// defensive regardless of how departments are reconfigured later).
export const CREATIVE_DEPARTMENT_KEYS: string[] = ['Creative & Design'];
