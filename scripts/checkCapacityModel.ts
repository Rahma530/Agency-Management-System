// Regression check for getUserCapacityData() (src/lib/capacity.ts) — the client-side mirror of
// get_capacity_snapshot v2 (supabase/migrations/20261119000000_capacity_snapshot_v2.sql). Covers
// the five things most likely to silently drift between the two: the creative roles' own
// delivered-today measure (never 'over_capacity', 'target_reached' instead), in_review not
// counting as workload, a client reachable via two different sources still counting once, a
// team-lead role with capacity_limit = 0 (or any other value — ignored either way) always being
// informational only, and the non-creative/non-TL default limit being 12, not 8.
//
// Run via `npm run lint` (chained after tsc --noEmit) or directly:
// `npx tsx scripts/checkCapacityModel.ts`.
import { getUserCapacityData, resolveCapacityLimit, DEFAULT_CAPACITY_LIMIT } from '../src/lib/capacity';
import { UserRecord, ClientRecord, TaskRecord, TaskAssigneeRecord, AssignmentRecord } from '../src/types/database';

const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function makeUser(overrides: Partial<UserRecord>): UserRecord {
  return {
    id: 'u1',
    name: 'Test User',
    email: 'test@example.com',
    role: 'am_agent',
    team: 'Account Management',
    auth_id: 'auth-1',
    deactivated_at: null,
    capacity_limit: null,
    daily_task_target: null,
    ...overrides,
  } as UserRecord;
}

const client = (id: string, status: string, amAgentId: string | null = null): Pick<ClientRecord, 'id' | 'status' | 'am_agent_id'> => ({
  id,
  status: status as ClientRecord['status'],
  am_agent_id: amAgentId,
});

const task = (
  id: string,
  clientId: string,
  status: string,
  assignedTo: string | null = null,
  deliveredAt: string | null = null
): Pick<TaskRecord, 'id' | 'client_id' | 'status' | 'assigned_to' | 'delivered_at'> => ({
  id,
  client_id: clientId,
  status: status as TaskRecord['status'],
  assigned_to: assignedTo,
  delivered_at: deliveredAt,
});

const assignee = (taskId: string, userId: string): Pick<TaskAssigneeRecord, 'task_id' | 'user_id'> => ({ task_id: taskId, user_id: userId });

const assignment = (clientId: string, agentId: string): Pick<AssignmentRecord, 'client_id' | 'agent_id'> => ({ client_id: clientId, agent_id: agentId });

