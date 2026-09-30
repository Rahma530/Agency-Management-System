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
