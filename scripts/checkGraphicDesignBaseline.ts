// Static checks for the "Graphic Design is baseline, not a separate toggle" change requested
// 2026-11-07: "خدمة ال graphic design مش هتكون منفصلة لازم نختارها لوحدها اي عميل داخل ال system
// هيكون معاه Designs ف الخدمة هتكون اساسية مع كل عميل" — every client (existing and new) is
// treated as having Graphic Design, and the Register/Edit Client form no longer offers it as a
// pick.
import { getClientServices, CLIENT_SERVICE_OPTIONS, splitClientServices, normalizeClientServices } from '../src/lib/clientServices';

// 1) The Register/Edit Client "Other Services" toggle list no longer offers Graphic Design as a
// pick — it shows up automatically for every client instead, never because someone selected it.
if (CLIENT_SERVICE_OPTIONS.some((opt) => opt.value === 'graphic_design')) {
  throw new Error('CLIENT_SERVICE_OPTIONS must not offer graphic_design as a selectable toggle any more — it is baseline for every client now.');
}

// 2) getClientServices() — the one function every gating/routing/brief call site uses to read
// "what services does this client have" — always includes graphic_design, for a client that never
// had it in services/other_services at all (covers every pre-existing client immediately, no
// migration needed) AND for a client that explicitly has other services only.
const neverHadIt = getClientServices({ services: ['seo'], other_services: ['interface'] });
if (!neverHadIt.includes('graphic_design')) {
  throw new Error('getClientServices() must always include graphic_design, even for a client whose stored services/other_services never mention it.');
}
const explicitlyEmpty = getClientServices({ services: [], other_services: [] });
if (!explicitlyEmpty.includes('graphic_design')) {
  throw new Error('getClientServices() must include graphic_design even for a client with completely empty services/other_services.');
}
// No duplicate when a client's other_services already (redundantly) lists it.
const alreadyHasIt = getClientServices({ services: [], other_services: ['graphic_design'] });
if (alreadyHasIt.filter((s) => s === 'graphic_design').length !== 1) {
  throw new Error('getClientServices() must not duplicate graphic_design when it is already present in the stored other_services.');
}

// 3) normalizeClientServices() itself must stay a PURE classifier — it must NOT inject
// graphic_design unconditionally, or every single-value classification call site (e.g.
// getClientCustomServices' "is this recognized, or genuinely custom text" check) silently breaks,
// since graphic_design would always show up as "recognized" even for unrelated/garbage input.
// The baseline belongs in getClientServices() only (checked above).
if (normalizeClientServices(['seo']).includes('graphic_design')) {
  throw new Error('normalizeClientServices(["seo"]) must resolve to just seo — it must never inject graphic_design on its own; that belongs in getClientServices() only.');
}
if (normalizeClientServices(['totally not a real service']).includes('graphic_design')) {
  throw new Error('normalizeClientServices() must not treat unrelated/unrecognized text as implying graphic_design.');
}

// 4) splitClientServices() still writes graphic_design out to other_services on every save
// (registration AND edit), unconditionally — so newly saved/edited clients have it explicitly in
// their stored data going forward, not just inferred at read time.
const { other_services } = splitClientServices(['seo']);
if (!other_services.includes('graphic_design')) {
  throw new Error('splitClientServices() must always include graphic_design in other_services, regardless of what was passed in.');
}

console.log('OK: Graphic Design is baseline for every client (getClientServices() always includes it, with no data migration needed), the Register/Edit Client toggle no longer offers it, normalizeClientServices() stays a pure classifier, and splitClientServices() keeps writing it out on every save.');
