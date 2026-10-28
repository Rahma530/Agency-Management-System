export interface ReportPeriod {
  startInclusive: string;
  endExclusive: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDateUtc(value: string): Date {
  const match = ISO_DATE.exec(value);
  if (!match) throw new Error(`Invalid ISO date: ${value}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(Date.UTC(year, month - 1, day));
  if (
    result.getUTCFullYear() !== year ||
    result.getUTCMonth() !== month - 1 ||
    result.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return result;
}

function formatIsoDateUtc(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// Formats the browser's local calendar date without converting it to UTC. This is deliberately
// separate from the UTC-only report interval helpers below: form defaults represent what the user
// sees on their calendar, and toISOString() can otherwise move a Cairo midnight to the prior day.
export function formatLocalCalendarDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function localWeekMonday(value = new Date()): string {
  const day = value.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return formatLocalCalendarDate(new Date(value.getFullYear(), value.getMonth(), value.getDate() + diffToMonday));
}

export function addReportDays(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error('Report-day offset must be an integer.');
  return formatIsoDateUtc(new Date(parseIsoDateUtc(date).getTime() + days * DAY_MS));
}

// Converts an inclusive UI selection into the half-open interval used by report queries.
export function resolveReportPeriod(startInclusive: string, endInclusive: string): ReportPeriod {
  parseIsoDateUtc(startInclusive);
  parseIsoDateUtc(endInclusive);
  if (startInclusive > endInclusive) throw new Error('Report period start must not be after its end.');
  return { startInclusive, endExclusive: addReportDays(endInclusive, 1) };
}

// A reporting week is the calendar interval [Saturday, next Saturday). Friday belongs to the
// interval for boundary calculations but is excluded by isReportWorkDate()/isDateInReportPeriod.
export function resolveReportWorkWeek(anchorDate: string): ReportPeriod {
  const anchor = parseIsoDateUtc(anchorDate);
  const daysSinceSaturday = (anchor.getUTCDay() + 1) % 7;
  const startInclusive = addReportDays(anchorDate, -daysSinceSaturday);
  return { startInclusive, endExclusive: addReportDays(startInclusive, 7) };
}

export function isReportWorkDate(date: string): boolean {
  return parseIsoDateUtc(date).getUTCDay() !== 5;
}

export function isDateInReportPeriod(date: string, period: ReportPeriod): boolean {
  parseIsoDateUtc(date);
  parseIsoDateUtc(period.startInclusive);
  parseIsoDateUtc(period.endExclusive);
  if (period.startInclusive >= period.endExclusive) throw new Error('Report period must be non-empty.');
  return date >= period.startInclusive && date < period.endExclusive && isReportWorkDate(date);
}

// Report header date formatting — "From 10/22/2026" (MM/DD/YYYY, per the agency owner's exact
// request). Split into a part/whole pair ({ label: 'From', date: '10/22/2026' }) rather than one
// joined string so each caller can render the two with different weights (bold label vs regular
// date) in whatever way its own output format allows — jsPDF needs separate text() calls with a
// font-weight switch in between; HTML can just wrap the label in <strong>.
export interface ReportDateLabel {
  label: 'From' | 'To';
  date: string;
}

function formatMonthDayYear(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
}

// selectedReport.period is always "<fromIso>_<toIso>" (resolveReportPeriod's own storage format,
// via ReportDraftWorkspace) or empty. Returns null for anything that doesn't parse, so callers can
// fall back to not rendering a date line at all rather than printing a half-broken one.
export function parseReportPeriodRange(period: string): { from: ReportDateLabel; to: ReportDateLabel } | null {
  const [periodFrom, periodTo] = (period || '').split('_');
  if (!periodFrom || !periodTo) return null;
  return {
    from: { label: 'From', date: formatMonthDayYear(periodFrom) },
    to: { label: 'To', date: formatMonthDayYear(periodTo) },
  };
}

// Replaces the old literal "Final Report" fallback heading — see pdfExport.ts/reportHtmlExport.ts
// for where it's used. Derived purely from the period's own length, so no new "report type" field
// or UI control is needed anywhere upstream (ReportDraftWorkspace has no granularity selector
// today, only free-form start/end date inputs): a 7-day span reads as a weekly report, a 28-31 day
// span as a monthly one, and anything else (a half week, a custom multi-month range, ...) falls
// back to the generic "Period Report" rather than guessing a cadence that isn't there. Counts days
// inclusively (both endpoints count), matching how the date range itself reads to someone looking
// at it ("22 to 26" is 5 days, not 4).
export function resolveReportTypeLabel(period: string): string {
  const [periodFrom, periodTo] = (period || '').split('_');
  if (!periodFrom || !periodTo) return 'Period Report';
  try {
    const days = Math.round(
      (parseIsoDateUtc(periodTo).getTime() - parseIsoDateUtc(periodFrom).getTime()) / DAY_MS
    ) + 1;
    if (days === 7) return 'Weekly Report';
    if (days >= 28 && days <= 31) return 'Monthly Report';
    return 'Period Report';
  } catch {
    return 'Period Report';
  }
}
