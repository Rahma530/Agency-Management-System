import { TaskStatus, UserRecord } from '../types/database';
import { isTaskWorkloadOpen } from './employeeWork';
import { addReportDays } from './reportPeriods';
import { getCombinedDepartmentTeams } from './departmentStaffing';
import {
  CREATIVE_DEPARTMENT_KEYS,
  DAY_OFF_WEEKDAY,
  ESTIMATED_HOURS_PER_TASK,
  MAX_TASKS_PER_DAY,
  SUGGESTION_LOOKAHEAD_DAYS,
} from '../config/designerScheduling';

// ----------------------------------------------------------------------------
// Creative-department derivation — "applies to Creative departments generally," derived from the
// live departments config rather than a hardcoded team list (see
// src/config/designerScheduling.ts's own comment on CREATIVE_DEPARTMENT_KEYS).
// ----------------------------------------------------------------------------

// The live set of team values considered "Creative" right now — today
// {'Creative & Design', 'Video Production'}, expanded from CREATIVE_DEPARTMENT_KEYS via the same
// department config every other department-scoped picker in this app already reads.
export function getCreativeTeams(): string[] {
  const combined = getCombinedDepartmentTeams();
  const teams = new Set<string>();
  for (const key of CREATIVE_DEPARTMENT_KEYS) {
    (combined[key] || [key]).forEach((team) => teams.add(team));
  }
  return [...teams];
}

// Whether this user should get a scheduling suggestion when assigned. marketing_manager is
// excluded by ROLE explicitly (owner decision) even though their own team ('Marketing') never
// overlaps the Creative team list anyway — a defensive, future-proof exclusion independent of how
// departments get reconfigured later.
export function isCreativeAssignee(
  user: Pick<UserRecord, 'role' | 'team'>,
  creativeTeams: string[] = getCreativeTeams()
): boolean {
  if (user.role === 'marketing_manager') return false;
  return !!user.team && creativeTeams.includes(user.team);
}

// This user's effective daily task target (tasks/day) — backs the Daily Operations Module's
// "Delivered today: N / target" card. users.daily_task_target (set via CapacityManagement.tsx,
// executive/head_of_technical/team-lead-own-scope only — see
// 20261115000000_daily_task_target.sql) wins when set; empty falls back to MAX_TASKS_PER_DAY for
// a Creative-department employee (the same 6/day owner decision the scheduling suggester already
// uses), or no target at all (null) for everyone else.
export function resolveDailyTaskTarget(
  user: Pick<UserRecord, 'role' | 'team' | 'daily_task_target'>,
  creativeTeams: string[] = getCreativeTeams()
): number | null {
  if (user.daily_task_target !== undefined && user.daily_task_target !== null) return user.daily_task_target;
  return isCreativeAssignee(user, creativeTeams) ? MAX_TASKS_PER_DAY : null;
}

// ----------------------------------------------------------------------------
// Working-day arithmetic. Reuses reportPeriods.ts's UTC-safe addReportDays() for date math
// (existing business-day utility — see the Step 1 audit) rather than reimplementing it; the
// "which day is off" rule itself is this feature's OWN constant (DAY_OFF_WEEKDAY), not borrowed
// from reportPeriods.ts's own private Friday literal, so the two business rules can't accidentally
// drift into reading from two different numbers that happen to agree today.
// ----------------------------------------------------------------------------

function utcWeekday(dateStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isWorkingDay(dateStr: string): boolean {
  return utcWeekday(dateStr) !== DAY_OFF_WEEKDAY;
}

// ----------------------------------------------------------------------------
// Per-day load map — mirrors get_user_schedule_load()'s own counting rule exactly (see
// 20261112000000_in_review_not_workload.sql's comment): today AND every past day count ALL
// tasks due that day, whatever their status (never defaulting a 7th task into a day a 6th
// already quietly completed on); every future day counts only Workload-open tasks
// (isTaskWorkloadOpen: todo/in_progress/blocked) — in_review is delivered, not workload, so a
// future-dated in_review task never counts, while a revision (todo/in_progress after being
// delivered) still does, same as any other open task. archived_at is supported defensively even
// though public.tasks has no such column today (confirmed via the Step 1 audit) — see the
// migration's own matching comment for why this mirrors it rather than assuming the column will
// never exist.
//
// Production code normally never calls this directly: the live counts for an assignee the
// current viewer usually CANNOT see under RLS come from the get_user_schedule_load() RPC instead,
// already pre-aggregated server-side (see fetchUserScheduleLoad() in lib/taskOperations.ts). This
// exists so the exact same counting RULE is independently testable in-process (the cases this
// file's check script covers), and for the one case where the caller already has the raw task
// list in hand (e.g. the viewer's own visible tasks).
// ----------------------------------------------------------------------------

export interface ScheduleTaskLike {
  due_date: string | null;
  status: TaskStatus;
  archived_at?: string | null;
}

export function buildScheduleLoadByDate(tasks: ScheduleTaskLike[], todayStr: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    if (!task.due_date) continue;
    if (task.archived_at) continue;
    const isTodayOrPast = task.due_date <= todayStr;
    const countsTowardLoad = isTodayOrPast || isTaskWorkloadOpen(task.status);
    if (!countsTowardLoad) continue;
    counts[task.due_date] = (counts[task.due_date] || 0) + 1;
  }
  return counts;
}

// ----------------------------------------------------------------------------
// The suggestion itself.
// ----------------------------------------------------------------------------

