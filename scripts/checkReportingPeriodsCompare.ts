import { resolveComparisonPeriods } from '../src/lib/reportingEngine';
import { formatPeriodLabel } from '../src/components/reporting/ComparisonDisplay';

// Weekly granularity (changed 2026-11-07 per direct owner feedback): a rolling, backward-looking
// 7-day window that always ENDS on the reference date — never a fixed Saturday-Friday calendar
// week (the old version could run from today 6 days INTO THE FUTURE whenever today happened to be
// the week's start day, which is exactly the behavior the owner reported as wrong).
{
  // 2026-10-18 is a Sunday.
  const { current, previous } = resolveComparisonPeriods('weekly', new Date(2026, 9, 18));
  if (current.range.start !== '2026-10-12' || current.range.end !== '2026-10-18') {
    throw new Error(`Weekly current range should be the 7 days ending on the reference date, got ${current.range.start}..${current.range.end}`);
  }
  if (previous.range.start !== '2026-10-05' || previous.range.end !== '2026-10-11') {
    throw new Error(`Weekly previous range should be the 7 days immediately before current, got ${previous.range.start}..${previous.range.end}`);
  }
  if (current.label !== '2026-10-12_2026-10-18') throw new Error(`Weekly label shape is wrong: ${current.label}`);
}

// A reference date that is itself the old fixed week's Saturday-start day must NOT run forward
// into the future — the whole point of this change. The window still ends exactly on that date.
{
  // 2026-10-17 is a Saturday.
  const { current } = resolveComparisonPeriods('weekly', new Date(2026, 9, 17));
  if (current.range.start !== '2026-10-11' || current.range.end !== '2026-10-17') {
    throw new Error(`A reference date must never produce a range extending past itself, got ${current.range.start}..${current.range.end}`);
  }
}

// Monthly/quarterly/yearly must be unaffected by adding weekly (regression on existing behavior
// PeriodSelector.tsx/ClientDashboard.tsx already depend on).
{
  const monthly = resolveComparisonPeriods('monthly', new Date(2026, 9, 18));
  if (monthly.current.label !== '2026-10' || monthly.previous.label !== '2026-09') {
    throw new Error('Monthly granularity regressed after adding weekly.');
  }
  const quarterly = resolveComparisonPeriods('quarterly', new Date(2026, 9, 18));
  if (quarterly.current.label !== '2026-Q4' || quarterly.previous.label !== '2026-Q3') {
    throw new Error('Quarterly granularity regressed after adding weekly.');
  }
  const yearly = resolveComparisonPeriods('yearly', new Date(2026, 9, 18));
  if (yearly.current.label !== '2026' || yearly.previous.label !== '2025') {
    throw new Error('Yearly granularity regressed after adding weekly.');
  }
}

// formatPeriodLabel renders every stored label shape as a readable English string (weekly and
// custom-range labels share the same "start_end" shape, so both format the same way here), and
// leaves a plain yearly label (already clean digits) unchanged.
{
  if (formatPeriodLabel('2026-10-01_2026-10-18') !== 'Oct 1 - Oct 18, 2026') {
    throw new Error(`formatPeriodLabel did not format a same-month custom range label, got "${formatPeriodLabel('2026-10-01_2026-10-18')}"`);
  }
  if (formatPeriodLabel('2026-09-28_2026-10-04') !== 'Sep 28 - Oct 4, 2026') {
    throw new Error(`formatPeriodLabel did not format a cross-month custom range label, got "${formatPeriodLabel('2026-09-28_2026-10-04')}"`);
  }
  if (formatPeriodLabel('2026-12-28_2027-01-03') !== 'Dec 28, 2026 - Jan 3, 2027') {
    throw new Error(`formatPeriodLabel did not format a cross-year custom range label, got "${formatPeriodLabel('2026-12-28_2027-01-03')}"`);
  }
  if (formatPeriodLabel('2026-10') !== 'Oct 2026') throw new Error('formatPeriodLabel did not format a monthly label.');
  if (formatPeriodLabel('2026-Q4') !== 'Q4 2026') throw new Error('formatPeriodLabel did not format a quarterly label.');
  if (formatPeriodLabel('2026') !== '2026') throw new Error('formatPeriodLabel must leave a yearly label unchanged.');
}

console.log('OK: weekly comparison periods are a rolling 7-day window ending on the reference date, monthly/quarterly/yearly are unaffected, and formatPeriodLabel renders every label shape as a readable English string.');
