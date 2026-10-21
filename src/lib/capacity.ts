import { UserRecord, ClientRecord, TaskRecord, TaskAssigneeRecord, AssignmentRecord, UserRole } from '../types/database';
import { isPausedClient } from './clientStatus';
import { resolveTaskAssigneeIds } from './taskLifecycle';
import { isTaskWorkloadOpen, countDeliveredToday, toCairoDateStr } from './employeeWork';
import { resolveDailyTaskTarget } from './designerScheduling';
import { MAX_TASKS_PER_DAY } from '../config/designerScheduling';

// Team leads don't carry a tracked capacity buffer the way agents do — a
// capacity_limit of 0 is a normal, intentional value for these 4 roles
// (not missing data), so every place that resolves or validates a limit
// treats them differently from agents.
export const TEAM_LEAD_ROLES: UserRole[] = [
  'am_team_lead',
  'media_buying_team_lead',
  'seo_team_lead',
  'social_media_team_lead',
];

export const isTeamLeadRole = (role?: UserRole) => !!role && TEAM_LEAD_ROLES.includes(role);

// The capacity model's one magic number, named and kept in this one place — anyone who reads a
// capacity limit calls resolveCapacityLimit() rather than writing their own `|| 12` fallback.
export const DEFAULT_CAPACITY_LIMIT = 12;

export const resolveCapacityLimit = (u: UserRecord) =>
  isTeamLeadRole(u.role) ? (u.capacity_limit ?? 0) : (u.capacity_limit || DEFAULT_CAPACITY_LIMIT);

// The 3 designer-scheduling creative roles — byte-identical in INTENT to
// get_user_schedule_load()'s own target-eligibility gate (20261110000000_user_schedule_load.sql)
// and to get_capacity_snapshot()'s creative branch (20261119000000_capacity_snapshot_v2.sql), NOT
// isCreativeAssignee()'s broader team-membership definition. Typed as string[], not UserRole[]:
// the real, live role value for this app's UI/UX design employees is 'ui_designer' — confirmed
// against production — which doesn't exist in the UserRole union ('ui_ux_designer' does, and is
// kept here too rather than removed, since scripts/checkInReviewNotWorkload.ts still asserts
// resolveDailyWorkCapacityLimit('ui_ux_designer') resolves to the 6/day default and that script is
// explicitly out of scope to touch here). 'ui_ux_designer' itself is a separate, pre-existing bug
// in ~15 other files, each one out of scope for this fix.
const DAILY_WORK_CREATIVE_ROLES: string[] = ['graphic_designer', 'video_editor', 'ui_ux_designer', 'ui_designer'];

export const isCreativeCapacityRole = (role: UserRole): boolean => DAILY_WORK_CREATIVE_ROLES.includes(role);

// DailyOperationsModule's "Capacity: N tasks" card only (owner decision) — everywhere else that
// reads a capacity LIMIT keeps resolveCapacityLimit()'s own default (DEFAULT_CAPACITY_LIMIT)
// unchanged. Mirrors resolveCapacityLimit()'s own shape exactly, just with MAX_TASKS_PER_DAY (6,
// src/config/designerScheduling.ts — the same cap the suggestion algorithm itself enforces) as the
// fallback for the creative roles instead, so an explicitly admin-set capacity_limit still wins
// over either default.
export const resolveDailyWorkCapacityLimit = (u: UserRecord): number =>
  isCreativeCapacityRole(u.role) ? (u.capacity_limit || MAX_TASKS_PER_DAY) : resolveCapacityLimit(u);

// 'target_reached' exists so a creative role's own daily delivery target can be surfaced
// (get_capacity_snapshot's own creative branch; see the header above) without ever reusing
// 'over_capacity' — hitting a delivery target is the point of the day's work, not a problem, and
// the two statuses get very different treatment everywhere this is rendered (never a red/alarming
// color for 'target_reached').
export type CapacityStatus = 'available' | 'near_capacity' | 'over_capacity' | 'target_reached';

export interface UserCapacityData {
  user: UserRecord;
  assignedClients: ClientRecord[];
  activeTasks: TaskRecord[];
  usedCapacity: number;
  capacityLimit: number;
  isUntracked: boolean;
  remainingCapacity: number;
  utilizationRate: number;
  status: CapacityStatus;
}

