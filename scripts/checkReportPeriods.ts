import {
  isDateInReportPeriod,
  isReportWorkDate,
  resolveReportPeriod,
  resolveReportWorkWeek,
} from '../src/lib/reportPeriods';
import { dedupeReportSourceReferences } from '../src/lib/reportContracts';

const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(action: () => unknown, label: string): void {
  try {
    action();
    failures.push(`${label}: expected an exception`);
  } catch {
    // Expected.
  }
}

function main(): void {
  const week = resolveReportWorkWeek('2026-10-13');
  assertEqual(week, { startInclusive: '2026-10-10', endExclusive: '2026-10-17' }, 'Tuesday resolves to Saturday week');
  assertEqual(resolveReportWorkWeek('2026-10-10'), week, 'Saturday is the first day of its week');
  assertEqual(resolveReportWorkWeek('2026-10-16'), week, 'Friday keeps the same calendar week');
  assertEqual(isDateInReportPeriod('2026-10-10', week), true, 'Saturday included');
  assertEqual(isDateInReportPeriod('2026-10-15', week), true, 'Thursday included');
  assertEqual(isDateInReportPeriod('2026-10-16', week), false, 'Friday excluded');
  assertEqual(isDateInReportPeriod('2026-10-17', week), false, 'next Saturday excluded from prior week');

  assertEqual(
    resolveReportPeriod('2026-01-30', '2026-02-02'),
    { startInclusive: '2026-01-30', endExclusive: '2026-02-03' },
    'month boundary uses half-open end'
  );
  assertEqual(
    resolveReportPeriod('2026-12-31', '2026-12-31'),
    { startInclusive: '2026-12-31', endExclusive: '2027-01-01' },
    'year boundary'
  );
  assertEqual(
    resolveReportPeriod('2028-02-29', '2028-02-29'),
    { startInclusive: '2028-02-29', endExclusive: '2028-03-01' },
    'leap day'
  );
  assertEqual(isReportWorkDate('2026-10-16'), false, 'Friday work-date check');
  assertThrows(() => resolveReportPeriod('2025-02-29', '2025-03-01'), 'invalid non-leap date');
  assertThrows(() => resolveReportPeriod('2026-02-02', '2026-02-01'), 'reversed period');

  const prior = { startInclusive: '2025-12-27', endExclusive: '2026-01-03' };
  const next = { startInclusive: '2026-01-03', endExclusive: '2026-01-10' };
  assertEqual(isDateInReportPeriod('2026-01-03', prior), false, 'boundary absent from prior period');
  assertEqual(isDateInReportPeriod('2026-01-03', next), true, 'boundary belongs to next period');

  assertEqual(
    dedupeReportSourceReferences([
      { sourceKind: 'daily_log', sourceId: 'same-id' },
      { sourceKind: 'daily_log', sourceId: 'same-id' },
      { sourceKind: 'extra_note', sourceId: 'same-id' },
    ]),
    [
      { sourceKind: 'daily_log', sourceId: 'same-id' },
      { sourceKind: 'extra_note', sourceId: 'same-id' },
    ],
    'dedupe uses source kind and id'
  );

  if (failures.length) {
    console.error('Found report-period/contract regression(s):\n');
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
  }
  console.log('OK: report periods are UTC-safe, half-open, Friday-excluding, and source keys are stable.');
}

main();
