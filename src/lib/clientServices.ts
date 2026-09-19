import type { ServiceType } from '../types/database';

export const CLIENT_SERVICES: ServiceType[] = ['seo', 'social_media', 'media_buying', 'interface', 'creation', 'branding'];
export type ClientServiceOption = ServiceType | 'comprehensive';

export const CLIENT_SERVICE_OPTIONS: { value: ClientServiceOption; label: string }[] = [
  { value: 'seo', label: 'SEO' },
  { value: 'social_media', label: 'Social Media (designs & videos)' },
  { value: 'media_buying', label: 'Media Buying' },
  { value: 'interface', label: 'واجهة' },
  { value: 'creation', label: 'Creation (Store/Website Setup) — إنشاء' },
  { value: 'branding', label: 'Branding — الهوية البصرية' },
  { value: 'comprehensive', label: 'شاملة' },
];

/** Expand the bundle and map historical Creative subscriptions to Social Media. */
export function normalizeClientServices(values: readonly string[] | null | undefined): ServiceType[] {
  const selected = new Set<ServiceType>();
  for (const value of values || []) {
    const service = value.trim().toLowerCase();
    if (service === 'comprehensive' || service === 'شاملة') {
      CLIENT_SERVICES.forEach((item) => selected.add(item));
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
export const SERVICE_BADGE_COLORS: Partial<Record<ServiceType, { bg: string; text: string }>> = {
  media_buying: { bg: 'rgba(14, 165, 233, 0.2)', text: '#38bdf8' },
  seo: { bg: 'rgba(16, 185, 129, 0.2)', text: '#34d399' },
  creation: { bg: 'rgba(251, 146, 60, 0.2)', text: '#fb923c' },
  branding: { bg: 'rgba(34, 211, 238, 0.2)', text: '#22d3ee' },
};
