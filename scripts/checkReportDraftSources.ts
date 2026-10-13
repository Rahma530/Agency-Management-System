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

const clientContent = composeInitialReportContent('client', client.dailyLogs, [], [], 'Manual client note', new Map([['u1', 'One'], ['u2', 'Two']]), false);
if (!clientContent.includes('Manual client note') || clientContent.includes('Extra Note') || clientContent.includes('Task evidence')) {
  throw new Error('Client source presentation failed.');
}
const creativeContent = composeInitialReportContent('employee', employee.dailyLogs, employee.extraNotes, employee.tasks, '', new Map([['u1', 'One']]), true);
if (!creativeContent.includes('Design tasks evidenced by linked work logs: 1') || !creativeContent.includes('Video tasks evidenced by linked work logs: 1')) {
  throw new Error('Creative design/video counts are missing.');
}
if ((creativeContent.match(/Homepage banner design/g) || []).length !== 1) {
  throw new Error('Linked task was duplicated in the composed report.');
}

console.log('OK: report draft sources enforce scope, Friday exclusion, linked-task evidence, Creative counts, and stable dedupe.');
