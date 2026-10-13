import { collectClientReportSources, collectEmployeeReportSources, composeInitialReportContent } from '../src/lib/reportDraftSources';

const period = { startInclusive: '2026-10-10', endExclusive: '2026-10-17' };
const dailyLogs = [
  { id: 'a', user_id: 'u1', client_id: 'c1', date: '2026-10-10', summary_text: 'Saturday work' },
  { id: 'a', user_id: 'u1', client_id: 'c1', date: '2026-10-10', summary_text: 'duplicate' },
  { id: 'b', user_id: 'u2', client_id: 'c1', date: '2026-10-15', summary_text: 'Thursday work' },
  { id: 'c', user_id: 'u1', client_id: 'c1', date: '2026-10-16', summary_text: 'Friday excluded' },
  { id: 'd', user_id: 'u1', client_id: 'c2', date: '2026-10-12', summary_text: 'Other client' },
];
const extraNotes = [
  { id: 'a', user_id: 'u1', date: '2026-10-12', note_text: 'Employee note', category: null },
  { id: 'n2', user_id: 'u2', date: '2026-10-12', note_text: 'Other employee', category: null },
];

const client = collectClientReportSources(dailyLogs, 'c1', period);
if (client.dailyLogs.map((row) => row.id).join(',') !== 'a,b') throw new Error('Client source scope/dedupe failed.');

const employee = collectEmployeeReportSources(dailyLogs, extraNotes, 'u1', period);
if (employee.dailyLogs.map((row) => row.id).join(',') !== 'a,d') throw new Error('Employee work source scope failed.');
if (employee.extraNotes.map((row) => row.id).join(',') !== 'a') throw new Error('Employee note source scope failed.');

const content = composeInitialReportContent('client', client.dailyLogs, [], 'Manual client note', new Map([['u1', 'One'], ['u2', 'Two']]));
if (!content.includes('Manual client note') || content.includes('Extra Note')) throw new Error('Client note presentation failed.');

console.log('OK: report draft sources enforce exact client/employee scope, Friday exclusion, and stable dedupe.');
