// Regression check for src/lib/designerScheduling.ts — the designer-scheduling suggestion
// algorithm (6 tasks/day cap, Saturday-Thursday work week, today/past-vs-future counting rule).
// Run via `npm run lint` (chained after tsc --noEmit) or directly:
// `npx tsx scripts/checkDesignerScheduling.ts`.
import {
  buildScheduleLoadByDate,
  isCreativeAssignee,
  suggestDueDateAndHours,
} from '../src/lib/designerScheduling';
import { ESTIMATED_HOURS_PER_TASK, MAX_TASKS_PER_DAY } from '../src/config/designerScheduling';

const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Fixed reference dates (not computed from `new Date()`, so the suite never depends on when it
// runs): 2026-10-15 is a Thursday, 2026-10-16 a Friday, 2026-10-17 a Saturday, 2026-10-13 a
// Tuesday, 2026-10-14 a Wednesday — same calendar already used by scripts/checkReportPeriods.ts.
function main(): void {
  // ------------------------------------------------------------------------
  // suggestDueDateAndHours
  // ------------------------------------------------------------------------

  // Empty day — nothing booked yet, suggest it immediately, no warning.
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate: {} });
    assertEqual(result.dueDate, '2026-10-15', 'empty day: dueDate');
    assertEqual(result.taskCountOnDate, 0, 'empty day: taskCountOnDate');
    assertEqual(result.warning, false, 'empty day: warning');
    assertEqual(result.estimatedHours, ESTIMATED_HOURS_PER_TASK, 'empty day: estimatedHours');
  }

  // 5 tasks already on the day — still under the cap, picked, but this will be the 6th (the
  // cap), so it warns.
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate: { '2026-10-15': 5 } });
    assertEqual(result.dueDate, '2026-10-15', '5 tasks: dueDate');
    assertEqual(result.taskCountOnDate, 5, '5 tasks: taskCountOnDate');
    assertEqual(result.warning, true, '5 tasks: warning (would reach the cap)');
  }

  // Exactly 6 (the cap) — must be skipped entirely, not treated as "still has room."
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate: { '2026-10-15': MAX_TASKS_PER_DAY } });
    if (result.dueDate === '2026-10-15') failures.push('exactly 6: a day at the cap must never be the suggestion');
  }

  // 7th task goes to the next working day — isolated from the Friday case below by using a
  // Tuesday -> Wednesday pair (an ordinary weekday boundary, no skip needed).
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-13', loadByDate: { '2026-10-13': MAX_TASKS_PER_DAY } });
    assertEqual(result.dueDate, '2026-10-14', '7th task: moves to the very next working day');
    assertEqual(result.taskCountOnDate, 0, '7th task: next day starts empty');
  }

  // Exactly-6 day followed by a Friday — must skip BOTH the full Thursday and the Friday,
  // landing on Saturday.
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate: { '2026-10-15': MAX_TASKS_PER_DAY } });
    assertEqual(result.dueDate, '2026-10-17', 'exactly 6 then Friday: lands on the following Saturday');
    assertEqual(result.daysSkipped, 2, 'exactly 6 then Friday: skipped the full day and the Friday');
  }

  // Friday skipped — even an EMPTY Friday is never suggested; the work week excludes it outright.
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-16', loadByDate: {} });
    assertEqual(result.dueDate, '2026-10-17', 'Friday skipped: lands on Saturday even though Friday is empty');
    assertEqual(result.daysSkipped, 1, 'Friday skipped: exactly one day skipped');
  }

  // "Today full" — anchoring the search at today's date when today is already at the cap must
  // still move forward, same as any other day.
  {
    const todayStr = '2026-10-15';
    const result = suggestDueDateAndHours({ anchorDate: todayStr, loadByDate: { [todayStr]: MAX_TASKS_PER_DAY } });
    if (result.dueDate === todayStr) failures.push('today full: must not suggest a today that is already at the cap');
  }

  // Multi-client create accounts for the whole batch, not just one task — createTaskCopies
  // creates one task per selected client, all sharing this suggested due date. 4 existing tasks
  // + a batch of 2 (taskCount: 2) reaches 6, the cap, so it must warn even though 4 alone
  // wouldn't; the day itself is still picked (4 < 6 before the batch).
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate: { '2026-10-15': 4 }, taskCount: 2 });
    assertEqual(result.dueDate, '2026-10-15', 'multi-client batch: dueDate (day itself still picked)');
    assertEqual(result.warning, true, 'multi-client batch: warns once existing load + copies reaches the cap');
  }
  // The same existing load (4) with a single task (taskCount defaults to 1) must NOT warn —
  // isolates that the batch size, not just the existing load, is what changed the outcome above.
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate: { '2026-10-15': 4 } });
    assertEqual(result.warning, false, 'single task with the same existing load (4): no warning');
  }

  // Never blocks — every working day in the lookahead window is at/over the cap; still returns a
  // usable (if flagged) suggestion rather than throwing.
  {
    const loadByDate: Record<string, number> = {};
    let d = '2026-10-15';
    for (let i = 0; i < 90; i++) {
      loadByDate[d] = MAX_TASKS_PER_DAY + 3;
      const [y, m, day] = d.split('-').map(Number);
      d = new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
    }
    let threw = false;
    let result;
    try {
      result = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate });
    } catch {
      threw = true;
    }
    if (threw || !result) failures.push('never blocks: a fully-booked lookahead window must not throw');
    else assertEqual(result.warning, true, 'never blocks: the fallback suggestion is flagged');
  }

  // ------------------------------------------------------------------------
  // suggestDueDateAndHours — carriedOverCount (get_user_schedule_load()'s carried_over_count,
  // see supabase/migrations/20261111000000_user_schedule_load_carry_over.sql): added into the
  // FIRST working day's load exactly once, never folded into loadByDate by the caller, never
  // mutates anything — the function stays pure.
  // ------------------------------------------------------------------------

  // 0 carried (omitted) — must behave identically to a call with no carriedOverCount at all
  // (regression: this parameter must be purely additive, never change existing behavior when
  // absent/zero).
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate: { '2026-10-15': 4 } });
    assertEqual(result.dueDate, '2026-10-15', '0 carried: dueDate unchanged from the no-carry-over case');
    assertEqual(result.taskCountOnDate, 4, '0 carried: taskCountOnDate unchanged (no carry-over added)');
    assertEqual(result.warning, false, '0 carried: warning unchanged');
  }

  // 2 carried + an empty day — today still has room (2 < 6): picked, taskCountOnDate reflects the
  // carried-over 2 (so 4 slots remain), no warning.
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate: {}, carriedOverCount: 2 });
    assertEqual(result.dueDate, '2026-10-15', '2 carried + empty day: dueDate (still picked)');
    assertEqual(result.taskCountOnDate, 2, '2 carried + empty day: taskCountOnDate is the carried-over count alone');
    assertEqual(result.warning, false, '2 carried + empty day: no warning (4 slots remain)');
  }

  // 2 carried + 4 tasks already due today = 6 (full) — must move to the next working day, exactly
  // as if a 5th and 6th task were already booked today. Tuesday->Wednesday: an ordinary weekday
  // boundary, no Friday-skip involved.
  {
    const result = suggestDueDateAndHours({
      anchorDate: '2026-10-13',
      loadByDate: { '2026-10-13': 4 },
      carriedOverCount: 2,
    });
    assertEqual(result.dueDate, '2026-10-14', '2 carried + 4 today (6, full): moves to the next working day');
    assertEqual(result.taskCountOnDate, 0, '2 carried + 4 today (6, full): the next day starts empty (carry-over applied only once)');
  }

  // 6 carried alone, nothing else due today — already full on its own, moves to the next working
  // day the same as above.
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-13', loadByDate: {}, carriedOverCount: 6 });
    assertEqual(result.dueDate, '2026-10-14', '6 carried alone (full): moves to the next working day');
    assertEqual(result.taskCountOnDate, 0, '6 carried alone (full): the next day starts empty');
    assertEqual(result.daysSkipped, 1, '6 carried alone (full): exactly one day skipped');
  }

  // Carried-over on a Friday anchor — Friday is never a candidate at all (work week excludes it
  // outright, same as the Friday-skip case above), so the carry-over must land on the following
  // Saturday, not be silently dropped or applied to the (skipped) Friday.
  {
    const result = suggestDueDateAndHours({ anchorDate: '2026-10-16', loadByDate: {}, carriedOverCount: 2 });
    assertEqual(result.dueDate, '2026-10-17', 'carried on a Friday: lands on the following Saturday');
    assertEqual(result.taskCountOnDate, 2, 'carried on a Friday: the carry-over applies to Saturday, not Friday');
  }

  // Purity — carriedOverCount must never mutate the loadByDate object passed in, and repeated
  // calls with the same input must return the same result (no hidden state/side effects).
  {
    const loadByDate = { '2026-10-15': 4 };
    const snapshotBefore = JSON.stringify(loadByDate);
    const first = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate, carriedOverCount: 2 });
    const snapshotAfter = JSON.stringify(loadByDate);
    assertEqual(snapshotAfter, snapshotBefore, 'purity: loadByDate must not be mutated by carriedOverCount');
    const second = suggestDueDateAndHours({ anchorDate: '2026-10-15', loadByDate, carriedOverCount: 2 });
    assertEqual(second, first, 'purity: repeated calls with the same input return the same result');
  }

  // ------------------------------------------------------------------------
  // buildScheduleLoadByDate — the today/past-vs-future counting rule.
  // ------------------------------------------------------------------------

  // Past day counts done tasks — a completed task due in the past must still count (so a 7th
  // task is never defaulted onto a day that already quietly finished its 6th).
  {
    const counts = buildScheduleLoadByDate(
      [
        { due_date: '2026-10-10', status: 'completed' },
        { due_date: '2026-10-10', status: 'todo' },
      ],
      '2026-10-15'
    );
    assertEqual(counts['2026-10-10'], 2, 'past day counts done tasks: both rows counted');
  }

  // Today itself counts ALL tasks (same rule as a past day, not a future one).
  {
    const counts = buildScheduleLoadByDate(
      [{ due_date: '2026-10-15', status: 'closed' }],
      '2026-10-15'
    );
    assertEqual(counts['2026-10-15'], 1, 'today counts done tasks same as a past day');
  }

  // Future day counts only still-open tasks — a completed/closed task due in the future must NOT
  // count; only the open one does.
  {
    const counts = buildScheduleLoadByDate(
      [
        { due_date: '2026-10-20', status: 'completed' },
        { due_date: '2026-10-20', status: 'closed' },
        { due_date: '2026-10-20', status: 'todo' },
      ],
      '2026-10-15'
    );
    assertEqual(counts['2026-10-20'], 1, 'future day counts only the open task');
  }

  // Archived excluded — even though public.tasks has no archived_at column today, the counting
  // rule must still honor one defensively if a caller ever supplies it.
  {
    const counts = buildScheduleLoadByDate(
      [{ due_date: '2026-10-10', status: 'todo', archived_at: '2026-10-11T00:00:00Z' }],
      '2026-10-15'
    );
    assertEqual(counts['2026-10-10'], undefined, 'archived excluded: an archived task never counts');
  }

  // ------------------------------------------------------------------------
  // isCreativeAssignee — marketing_manager excluded even on an (otherwise matching) Creative team.
  // ------------------------------------------------------------------------
  const creativeTeams = ['Creative & Design', 'Video Production'];
  assertEqual(isCreativeAssignee({ role: 'graphic_designer', team: 'Creative & Design' }, creativeTeams), true, 'graphic_designer on Creative & Design is a creative assignee');
  assertEqual(isCreativeAssignee({ role: 'video_editor', team: 'Video Production' }, creativeTeams), true, 'video_editor on Video Production is a creative assignee');
  assertEqual(isCreativeAssignee({ role: 'marketing_manager', team: 'Creative & Design' }, creativeTeams), false, 'marketing_manager is excluded by role, even on a matching team');
  assertEqual(isCreativeAssignee({ role: 'seo_agent', team: 'SEO' }, creativeTeams), false, 'an unrelated department is not a creative assignee');

  if (failures.length) {
    console.error('Found designer-scheduling regression(s):\n');
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
  }
  console.log('OK: designer scheduling suggests within the 6/day, Saturday-Thursday work week, never blocks, and excludes marketing_manager/archived tasks.');
}

main();