function main(): void {
  // ------------------------------------------------------------------
  // Scenario 1: creative roles are measured by today's delivered count, not by any client/task
  // membership — and never reach 'over_capacity' (reaching/exceeding the target is
  // 'target_reached' instead).
  // ------------------------------------------------------------------
  {
    const designer = makeUser({ id: 'designer', role: 'graphic_designer', team: 'Creative & Design', capacity_limit: null });
    const todayIso = new Date().toISOString();
    const tasks = [task('t1', 'c1', 'in_review', 'designer', todayIso)] as TaskRecord[];
    const taskAssignees = [assignee('t1', 'designer')] as TaskAssigneeRecord[];
    const data = getUserCapacityData(designer, [] as ClientRecord[], tasks, taskAssignees, [] as AssignmentRecord[]);
    assertEqual(data.usedCapacity, 1, 'creative: a task delivered today counts');
    assertEqual(data.assignedClients.length, 0, 'creative: never measured by clients');
    assertEqual(data.status !== 'over_capacity', true, 'creative: never over_capacity');

    // 6 deliveries today against the MAX_TASKS_PER_DAY (6) default target — must read
    // 'target_reached', never 'over_capacity', even though used === limit.
    const busyTasks = Array.from({ length: 6 }, (_, i) => task(`bt${i}`, 'c1', 'in_review', 'designer', todayIso)) as TaskRecord[];
    const busyAssignees = busyTasks.map((t) => assignee(t.id, 'designer')) as TaskAssigneeRecord[];
    const busyData = getUserCapacityData(designer, [] as ClientRecord[], busyTasks, busyAssignees, [] as AssignmentRecord[]);
    assertEqual(busyData.usedCapacity, 6, 'creative: 6 deliveries today all count');
    assertEqual(busyData.status, 'target_reached', 'creative: used === target reads target_reached, not over_capacity');
  }

  // ------------------------------------------------------------------
  // Scenario 2: in_review is not workload. A non-creative, non-TL role's own client, reachable
  // ONLY via a task, must not count while that task is in_review — only once it reaches a
  // workload-open status (todo/in_progress/blocked).
  // ------------------------------------------------------------------
  {
    const agent = makeUser({ id: 'agent', role: 'am_agent', capacity_limit: 5 });
    const clients = [client('c2', 'active')] as ClientRecord[];
    const taskAssignees = [assignee('t2', 'agent')] as TaskAssigneeRecord[];

    const inReview = getUserCapacityData(agent, clients, [task('t2', 'c2', 'in_review', 'agent')] as TaskRecord[], taskAssignees, [] as AssignmentRecord[]);
    assertEqual(inReview.usedCapacity, 0, 'in_review: the only task being in_review must not count the client');

    const inProgress = getUserCapacityData(agent, clients, [task('t2', 'c2', 'in_progress', 'agent')] as TaskRecord[], taskAssignees, [] as AssignmentRecord[]);
    assertEqual(inProgress.usedCapacity, 1, 'in_progress (workload-open): the same client now counts');
  }

  // ------------------------------------------------------------------
  // Scenario 3: the same client reachable via TWO sources (am_agent_id AND a workload-open
  // task_assignees task) counts exactly once — distinct, not summed.
  // ------------------------------------------------------------------
  {
    const agent = makeUser({ id: 'agent2', role: 'am_agent', capacity_limit: 5 });
    const clients = [client('c3', 'active', 'agent2')] as ClientRecord[];
    const tasks = [task('t3', 'c3', 'todo', 'agent2')] as TaskRecord[];
    const taskAssignees = [assignee('t3', 'agent2')] as TaskAssigneeRecord[];
    const data = getUserCapacityData(agent, clients, tasks, taskAssignees, [] as AssignmentRecord[]);
    assertEqual(data.usedCapacity, 1, 'the same client via am_agent_id + a workload-open task counts once');
  }

  // Also cover the third UNION source on its own: a client reachable ONLY via public.assignments
  // (no am_agent_id, no task at all) still counts, and the SAME client also reachable via
  // am_agent_id still counts once — mirrors scenario 7a/7b of
  // supabase/verification/20261119000000_capacity_snapshot_v2_tests.sql.
  {
    const seoAgent = makeUser({ id: 'seo1', role: 'seo_agent', capacity_limit: 5 });
    const clients = [client('c4', 'active')] as ClientRecord[];
    const assignments = [assignment('c4', 'seo1')] as AssignmentRecord[];
    const viaAssignmentOnly = getUserCapacityData(seoAgent, clients, [] as TaskRecord[], [] as TaskAssigneeRecord[], assignments);
    assertEqual(viaAssignmentOnly.usedCapacity, 1, 'a client reachable only via public.assignments counts');

    const clientsWithAmAgent = [client('c4', 'active', 'seo1')] as ClientRecord[];
    const viaBoth = getUserCapacityData(seoAgent, clientsWithAmAgent, [] as TaskRecord[], [] as TaskAssigneeRecord[], assignments);
    assertEqual(viaBoth.usedCapacity, 1, 'the same client via assignments + am_agent_id still counts once');
  }

  // ------------------------------------------------------------------
  // Scenario 4: a team-lead role is informational only — capacity_limit is ignored even when
  // explicitly set to a real, non-zero value, and status is always 'available' however high
  // usedCapacity is.
  // ------------------------------------------------------------------
  {
    const lead = makeUser({ id: 'lead1', role: 'am_team_lead', capacity_limit: 0 });
    const clients = Array.from({ length: 20 }, (_, i) => client(`c${i}`, 'active', 'lead1')) as ClientRecord[];
    const data = getUserCapacityData(lead, clients, [] as TaskRecord[], [] as TaskAssigneeRecord[], [] as AssignmentRecord[]);
    assertEqual(data.usedCapacity, 20, 'team lead: the real client count is still reported');
    assertEqual(data.isUntracked, true, 'team lead: always untracked, regardless of capacity_limit');
    assertEqual(data.status, 'available', 'team lead: 20 clients still reads available, never over_capacity');
    assertEqual(data.capacityLimit, 0, 'team lead: capacityLimit is reported as 0 (no limit), not a real number');

    // Even an explicitly admin-set, non-zero capacity_limit must still be ignored for a team lead.
    const leadWithLimit = makeUser({ id: 'lead2', role: 'seo_team_lead', capacity_limit: 5 });
    const dataWithLimit = getUserCapacityData(leadWithLimit, clients.map((c) => ({ ...c, am_agent_id: 'lead2' })), [] as TaskRecord[], [] as TaskAssigneeRecord[], [] as AssignmentRecord[]);
    assertEqual(dataWithLimit.isUntracked, true, 'team lead: still untracked even with an explicit non-zero capacity_limit');
    assertEqual(dataWithLimit.status, 'available', 'team lead: still available even with an explicit non-zero capacity_limit and 20 clients');
  }

  // ------------------------------------------------------------------
  // Scenario 5: the default capacity limit for a non-creative, non-TL role with no explicit
  // capacity_limit is 12 (DEFAULT_CAPACITY_LIMIT), not the old 8.
  // ------------------------------------------------------------------
  {
    assertEqual(DEFAULT_CAPACITY_LIMIT, 12, 'DEFAULT_CAPACITY_LIMIT is 12');
    const agent = makeUser({ id: 'agent3', role: 'seo_agent', capacity_limit: null });
    assertEqual(resolveCapacityLimit(agent), 12, 'resolveCapacityLimit falls back to 12 when capacity_limit is unset');
    const data = getUserCapacityData(agent, [] as ClientRecord[], [] as TaskRecord[], [] as TaskAssigneeRecord[], [] as AssignmentRecord[]);
    assertEqual(data.capacityLimit, 12, 'getUserCapacityData reports the same 12 default');

    // An explicitly admin-set capacity_limit still wins over the default.
    const agentWithLimit = makeUser({ id: 'agent4', role: 'seo_agent', capacity_limit: 20 });
    assertEqual(resolveCapacityLimit(agentWithLimit), 20, 'an explicit capacity_limit still wins over the 12 default');
  }

  if (failures.length) {
    console.error('Found capacity model regression(s):\n');
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
  }
  console.log('OK: capacity model mirrors get_capacity_snapshot v2 — creative delivered-today, in_review excluded, cross-source dedupe, team-lead informational-only, and the 12 default.');
}

main();
