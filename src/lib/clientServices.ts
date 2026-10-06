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

// `group` drives the Register New Client form's two sections. 'main' = the 3 core services
// (seo/social_media/media_buying, which is all `public.clients.services` ever holds now — see
// splitClientServices below) plus the شاملة toggle. 'other' = everything that always lands in
// `other_services` instead — interface/creation/branding, rendered as its own "Other Services"
// section alongside the free-text "Add another service" input (ClientRegistrationModal.tsx).
export const CLIENT_SERVICE_OPTIONS: { value: ClientServiceOption; label: string; group: 'main' | 'other' }[] = [
  { value: 'seo', label: 'SEO', group: 'main' },
  { value: 'social_media', label: 'Social Media (designs & videos)', group: 'main' },
  { value: 'media_buying', label: 'Media Buying', group: 'main' },
  { value: 'comprehensive', label: 'شاملة', group: 'main' },
  { value: 'interface', label: 'واجهة', group: 'other' },
  { value: 'creation', label: 'Creation (Store/Website Setup) — إنشاء', group: 'other' },
  { value: 'branding', label: 'Branding — الهوية البصرية', group: 'other' },
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

const CORE_SERVICES: ServiceType[] = ['seo', 'social_media', 'media_buying'];

// The one place that decides which column a service entry belongs in, used at every write path
// (ClientRegistrationModal, BulkClientUploadModal) instead of each building `services`/
// `other_services` ad hoc. Storage rule: `services` only ever holds the 3 core types (seo/
// social_media/media_buying) — interface, creation, branding, and any value this function doesn't
// recognize at all (genuine free text) all go in `other_services` instead. شاملة expands to the 3
// core types in `services` plus interface in `other_services` (mirrors COMPREHENSIVE_SERVICES,
// minus the 3 core types it also contains). Values are matched case-insensitively (Arabic values
// have no case, so comparing them as-is is already case-insensitive); recognized values are
// returned as their canonical ServiceType; everything else is kept as free text with its original
// casing (trimmed, deduped case-insensitively against other free-text entries) — never
// lowercased, so a custom entry like "Photography" isn't mangled into "photography". By
// construction, `services` and `other_services` can never share a value: every branch below
// writes to exactly one of the three sets (core / other-canonical / free text), never both.
export function splitClientServices(values: readonly string[] | null | undefined): {
  services: ServiceType[];
  other_services: string[];
} {
  const core = new Set<ServiceType>();
  const otherCanonical = new Set<ServiceType>();
  const customSeen = new Set<string>();
  const custom: string[] = [];

  for (const raw of values || []) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();

    if (lower === 'comprehensive' || trimmed === 'شاملة') {
      CORE_SERVICES.forEach((service) => core.add(service));
      otherCanonical.add('interface');
    } else if (lower === 'creative') {
      core.add('social_media');
    } else if (lower === 'seo' || lower === 'social_media' || lower === 'media_buying') {
      core.add(lower as ServiceType);
    } else if (trimmed === 'واجهة' || lower === 'ui/ux' || lower === 'ui_ux' || lower === 'interface') {
      otherCanonical.add('interface');
    } else if (trimmed === 'إنشاء' || lower === 'creation') {
      otherCanonical.add('creation');
    } else if (trimmed === 'الهوية البصرية' || trimmed === 'هوية' || lower === 'branding') {
      otherCanonical.add('branding');
    } else {
      if (customSeen.has(lower)) continue;
      customSeen.add(lower);
      custom.push(trimmed);
    }
  }

  return {
    services: CORE_SERVICES.filter((service) => core.has(service)),
    other_services: [...CLIENT_SERVICES.filter((service) => otherCanonical.has(service)), ...custom],
  };
}

// The one place allowed to read `.services`/`.other_services` directly off a client object —
// every other call site should go through one of these two instead (enforced by
// scripts/checkClientServicesAccess.ts, run as part of `npm run lint`).

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

// Order-independent comparison of a client's ACTUAL services/other_services columns against a
// freshly computed splitClientServices() result — used by EditClientModal.tsx to decide whether
// either key belongs in its update_client_details() patch at all. Needs the raw per-column values
// (not getClientServices()' merged/normalized view) since a patch is built against real columns,
// not the union read path every other consumer should use instead.
function sameServiceValues(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export function clientServicesChanged(
  client: { services?: string[] | null; other_services?: string[] | null },
  next: { services: string[]; other_services: string[] }
): { servicesChanged: boolean; otherServicesChanged: boolean } {
  return {
    servicesChanged: !sameServiceValues(next.services, client.services || []),
    otherServicesChanged: !sameServiceValues(next.other_services, client.other_services || []),
  };
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
