import { UserRecord, ClientRecord, TaskRecord, UserRole } from '../types/database';
import { isPausedClient } from './clientStatus';

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

export const resolveCapacityLimit = (u: UserRecord) =>
  isTeamLeadRole(u.role) ? (u.capacity_limit ?? 0) : (u.capacity_limit || 8);

export type CapacityStatus = 'available' | 'near_capacity' | 'over_capacity';

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

// The single source of truth for "how loaded is this person", shared by every
// capacity-aware view (CapacityManagement, CrossTeamTaskBoard, AMQueue,
// ServiceBriefsRoutingView) — AM roles are measured by active assigned client
// count, every other role by active task count.
export function getUserCapacityData(
  user: UserRecord,
  clients: ClientRecord[],
  tasks: TaskRecord[] = []
): UserCapacityData {
  // Decision (Module 13): paused clients don't count toward an agent's capacity/workload —
  // they're intentionally on hold, same reasoning as their exclusion from "needs attention".
  const assignedClients = clients.filter(
    (c) => c.am_agent_id === user.id && c.status !== 'closed' && !isPausedClient(c)
  );
  const activeTasks = tasks.filter((t) => t.assigned_to === user.id && t.status !== 'completed');

  const isAm = user.role === 'am_agent' || user.role === 'am_team_lead';
  const usedCapacity = isAm ? assignedClients.length : activeTasks.length;
  const capacityLimit = resolveCapacityLimit(user);
  // Team leads may genuinely have a limit of 0 (no tracked buffer) — that's
  // not an error, just nothing to compute a rate against.
  const isUntracked = capacityLimit === 0;
  const remainingCapacity = Math.max(0, capacityLimit - usedCapacity);
  const utilizationRate = capacityLimit > 0 ? Math.round((usedCapacity / capacityLimit) * 100) : 0;

  // Available: < 75% | Near Capacity: 75%-99% | Over Capacity: >= 100%
  let status: CapacityStatus = 'available';
  if (!isUntracked && utilizationRate >= 100) {
    status = 'over_capacity';
  } else if (!isUntracked && utilizationRate >= 75) {
    status = 'near_capacity';
  }

  return {
    user,
    assignedClients,
    activeTasks,
    usedCapacity,
    capacityLimit,
    isUntracked,
    remainingCapacity,
    utilizationRate,
    status,
  };
}

// Compact glyph + label shared by every <select> option and status chip that
// shows live workload next to a name — Task Board, AM Queue, Service Briefs
// routing all render this same string.
export function getCapacityIndicator(data: UserCapacityData): string {
  if (data.isUntracked) return '⚪ N/A';
  if (data.status === 'over_capacity') return '🔴 Over Capacity';
  if (data.status === 'near_capacity') return '🟡 Near Capacity';
  return '🟢 Available';
}
