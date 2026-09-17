import type { ServiceType } from '../types/database';

export const CLIENT_SERVICES: ServiceType[] = ['seo', 'social_media', 'media_buying', 'interface'];
export type ClientServiceOption = ServiceType | 'comprehensive';

export const CLIENT_SERVICE_OPTIONS: { value: ClientServiceOption; label: string }[] = [
  { value: 'seo', label: 'SEO' },
  { value: 'social_media', label: 'Social Media (designs & videos)' },
  { value: 'media_buying', label: 'Media Buying' },
  { value: 'interface', label: 'واجهة' },
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
};