export interface DueDateSuggestion {
  dueDate: string;
  estimatedHours: number;
  // The chosen day's load BEFORE this new task (or batch) — i.e. what get_user_schedule_load()/
  // buildScheduleLoadByDate() reported for that date.
  taskCountOnDate: number;
  // True once adding this task (or, for a multi-client create, all `taskCount` copies at once)
  // would reach the per-day cap (MAX_TASKS_PER_DAY) — a non-blocking, editable warning only;
  // never prevents using (or further editing) the suggested date.
  warning: boolean;
  // How many candidate days (full, or simply non-working) were passed over before landing on
  // dueDate — purely informational.
  daysSkipped: number;
}

// Walks forward one calendar day at a time from anchorDate (inclusive), skipping non-working days
// entirely (Friday today), until it finds a working day whose CURRENT load (before this task) is
// below MAX_TASKS_PER_DAY. Never auto-shifts an EXISTING due date itself — this only ever
// produces a suggestion; it is the caller's responsibility to decide whether/when to write it
// into a task's due_date (see the UI wiring in CrossTeamTaskBoard.tsx for exactly where that line
// is drawn).
//
// `taskCount` (default 1) is how many NEW tasks are being added to the suggested day at once —
// multi-client "create for N clients" (createTaskCopies in lib/taskOperations.ts) creates one
// task per client, all with the same due date, so a batch of N can push a day over the cap even
// though any single one of them wouldn't. This does NOT change which day gets picked (still the
// first day whose EXISTING load alone is under the cap — skipping ahead just because a big batch
// would overflow it would need to skip arbitrarily far for a large enough batch, which the owner
// did not ask for); it only changes `warning`, to account for the whole batch landing on that one
// day: `existingLoad + taskCount >= MAX_TASKS_PER_DAY`, per "warn, never block, when existing
// load + copies > 6."
//
// "Never blocks": if every working day within SUGGESTION_LOOKAHEAD_DAYS is already at or over
// capacity (a pathological case in practice), this does not throw or return nothing — it falls
// back to the last working day it considered, flagged with warning: true, so the caller always
// has *something* editable to show.
//
// `carriedOverCount` (default 0) is this assignee's overdue-open-task count from
// get_user_schedule_load() (see carried_over_count's own comment in
// supabase/migrations/20261111000000_user_schedule_load_carry_over.sql) — NOT folded into
// `loadByDate` by the caller; this function adds it in, exactly once, to the FIRST WORKING day it
// considers (byte-identical rule to the RPC's own "first working day in the window" placement —
// one source of truth for "which day absorbs the backlog"), then never again for any later
// candidate day. So with 2 carried-over + 4 tasks already due today, today reads as 6 (full) and
// the suggestion moves on to the next working day — exactly as if a 5th and 6th task were already
// booked today; with 2 carried-over + 0 due today, today reads as 2, still has room, and gets
// picked. This never shifts loadByDate or any stored date — the function is pure; it only changes
// what count gets compared against MAX_TASKS_PER_DAY for exactly one candidate day.
export function suggestDueDateAndHours(params: {
  anchorDate: string;
  loadByDate: Record<string, number>;
  taskCount?: number;
  carriedOverCount?: number;
}): DueDateSuggestion {
  const { anchorDate, loadByDate } = params;
  const taskCount = Math.max(1, params.taskCount ?? 1);
  const carriedOverCount = Math.max(0, params.carriedOverCount ?? 0);
  let candidate = anchorDate;
  let daysSkipped = 0;
  let lastWorkingCandidate = anchorDate;
  let lastWorkingCount = loadByDate[anchorDate] ?? 0;
  let carryOverApplied = false;

  for (let i = 0; i < SUGGESTION_LOOKAHEAD_DAYS; i++) {
    if (isWorkingDay(candidate)) {
      let count = loadByDate[candidate] ?? 0;
      if (!carryOverApplied) {
        count += carriedOverCount;
        carryOverApplied = true;
      }
      lastWorkingCandidate = candidate;
      lastWorkingCount = count;
      if (count < MAX_TASKS_PER_DAY) {
        return {
          dueDate: candidate,
          estimatedHours: ESTIMATED_HOURS_PER_TASK,
          taskCountOnDate: count,
          warning: count + taskCount >= MAX_TASKS_PER_DAY,
          daysSkipped,
        };
      }
      daysSkipped++;
    } else {
      daysSkipped++;
    }
    candidate = addReportDays(candidate, 1);
  }

  // Lookahead exhausted — never block; fall back to the last working day considered.
  return {
    dueDate: lastWorkingCandidate,
    estimatedHours: ESTIMATED_HOURS_PER_TASK,
    taskCountOnDate: lastWorkingCount,
    warning: true,
    daysSkipped,
  };
}

// ----------------------------------------------------------------------------
// Several creative assignees at once: "suggest per the most loaded one and say so" (owner
// decision) — compares each candidate's load specifically on anchorDate (today, in production
// use), picking whichever has the highest count there. Ties keep the first id encountered.
// ----------------------------------------------------------------------------
export function pickMostLoadedAssignee(
  loadByDateByUserId: Record<string, Record<string, number>>,
  anchorDate: string
): string | null {
  const ids = Object.keys(loadByDateByUserId);
  if (ids.length === 0) return null;
  return ids.reduce((mostLoadedId, id) => {
    const candidateCount = loadByDateByUserId[id][anchorDate] ?? 0;
    const currentCount = loadByDateByUserId[mostLoadedId][anchorDate] ?? 0;
    return candidateCount > currentCount ? id : mostLoadedId;
  }, ids[0]);
}
