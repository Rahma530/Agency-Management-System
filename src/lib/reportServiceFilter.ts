import { SERVICE_LABELS } from './clientServices';

// Report service buckets, as sent to preview_report_sources_v2 / create_report_draft_v2 in
// p_service_filter and stored on reports.client_service_filter. Server rules live in
// supabase/migrations/20261127000000_report_service_bucket_filter.sql. Keep the token lists in sync.

// Selectable inside "All Services" (every bucket except creative). Order is the stored order too,
// so the same selection always produces the same string (and the same saved-report key).
export const ALL_SERVICES_TOKENS = ['media_buying', 'social_media', 'seo', 'interface', 'creation', 'other'] as const;
export type AllServicesToken = (typeof ALL_SERVICES_TOKENS)[number];

// The priority services: always shown first in the picker.
export const CORE_SERVICE_TOKENS: readonly AllServicesToken[] = ['media_buying', 'social_media', 'seo'];

// Creative pool work (graphic_designer / video_editor), its own tab.
export const CREATIVE_TOKEN = 'creative' as const;

// Default for "All Services": everything except creative.
export const DEFAULT_ALL_SERVICES_SELECTION: readonly AllServicesToken[] = ALL_SERVICES_TOKENS;

export const REPORT_BUCKET_LABELS: Record<AllServicesToken | typeof CREATIVE_TOKEN, string> = {
  media_buying: SERVICE_LABELS.media_buying,
  social_media: SERVICE_LABELS.social_media,
  seo: SERVICE_LABELS.seo,
  interface: SERVICE_LABELS.interface,
  creation: SERVICE_LABELS.creation,
  other: 'Other updates',
  creative: 'Creative',
};

// Canonical stored string for a set of "All Services" buckets: the chosen tokens in the fixed
// order above. Returns null only for an empty selection, which the UI must not allow (null
// means "every bucket, creative included" on the server).
export function allServicesFilterValue(selection: readonly AllServicesToken[]): string | null {
  const picked = ALL_SERVICES_TOKENS.filter((token) => selection.includes(token));
  return picked.length > 0 ? picked.join(',') : null;
}

export type ReportBucketToken = AllServicesToken | typeof CREATIVE_TOKEN;
