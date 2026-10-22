import {
  collectClientReportSources,
  collectEmployeeReportSources,
  composeInitialReportContent,
} from '../src/lib/reportDraftSources';
import { DailyLogRecord, ExtraNoteRecord, TaskAssigneeRecord, TaskRecord } from '../src/types/database';

const period = { startInclusive: '2026-10-10', endExclusive: '2026-10-17' };
const dailyLogs: DailyLogRecord[] = [
  { id: 'a', user_id: 'u1', client_id: 'c1', date: '2026-10-10', summary_text: 'Saturday design work', linked_task_ids: ['design', 'video', 'design'] },
  { id: 'a', user_id: 'u1', client_id: 'c1', date: '2026-10-10', summary_text: 'duplicate', linked_task_ids: ['design'] },
  { id: 'b', user_id: 'u2', client_id: 'c1', date: '2026-10-15', summary_text: 'Thursday work', linked_task_ids: ['other-user-task'] },
  { id: 'c', user_id: 'u1', client_id: 'c1', date: '2026-10-16', summary_text: 'Friday excluded', linked_task_ids: ['friday-task'] },
  { id: 'd', user_id: 'u1', client_id: 'c2', date: '2026-10-12', summary_text: 'Other client', linked_task_ids: ['video'] },
];
const extraNotes: ExtraNoteRecord[] = [
  { id: 'a', user_id: 'u1', date: '2026-10-12', note_text: 'Employee note', category: null },
  { id: 'n2', user_id: 'u2', date: '2026-10-12', note_text: 'Other employee', category: null },
];
const task = (overrides: Partial<TaskRecord>): TaskRecord => ({
  id: 'task',
  client_id: 'c1',
  title: 'Task',
  description: '',
  assigned_to: 'u1',
  created_by: 'lead',
  team: 'Creative & Design',
  status: 'in_progress',
  due_date: '2026-10-15',
  priority: 'medium',
  ...overrides,
});
const tasks: TaskRecord[] = [
  task({ id: 'design', title: 'Homepage banner design', task_type_other: 'Graphic design', status: 'completed', completed_at: '2026-10-14T10:00:00Z' }),
  task({ id: 'video', title: 'Product reel', description: 'Video montage', team: 'Video Production', assigned_to: null }),
  task({ id: 'assigned-only', title: 'Assigned poster', description: 'Graphic design' }),
  task({ id: 'other-user-task', title: 'Other employee poster', description: 'Graphic design', assigned_to: 'u2' }),
  task({ id: 'friday-task', title: 'Friday video', description: 'Video edit' }),
];
const taskAssignees: TaskAssigneeRecord[] = [
  { task_id: 'design', user_id: 'u1' },
  { task_id: 'assigned-only', user_id: 'u1' },
  { task_id: 'video', user_id: 'u2' },
];

const client = collectClientReportSources(dailyLogs, 'c1', period);
if (client.dailyLogs.map((row) => row.id).join(',') !== 'a,b') throw new Error('Client source scope/dedupe failed.');

const employee = collectEmployeeReportSources(dailyLogs, extraNotes, tasks, taskAssignees, 'u1', period);
if (employee.dailyLogs.map((row) => row.id).join(',') !== 'a,d') throw new Error('Employee work source scope failed.');
if (employee.extraNotes.map((row) => row.id).join(',') !== 'a') throw new Error('Employee note source scope failed.');
if (employee.tasks.map((row) => row.task.id).join(',') !== 'design,video') {
  throw new Error('Task evidence scope failed: assigned-only, other-user, or Friday task leaked in.');
}
if (employee.tasks[0].workKind !== 'design' || employee.tasks[1].workKind !== 'video') {
  throw new Error('Creative task classification failed.');
}
if (!employee.tasks[0].completionInPeriod || employee.tasks[1].completionInPeriod) {
  throw new Error('Task completion evidence was overstated or missed.');
}
if (!employee.tasks[0].subjectIsCurrentAssignee || employee.tasks[1].subjectIsCurrentAssignee) {
  throw new Error('Task assignment context is wrong.');
}

const selectedClient = collectEmployeeReportSources(
  dailyLogs, extraNotes, tasks, taskAssignees, 'u1', period,
  { mode: 'selected_clients', clientIds: ['c1'] }
);
if (selectedClient.dailyLogs.map((row) => row.id).join(',') !== 'a' || selectedClient.extraNotes.length !== 0
  || selectedClient.tasks.map((row) => row.task.id).join(',') !== 'design,video') {
  throw new Error('Selected-client employee scope leaked another client or non-client notes.');
}
const allAuthorizedClients = collectEmployeeReportSources(
  dailyLogs, extraNotes, tasks, taskAssignees, 'u1', period,
  { mode: 'all_clients', clientIds: ['c2'] }
);
if (allAuthorizedClients.dailyLogs.map((row) => row.id).join(',') !== 'd' || allAuthorizedClients.extraNotes.length !== 0
  || allAuthorizedClients.tasks.map((row) => row.task.id).join(',') !== 'video') {
  throw new Error('All-clients employee scope did not honor the authorized client list.');
}

const clientContent = composeInitialReportContent('client', client.dailyLogs, [], [], 'Manual client note', new Map([['u1', 'One'], ['u2', 'Two']]), false);
if (!clientContent.includes('Manual client note') || clientContent.includes('Extra Note') || clientContent.includes('Task evidence')) {
  throw new Error('Client source presentation failed.');
}
const creativeContent = composeInitialReportContent('employee', employee.dailyLogs, employee.extraNotes, employee.tasks, '', new Map([['u1', 'One']]), true);
if (!creativeContent.includes('Design tasks evidenced by linked work logs: 1') || !creativeContent.includes('Video tasks evidenced by linked work logs: 1')) {
  throw new Error('Creative design/video counts are missing.');
}
// Newly composed reports no longer include a "Task evidence ledger" section at all (removed by
// request — its purpose wasn't landing for the report's audience). The underlying dedupe
// invariant this used to also exercise (a task linked twice in one log's linked_task_ids must
// still only be evidenced once) is already covered above by the employee.tasks assertion.
if (creativeContent.includes('Task evidence ledger') || creativeContent.includes('Homepage banner design')) {
  throw new Error('Task evidence ledger must no longer be composed into new reports.');
}

// Work log lines must read as plain text, never prefixed with the log's own date OR the
// employee's name — the date stays on the stored row (daily_logs.date /
// report_source_items.source_date), it just no longer appears inside the composed narrative text.
// Client-scope reports can span several employees at once, but the "Employee: " name prefix was
// dropped there too per request: it cluttered every pulled draft and had to be deleted by hand.
if (!clientContent.includes('Saturday design work') || clientContent.includes('One: Saturday design work') || clientContent.includes('2026-10-10 —')) {
  throw new Error('Client-scope work log lines must read as plain text, with no date prefix and no employee-name prefix.');
}

// Employee-scope reports cover a single subject already named in the report header, so the
// per-line "Employee: " prefix was already dropped there before client-scope's own prefix was
// dropped too — this just confirms that earlier behavior is unchanged.
if (!creativeContent.includes('Saturday design work') || creativeContent.includes('One: Saturday design work')) {
  throw new Error('Employee-scope work log lines must not repeat the subject\'s name on every line.');
}

console.log('OK: report draft sources enforce scope, Friday exclusion, linked-task evidence, Creative counts, and stable dedupe.');
