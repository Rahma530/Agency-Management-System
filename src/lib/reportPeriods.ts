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
