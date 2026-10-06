import type { ServiceType } from '../types/database';

export const CLIENT_SERVICES: ServiceType[] = ['seo', 'social_media', 'media_buying', 'interface', 'creation', 'branding'];

// What "شاملة" (Comprehensive) expands to — a strict 4-item subset of CLIENT_SERVICES. Creation
// and Branding are deliberately excluded: they're orthogonal add-ons a client can have
// independently of (or alongside) the comprehensive bundle, never implied by it. Kept as its own
// constant rather than reusing CLIENT_SERVICES directly, since CLIENT_SERVICES still separately
// means "every valid service type" (used by normalizeClientServices' own dedup/ordering below,
// unrelated to what شاملة specifically expands to).
export const COMPREHENSIVE_SERVICES: ServiceType[] = ['seo', 'social_media', 'media_buying', 'interface'];

export type ClientServiceOption = ServiceType | 'comprehensive';

// `group` drives the Register New Client form's two sections: 'main' renders alongside the شاملة
// toggle, 'additional' renders in its own separate "Additional Services" section — Creation/
// Branding are optional add-ons, orthogonal to whichever main service(s) or شاملة is selected.
export const CLIENT_SERVICE_OPTIONS: { value: ClientServiceOption; label: string; group: 'main' | 'additional' }[] = [
  { value: 'seo', label: 'SEO', group: 'main' },
  { value: 'social_media', label: 'Social Media (designs & videos)', group: 'main' },
  { value: 'media_buying', label: 'Media Buying', group: 'main' },
  { value: 'interface', label: 'واجهة', group: 'main' },
  { value: 'comprehensive', label: 'شاملة', group: 'main' },
  { value: 'creation', label: 'Creation (Store/Website Setup) — إنشاء', group: 'additional' },
  { value: 'branding', label: 'Branding — الهوية البصرية', group: 'additional' },
];

/** Expand the bundle and map historical Creative subscriptions to Social Media. */
export function normalizeClientServices(values: readonly string[] | null | undefined): ServiceType[] {
  const selected = new Set<ServiceType>();
  for (const value of values || []) {
    const service = value.trim().toLowerCase();
    if (service === 'comprehensive' || service === 'شاملة') {
      COMPREHENSIVE_SERVICES.forEach((item) => selected.add(item));
    } else if (service === 'creative') {
      selected.add('social_media');
    } else if (service === 'واجهة' || service === 'ui/ux' || service === 'ui_ux') {
      selected.add('interface');
    } else if (service === 'إنشاء') {
      selected.add('creation');
    } else if (service === 'الهوية البصرية' || service === 'هوية') {
      selected.add('branding');
    } else if (CLIENT_SERVICES.includes(service as ServiceType)) {
      selected.add(service as ServiceType);
    }
  }
  return CLIENT_SERVICES.filter((service) => selected.has(service));
}

// The one place allowed to read `.services`/`.other_services` directly off a client object —
// every other call site should go through one of these two instead (enforced by
// scripts/checkClientServicesAccess.ts, run as part of `npm run lint`). Phase 1 only: the
// `other_services` column doesn't exist in the database yet (types only, see ClientRecord), so
// both functions currently only ever receive `other_services: undefined` from real data — this is
// infrastructure for the column landing later, not a behavior change today.

// Deduped union of `services` + `other_services`, normalized down to official ServiceType values
// only (recognized aliases included, same as normalizeClientServices already does) — the
// canonical-values-only list every gating/routing/brief call site should keep using.
export function getClientServices(client: {
  services?: string[] | null;
  other_services?: string[] | null;
}): ServiceType[] {
  return normalizeClientServices([...(client.services || []), ...(client.other_services || [])]);
}

// `other_services` entries that are NOT a recognized ServiceType value or alias — i.e. genuine
// free text (a service this app has no dedicated handling for at all). Trimmed, deduped
// case-insensitively, blanks dropped, original casing of the first occurrence preserved.
export function getClientCustomServices(client: { other_services?: string[] | null }): string[] {
  const seen = new Set<string>();
  const custom: string[] = [];
  for (const raw of client.other_services || []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (normalizeClientServices([trimmed]).length > 0) continue; // a recognized value/alias, not "custom"
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    custom.push(trimmed);
  }
  return custom;
}

export const SERVICE_LABELS: Record<ServiceType, string> = {
  seo: 'SEO',
  social_media: 'Social Media',
  media_buying: 'Media Buying',
  interface: 'واجهة',
  creation: 'Creation (Store/Website Setup)',
  branding: 'Branding',
};

// Shared service badge colors (AMQueue's client-services chips, ClientDashboard's "Contracted
// Services" chips). interface has no explicit entry here — it always fell through to the
// social_media color as a pre-existing default, unchanged by this addition. creation/branding
// get their own distinct colors per explicit request, rather than falling through too.
// Values are theme tokens (not literal colors) so these chips stay legible whichever theme
// is active: the dark-mode :root and [data-theme='light'] blocks in index.css give --info/
// --success/--warning/--rose (and their -tint backgrounds) different, theme-appropriate values.
export const SERVICE_BADGE_COLORS: Partial<Record<ServiceType, { bg: string; text: string }>> = {
  media_buying: { bg: 'var(--info-bg)', text: 'var(--info)' },
  seo: { bg: 'var(--success-bg)', text: 'var(--success)' },
  creation: { bg: 'var(--warning-bg)', text: 'var(--warning)' },
  branding: { bg: 'var(--info-bg)', text: 'var(--info)' },
};