// Mirrors get_capacity_snapshot v2's own "else" branch (20261119000000_capacity_snapshot_v2.sql)
// exactly: distinct ACTIVE (not closed/paused) clients reachable via the UNION of
// clients.am_agent_id, public.assignments.agent_id -> client_id, or a workload-open
// (todo/in_progress/blocked) task this user currently has, via task_assignees — falling back to
// the legacy tasks.assigned_to only when a task has zero task_assignees rows at all
// (resolveTaskAssigneeIds already implements that exact precedence). Shared by both the 4
// team-lead roles (informational only — see getUserCapacityData) and every other non-creative
// role (where it's measured against a real limit).
const resolveActiveClientIds = (
  userId: string,
  clients: ClientRecord[],
  tasks: TaskRecord[],
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[],
  assignments: Pick<AssignmentRecord, 'client_id' | 'agent_id'>[]
): Set<string> => {
  const activeClientIds = new Set(
    clients.filter((c) => c.status !== 'closed' && !isPausedClient(c)).map((c) => c.id)
  );
  const result = new Set<string>();

  clients.forEach((c) => {
    if (activeClientIds.has(c.id) && c.am_agent_id === userId) result.add(c.id);
  });
  assignments.forEach((a) => {
    if (activeClientIds.has(a.client_id) && a.agent_id === userId) result.add(a.client_id);
  });
  tasks.forEach((t) => {
    if (!activeClientIds.has(t.client_id) || !isTaskWorkloadOpen(t.status)) return;
    if (resolveTaskAssigneeIds(t.id, taskAssignees, t.assigned_to).includes(userId)) {
      result.add(t.client_id);
    }
  });

  return result;
};

// The single source of truth for "how loaded is this person", shared by every capacity-aware view
// (CapacityManagement, CrossTeamTaskBoard, AMQueue, ServiceBriefsRoutingView). Three distinct
// measures, mirroring get_capacity_snapshot v2 exactly (see that migration's own header for the
// full reasoning behind each):
//   - The 3 creative roles: usedCapacity = today's delivered task count (Africa/Cairo),
//     capacityLimit = resolveDailyTaskTarget()'s own default — never 'over_capacity' (the
//     'target_reached' status covers reaching/exceeding the target instead).
//   - The 4 team-lead roles: usedCapacity = resolveActiveClientIds().size, for INFORMATION ONLY —
//     capacity_limit is never read at all (not even to check if it's 0), isUntracked is always
//     true, and status is always 'available' (never 'near_capacity'/'over_capacity').
//   - Every other role: usedCapacity = resolveActiveClientIds().size, measured against
//     resolveCapacityLimit()'s real limit (DEFAULT_CAPACITY_LIMIT when unset).
export function getUserCapacityData(
  user: UserRecord,
  clients: ClientRecord[],
  tasks: TaskRecord[] = [],
  taskAssignees: Pick<TaskAssigneeRecord, 'task_id' | 'user_id'>[] = [],
  assignments: Pick<AssignmentRecord, 'client_id' | 'agent_id'>[] = []
): UserCapacityData {
  const workloadOpenTasks = tasks.filter(
    (t) => isTaskWorkloadOpen(t.status) && resolveTaskAssigneeIds(t.id, taskAssignees, t.assigned_to).includes(user.id)
  );

  if (isCreativeCapacityRole(user.role)) {
    const usedCapacity = countDeliveredToday(user.id, tasks, taskAssignees, toCairoDateStr(new Date().toISOString()));
    const target = resolveDailyTaskTarget(user);
    const capacityLimit = target ?? 0;
    const isUntracked = target === null;
    const remainingCapacity = Math.max(0, capacityLimit - usedCapacity);
    const utilizationRate = capacityLimit > 0 ? Math.round((usedCapacity / capacityLimit) * 100) : 0;

    let status: CapacityStatus = 'available';
    if (!isUntracked && usedCapacity >= capacityLimit) {
      status = 'target_reached';
    } else if (!isUntracked && utilizationRate >= 75) {
      status = 'near_capacity';
    }

    return {
      user,
      assignedClients: [],
      activeTasks: workloadOpenTasks,
      usedCapacity,
      capacityLimit,
      isUntracked,
      remainingCapacity,
      utilizationRate,
      status,
    };
  }

  const activeClientIds = resolveActiveClientIds(user.id, clients, tasks, taskAssignees, assignments);
  const assignedClients = clients.filter((c) => activeClientIds.has(c.id));
  const usedCapacity = activeClientIds.size;

  if (isTeamLeadRole(user.role)) {
    // Informational only, by explicit decision: capacity_limit is never consulted here, not even
    // to check if it happens to be 0 — a team lead's own number is never a limit to be measured
    // against, so there is no utilization rate and no over_capacity status, ever.
    return {
      user,
      assignedClients,
      activeTasks: workloadOpenTasks,
      usedCapacity,
      capacityLimit: 0,
      isUntracked: true,
      remainingCapacity: 0,
      utilizationRate: 0,
      status: 'available',
    };
  }

  const capacityLimit = resolveCapacityLimit(user);
  // A real 0 is still possible if an admin explicitly sets it — nothing to compute a rate
  // against, same reasoning the team-lead branch above states for its own always-untracked case.
  const isUntracked = capacityLimit === 0;
  const remainingCapacity = Math.max(0, capacityLimit - usedCapacity);
  const utilizationRate = capacityLimit > 0 ? Math.round((usedCapacity / capacityLimit) * 100) : 0;

  let status: CapacityStatus = 'available';
  if (!isUntracked && utilizationRate >= 100) {
    status = 'over_capacity';
  } else if (!isUntracked && utilizationRate >= 75) {
    status = 'near_capacity';
  }

  return {
    user,
    assignedClients,
    activeTasks: workloadOpenTasks,
    usedCapacity,
    capacityLimit,
    isUntracked,
    remainingCapacity,
    utilizationRate,
    status,
  };
}

