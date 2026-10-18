import { resolveComparisonPeriods } from '../src/lib/reportingEngine';
import { formatPeriodLabel } from '../src/components/reporting/ComparisonDisplay';

// Weekly granularity (point 4): Saturday-to-Friday, same pattern as monthly/quarterly/yearly —
// a 7-day inclusive current period, and a previous period exactly 7 days earlier.
{
  // 2026-10-18 is a Sunday.
  const { current, previous } = resolveComparisonPeriods('weekly', new Date(2026, 9, 18));
  if (current.range.start !== '2026-10-17' || current.range.end !== '2026-10-23') {
    throw new Error(`Weekly current range should be the Saturday-Friday week containing the reference date, got ${current.range.start}..${current.range.end}`);
  }
  if (previous.range.start !== '2026-10-10' || previous.range.end !== '2026-10-16') {
    throw new Error(`Weekly previous range should be exactly 7 days before current, got ${previous.range.start}..${previous.range.end}`);
  }
  if (current.label !== '2026-10-17_2026-10-23') throw new Error(`Weekly label shape is wrong: ${current.label}`);
}

// A reference date that already IS a Saturday must anchor the week to itself, not the week before.
{
  // 2026-10-17 is a Saturday.
  const { current } = resolveComparisonPeriods('weekly', new Date(2026, 9, 17));
  if (current.range.start !== '2026-10-17' || current.range.end !== '2026-10-23') {
    throw new Error(`A Saturday reference date must anchor the week starting on itself, got ${current.range.start}..${current.range.end}`);
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

// Point 2: formatPeriodLabel turns a custom "start_end" label into clear "من X إلى Y" wording
// (so an Arabic scope name next to it can't scramble the date order under RTL), and leaves a
// plain calendar-unit label (monthly/quarterly/yearly — no "_", no RTL ambiguity) unchanged.
{
  if (formatPeriodLabel('2026-10-01_2026-10-18') !== 'من 2026-10-01 إلى 2026-10-18') {
    throw new Error('formatPeriodLabel did not convert a custom range label to "من...إلى" wording.');
  }
  if (formatPeriodLabel('2026-10') !== '2026-10') throw new Error('formatPeriodLabel must leave a monthly label unchanged.');
  if (formatPeriodLabel('2026-Q4') !== '2026-Q4') throw new Error('formatPeriodLabel must leave a quarterly label unchanged.');
  if (formatPeriodLabel('2026') !== '2026') throw new Error('formatPeriodLabel must leave a yearly label unchanged.');
}

console.log('OK: weekly comparison periods (Saturday-Friday) match monthly/quarterly/yearly\'s own resolveComparisonPeriods pattern, and formatPeriodLabel clarifies custom-range labels without touching calendar-unit ones.');
