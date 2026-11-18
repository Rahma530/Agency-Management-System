// Client Renewals page: "number of employees handling this client" column.
//
// Owner-confirmed (2026-11-18): the package is read off the client's existing services/
// other_services fields (same ones used everywhere else — see clientServices.ts), and the
// headcounts themselves are fixed numbers, not computed from any live team-assignment data:
//   الباقة الشاملة (seo + social_media + media_buying, no interface): 14
//   الباقة الشاملة + واجهة (the above + interface): 16
//   إعلانات فقط (media_buying only): 8
//   سيو فقط (seo only): 9
//   إنشاء فقط (creation only): 6
// Any other combination has no agreed number yet — returns null rather than guessing, so the
// column can show "—" instead of a wrong figure.

import type { ServiceType } from '../types/database';
import { getClientServices } from './clientServices';

const CORE_THREE: ServiceType[] = ['seo', 'social_media', 'media_buying'];

const hasExactly = (resolved: Set<ServiceType>, expected: ServiceType[]): boolean =>
  resolved.size === expected.length && expected.every((s) => resolved.has(s));

export function getRenewalTeamSize(client: {
  services?: string[] | null;
  other_services?: string[] | null;
}): number | null {
  // graphic_design is injected as a baseline for every client regardless of what's actually
  // selected (see getClientServices's own note) — excluded here so it never counts as "an extra
  // service" that breaks the exact-match buckets below (e.g. a seo-only client must still match
  // the سيو bucket even though graphic_design is technically present too).
  const resolved = new Set(getClientServices(client).filter((s) => s !== 'graphic_design') as ServiceType[]);

  const hasAllCore = CORE_THREE.every((s) => resolved.has(s));
  const hasInterface = resolved.has('interface');

  if (hasAllCore && hasInterface) return 16; // الباقة الشاملة + واجهة
  if (hasAllCore && !hasInterface) return 14; // الباقة الشاملة
  if (hasExactly(resolved, ['media_buying'])) return 8; // إعلانات
  if (hasExactly(resolved, ['seo'])) return 9; // سيو
  if (hasExactly(resolved, ['creation'])) return 6; // إنشاء

  return null;
}