// Shared with canTrustCapacityFor's callers below — the same neutral glyph already used for a
// team lead's own untracked (capacity_limit = 0) status, reused for "this count can't be trusted
// for this viewer" so there's one unknown-capacity glyph, not two.
export const CAPACITY_UNKNOWN_INDICATOR = '⚪ N/A';

// Compact glyph + label shared by every <select> option and status chip that
// shows live workload next to a name — Task Board, AM Queue, Service Briefs
// routing all render this same string.
export function getCapacityIndicator(data: UserCapacityData): string {
  if (data.isUntracked) return CAPACITY_UNKNOWN_INDICATOR;
  if (data.status === 'target_reached') return '🎯 Target Reached';
  if (data.status === 'over_capacity') return '🔴 Over Capacity';
  if (data.status === 'near_capacity') return '🟡 Near Capacity';
  return '🟢 Available';
}

// Whether `viewer`'s own already-loaded `tasks` array is complete enough for a capacity count
// computed over it (via getUserCapacityData) to be trusted for `candidate`. After the task
// visibility cutover (PR 2 of the task-assignees project), an ordinary viewer's `tasks` array
// only contains tasks they created or are assigned to — it is no longer a department-wide or
// org-wide set, so filtering it for an arbitrary OTHER person's tasks silently undercounts
// (near-always reads as "Available") rather than erroring. This mirrors task_visible_v2's own
// team-lead door exactly (own-team match, plus the seo_team_lead/Programming carve-out) so a
// badge is only ever shown when the viewer's task data for that specific candidate is actually
// as complete as task_visible_v2 would make it — never guessed.
export const canTrustCapacityFor = (
  viewer: UserRecord | null | undefined,
  candidate: UserRecord
): boolean => {
  if (!viewer) return false;
  if (viewer.id === candidate.id) return true;
  if (viewer.role === 'executive' || viewer.role === 'head_of_technical') {
    return true;
  }
  if (isTeamLeadRole(viewer.role)) {
    if (viewer.team && candidate.team === viewer.team) return true;
    if (viewer.role === 'seo_team_lead' && candidate.team === 'Programming') return true;
  }
  if (viewer.role === 'marketing_manager' && (candidate.role === 'graphic_designer' || candidate.role === 'video_editor')) {
    return true;
  }
  return false;
};
