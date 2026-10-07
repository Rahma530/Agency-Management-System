import { ClientLifecyclePeriodRecord, ClientRecord, ClientStatus } from '../types/database';

// Module 13: single source of truth for client-status display and status-derived business
// rules, replacing what used to be two independently-maintained copies of the same label/color
// map (ClientDashboard.tsx's CLIENT_STATUS_META, SalesPortalView.tsx's STATUS_BADGE_META).
export const CLIENT_STATUS_META: Record<
  ClientStatus,
  { label: string; bg: string; color: string; border: string }
> = {
  onboarding: {
    label: 'Onboarding',
    bg: 'var(--client-status-onboarding-tint)',
    color: 'var(--purple-light)',
    border: 'var(--lifecycle-onboarding-border)',
  },
  active: {
    label: 'Active',
    bg: 'var(--client-status-active-tint)',
    color: 'var(--roas-good)',
    border: 'var(--border-success)',
  },
  paused: {
    label: 'Paused',
    bg: 'var(--client-status-paused-tint)',
    color: 'var(--lilac)',
    border: 'var(--priority-low-border)',
  },
  renewal: {
    label: 'Renewal',
    bg: 'var(--client-status-renewal-tint)',
    color: 'var(--roas-mid)',
    border: 'var(--priority-medium-border)',
  },
  closed: {
    label: 'Closed',
    bg: 'var(--client-status-closed-tint)',
    color: 'var(--roas-bad)',
    border: 'var(--border-rose)',
  },
};

// Decision (Module 13): "currently active work" means active + renewal everywhere in the app —
// a client in the renewal window is still fully active work, just near its renewal date. Apply
// this uniformly instead of letting each call site invent its own active-vs-active+renewal
// definition (this was already inconsistent pre-Module 13: ExecutiveDashboard's MRR calc used
// active+renewal, MyWorkHub's "Active Clients" stat used active-only).
export const isCurrentlyActiveClient = (client: ClientRecord): boolean =>
  client.status === 'active' || client.status === 'renewal';

// Decision (Module 13): a paused client is intentionally, temporarily halted — excluded from
// "needs attention" nudges (missing brief / renewal reminders) and from an agent's
// capacity/workload load, but still counts toward MRR (still a paying, contracted client).
export const isPausedClient = (client: ClientRecord): boolean => client.status === 'paused';

type CalendarDate = {
  year: number;
  month: number;
  day: number;
  timestamp: number;
};

const parseCalendarDate = (value: string): CalendarDate | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day, timestamp: date.getTime() };
};

const addCalendarMonths = (date: CalendarDate, monthsToAdd: number): number => {
  const targetMonthIndex = date.month - 1 + monthsToAdd;
  const year = date.year + Math.floor(targetMonthIndex / 12);
  const monthIndex = targetMonthIndex % 12;
  const daysInTargetMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Date.UTC(year, monthIndex, Math.min(date.day, daysInTargetMonth));
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const formatElapsedCalendarDays = (totalDays: number, anchor: CalendarDate): string => {
  const safeTotalDays = Math.max(0, Math.trunc(totalDays));
  const syntheticEndDate = new Date(anchor.timestamp + safeTotalDays * DAY_IN_MS);
  const end: CalendarDate = {
    year: syntheticEndDate.getUTCFullYear(),
    month: syntheticEndDate.getUTCMonth() + 1,
    day: syntheticEndDate.getUTCDate(),
    timestamp: syntheticEndDate.getTime(),
  };

  let totalMonths = (end.year - anchor.year) * 12 + end.month - anchor.month;
  let monthAnchor = addCalendarMonths(anchor, totalMonths);
  if (monthAnchor > end.timestamp) {
    totalMonths -= 1;
    monthAnchor = addCalendarMonths(anchor, totalMonths);
  }

  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const days = Math.round((end.timestamp - monthAnchor) / DAY_IN_MS);

  const parts: string[] = [];
  if (years) parts.push(`${years} ${years === 1 ? 'year' : 'years'}`);
  if (months) parts.push(`${months} ${months === 1 ? 'month' : 'months'}`);
  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);

  return parts.length ? parts.join(', ') : '0 days';
};

export const formatClientRelationshipDuration = (
  startDate: string | null | undefined,
  churnedAt: string | null | undefined
): string => {
  if (!churnedAt) return 'Unknown';
  if (!startDate) return 'Unavailable — Start Date not set';

  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(churnedAt);
  if (!start || !end || end.timestamp < start.timestamp) return 'Unknown';

  const totalDays = Math.round((end.timestamp - start.timestamp) / DAY_IN_MS);
  return formatElapsedCalendarDays(totalDays, start);
};

export const formatClientLifecycleDuration = (
  client: ClientRecord,
  lifecyclePeriods: ClientLifecyclePeriodRecord[],
  today: string
): string => {
  const parsedToday = parseCalendarDate(today);
  if (!parsedToday) return 'Unknown';

  if (lifecyclePeriods.length > 0) {
    const parsedPeriods = lifecyclePeriods.map((period) => {
      const start = parseCalendarDate(period.started_on);
      const end = period.ended_on ? parseCalendarDate(period.ended_on) : parsedToday;
      return { period, start, end };
    });

    if (
      parsedPeriods.some(
        ({ start, end }) =>
          !start ||
          !end ||
          start.timestamp > parsedToday.timestamp ||
          end.timestamp > parsedToday.timestamp ||
          end.timestamp < start.timestamp
      )
    ) {
      return 'Unknown — Lifecycle history is inconsistent';
    }

    const openPeriodCount = lifecyclePeriods.filter((period) => !period.ended_on).length;
    if (
      openPeriodCount > 1 ||
      (client.status === 'closed' && openPeriodCount !== 0) ||
      (client.status !== 'closed' && openPeriodCount !== 1)
    ) {
      return 'Unknown — Lifecycle history is inconsistent';
    }

    const orderedPeriods = parsedPeriods
      .map(({ period, start, end }) => ({ period, start: start!, end: end! }))
      .sort((a, b) => a.start.timestamp - b.start.timestamp);

    for (let index = 1; index < orderedPeriods.length; index += 1) {
      if (orderedPeriods[index].start.timestamp < orderedPeriods[index - 1].end.timestamp) {
        return 'Unknown — Lifecycle history is inconsistent';
      }
    }

    const totalActiveDays = orderedPeriods.reduce(
      (sum, { start, end }) => sum + Math.round((end.timestamp - start.timestamp) / DAY_IN_MS),
      0
    );

    return formatElapsedCalendarDays(totalActiveDays, orderedPeriods[0].start);
  }

  if (!client.start_date) return 'Unavailable — Start Date not set';

  const start = parseCalendarDate(client.start_date);
  const end = client.status === 'closed'
    ? client.churned_at
      ? parseCalendarDate(client.churned_at)
      : null
    : parsedToday;

  if (
    !start ||
    !end ||
    start.timestamp > parsedToday.timestamp ||
    end.timestamp > parsedToday.timestamp ||
    end.timestamp < start.timestamp
  ) {
    return 'Unknown';
  }

  const totalActiveDays = Math.round((end.timestamp - start.timestamp) / DAY_IN_MS);
  return formatElapsedCalendarDays(totalActiveDays, start);
};
