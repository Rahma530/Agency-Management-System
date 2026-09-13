import { ClientRecord } from '../types/database';

// Module 14: single source of truth for "does this client match this search query" — name or
// phone_number, case-insensitive, partial match. Six screens need this exact predicate
// (AMQueue, ServiceBriefsRoutingView, CampaignManagementModule, SalesPortalView, MyWorkHub,
// ReportsHub); centralizing it avoids the phone_number half silently drifting out of sync in one
// of them, same reasoning as clientStatus.ts's CLIENT_STATUS_META.
export const matchesClientQuery = (client: ClientRecord, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    client.name.toLowerCase().includes(q) ||
    (client.phone_number || '').toLowerCase().includes(q)
  );
};
