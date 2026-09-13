import { ClientRecord, ClientStatus } from '../types/database';

// Module 13: single source of truth for client-status display and status-derived business
// rules, replacing what used to be two independently-maintained copies of the same label/color
// map (ClientDashboard.tsx's CLIENT_STATUS_META, SalesPortalView.tsx's STATUS_BADGE_META) —
// same drift risk performanceScore.ts's STATUS_META was built to avoid for employee status.
export const CLIENT_STATUS_META: Record<
  ClientStatus,
  { label: string; bg: string; color: string; border: string }
> = {
  onboarding: {
    label: 'Onboarding',
    bg: 'rgba(123, 47, 247, 0.2)',
    color: 'var(--purple-light)',
    border: 'rgba(123, 47, 247, 0.35)',
  },
  active: {
    label: 'Active',
    bg: 'rgba(169, 245, 193, 0.2)',
    color: 'var(--roas-good)',
    border: 'rgba(169, 245, 193, 0.3)',
  },
  paused: {
    label: 'Paused',
    bg: 'rgba(168, 155, 184, 0.15)',
    color: 'var(--lilac)',
    border: 'rgba(168, 155, 184, 0.3)',
  },
  renewal: {
    label: 'Renewal',
    bg: 'rgba(245, 226, 154, 0.2)',
    color: 'var(--roas-mid)',
    border: 'rgba(245, 226, 154, 0.3)',
  },
  closed: {
    label: 'Closed',
    bg: 'rgba(245, 163, 163, 0.2)',
    color: 'var(--roas-bad)',
    border: 'rgba(245, 163, 163, 0.3)',
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
