import { ClientRecord, ClientStatus } from '../types/database';

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

export const formatClientRelationshipDuration = (
  startDate: string | null | undefined,
  churnedAt: string | null | undefined
): string => {
  if (!churnedAt) return 'Unknown';
  if (!startDate) return 'Unavailable — Start Date not set';

  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(churnedAt);
  if (!start || !end || end.timestamp < start.timestamp) return 'Unknown';

  let totalMonths = (end.year - start.year) * 12 + end.month - start.month;
  let monthAnchor = addCalendarMonths(start, totalMonths);
  if (monthAnchor > end.timestamp) {
    totalMonths -= 1;
    monthAnchor = addCalendarMonths(start, totalMonths);
  }

  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const days = Math.round((end.timestamp - monthAnchor) / (24 * 60 * 60 * 1000));

  const parts: string[] = [];
  if (years) parts.push(`${years} ${years === 1 ? 'year' : 'years'}`);
  if (months) parts.push(`${months} ${months === 1 ? 'month' : 'months'}`);
  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);

  return parts.length ? parts.join(', ') : '0 days';
};
