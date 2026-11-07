// Per-company visual identity for the branded HTML report (reportHtmlExport.ts) — owner's direct
// request, 2026-11-07: a report about a client that belongs to one of the agency's sibling
// companies (clients.company — see clientCompany.ts) must carry THAT company's own colors and
// name, not Kesra's, while every other rule (sections, data, wording) stays exactly as it is.
// HTML-only by the owner's own confirmation (the plain jsPDF export is already hidden from the UI
// and stays untouched here) — see reportHtmlExport.ts's own header comment for why HTML is the
// format this app can brand richly in the first place.
//
// Scope, also confirmed directly: only a report tied to ONE specific client (a client-scope
// Individual report, or the Unified Client Report) ever resolves to a non-Kesra brand. An
// employee-scope report (Employee Overall / All Clients) can span several clients — possibly
// several companies — at once, so it always renders in the fixed Kesra identity; call sites pass
// `null`/`undefined` (or skip resolveReportBrand entirely) for that case rather than ever guessing
// a single company for it.
//
// Logo: text name only, no image — same as the current "KESRA" wordmark, which has always been
// plain text (pdfExport.ts's own header comment: "Text wordmark standing in for a logo"); the
// owner confirmed keeping the same convention for the other two companies rather than embedding
// the logo files she sent.
//
// Colors sampled directly from the owner's own logo files (not invented): Top Rate's navy
// (#132248-ish core) and Fast Growth's yellow/orange pair (#fbac29 / #f7650f) were read pixel-by-
// pixel off the actual PNGs she sent, picking the most common non-background pixel color in each.
export type ClientCompanyBrandId = 'kesra' | 'fast_growth' | 'top_rate';

// Every color role the generated report's inline <style> (reportHtmlExport.ts's BASE_STYLE)
// references via var(--xxx). Keeping the SAME CSS variable names across every brand (only the
// values differ) means BASE_STYLE itself never needs an if/else per brand — it just always reads
// through these roles, and a brand is free to redefine what "page background" or "heading text"
// actually means (e.g. Top Rate's "--white" role holds a dark navy, since its page is light and
// headings must be dark to stay legible — the CSS variable NAME is inherited from the original
// Kesra theme's own naming, not descriptive of the color itself, for any brand other than Kesra).
export interface ReportBrandPalette {
  pageBg: string; // --black
  cardBg: string; // --black-2
  accentDeep: string; // --purple-deep
  accent: string; // --purple
  accentLight: string; // --purple-light
  bodyText: string; // --lilac — default paragraph/body text color
  // --heading — h2/.kpi strong/.meta strong/.service-block h3/an upcoming-work card title: text
  // drawn directly on the page or a page-level card. For Kesra/Fast Growth (dark page) this is
  // white; for Top Rate (light page) it's the same dark navy as accentDeep — kept as its own role
  // rather than reusing accentDeep directly so a future brand could diverge the two.
  headingText: string;
  // --on-accent — text drawn ON an accent-colored element (the round section badge, the table
  // header row): always white today across all three brands, since every accentDeep is dark/
  // saturated enough for white text to stay legible, but kept distinct from headingText because
  // the two roles diverge for a light-page brand (Top Rate) where headingText is dark navy.
  onAccentText: string;
  mutedText: string; // --grey
  roasGood: string;
  roasMid: string;
  roasBad: string;
  gradientPage: string;
  gradientHero: string;
  gradientTitleText: string;
  gradientCard: string;
  gradientBadge: string;
  gradientSection: string;
  borderSoft: string;
  borderMedium: string;
  borderStrong: string;
  borderLilac: string;
  metaBg: string; // replaces a hardcoded rgba(255,255,255,.04) in .meta div
  noteBg: string; // replaces a hardcoded rgba(123,47,247,.1) in .note
  serviceBg: string; // replaces a hardcoded rgba(123,47,247,.06) in .service-block
  rowStripe: string; // replaces a hardcoded rgba(123,47,247,.06) in tbody tr:nth-child(even)
  imgShadow: string; // full box-shadow value, replaces a hardcoded rgba(123,47,247,.18) shadow
  imgFallbackBg: string; // replaces a hardcoded background:#000 behind a transparent-PNG screenshot
}

export interface ReportBrand {
  id: ClientCompanyBrandId;
  // Shown in the small "eyebrow" label above the title and in the page footer — e.g.
  // "Weekly Report — KESRA Management System" / "... — Top Rate Marketing Agency" / "... — Fast Growth".
  footerText: string;
  palette: ReportBrandPalette;
}

// Unchanged from the report's original, only-ever theme — every value here is copied verbatim from
// reportHtmlExport.ts's previous static TOKENS constant, so a Kesra-identity report (the default,
// and every report that existed before this feature) renders pixel-identical to before.
export const KESRA_BRAND: ReportBrand = {
  id: 'kesra',
  footerText: 'KESRA Management System',
  palette: {
    pageBg: '#0a0a0d',
    cardBg: '#151318',
    accentDeep: '#3b1560',
    accent: '#7b2ff7',
    accentLight: '#b98cf0',
    bodyText: '#e9d9fb',
    headingText: '#ffffff',
    onAccentText: '#ffffff',
    mutedText: '#a89bb8',
    roasGood: '#a9f5c1',
    roasMid: '#f5e29a',
    roasBad: '#f5a3a3',
    gradientPage: 'linear-gradient(180deg,#0a0a0d 0%,#150f1f 40%,#0a0a0d 100%)',
    gradientHero:
      'radial-gradient(circle at 50% -10%,rgba(123,47,247,0.45),transparent 60%),linear-gradient(135deg,#0a0a0d 0%,#3b1560 100%)',
    gradientTitleText: 'linear-gradient(90deg,#ffffff,#b98cf0)',
    gradientCard: 'linear-gradient(160deg,#151318,#1c1224)',
    gradientBadge: 'linear-gradient(135deg,#7b2ff7,#3b1560)',
    gradientSection: 'linear-gradient(160deg,rgba(21,19,24,0.9),rgba(59,21,96,0.25))',
    borderSoft: 'rgba(123,47,247,0.25)',
    borderMedium: 'rgba(123,47,247,0.35)',
    borderStrong: 'rgba(123,47,247,0.4)',
    borderLilac: 'rgba(185,140,240,0.2)',
    metaBg: 'rgba(255,255,255,.04)',
    noteBg: 'rgba(123,47,247,.1)',
    serviceBg: 'rgba(123,47,247,.06)',
    rowStripe: 'rgba(123,47,247,.06)',
    imgShadow: '0 12px 32px rgba(123,47,247,.18)',
    imgFallbackBg: '#000',
  },
};

// "الخلفية بيضاء و الكلام كحلي" — white background, navy text. Colors taken directly from the
// owner's own approved reference report (report-ruwahouse-toprate.html, sent 2026-11-07) rather
// than re-derived — every hex below is copied from that file's :root tokens, including the exact
// navy she picked (#0f2142), not the lighter guess this brand originally shipped with.
export const TOP_RATE_BRAND: ReportBrand = {
  id: 'top_rate',
  footerText: 'Top Rate Marketing Agency',
  palette: {
    pageBg: '#ffffff',
    cardBg: '#f3f6fb',
    accentDeep: '#0f2142',
    accent: '#1f3f74',
    accentLight: '#3566a8',
    bodyText: '#1c2b46',
    // Same navy as accentDeep — the reference file points h2/.kpi strong/.meta strong/
    // .service-block h3 directly at var(--purple-deep) rather than a separate token.
    headingText: '#0f2142',
    onAccentText: '#ffffff',
    mutedText: '#5c6b85',
    // Left exactly as Kesra's own defaults — the reference file didn't touch these (they aren't
    // referenced anywhere in the generated report's own CSS; the live app's DeltaBadge reads its
    // own, unrelated copy from src/index.css).
    roasGood: '#a9f5c1',
    roasMid: '#f5e29a',
    roasBad: '#f5a3a3',
    gradientPage: 'linear-gradient(180deg,#ffffff 0%,#eef2f9 40%,#ffffff 100%)',
    gradientHero:
      'radial-gradient(circle at 50% -10%,rgba(31,63,116,0.10),transparent 60%),linear-gradient(135deg,#ffffff 0%,#eef2f9 100%)',
    gradientTitleText: 'linear-gradient(90deg,#0f2142,#3566a8)',
    gradientCard: 'linear-gradient(160deg,#f3f6fb,#ffffff)',
    gradientBadge: 'linear-gradient(135deg,#1f3f74,#0f2142)',
    gradientSection: 'linear-gradient(160deg,rgba(255,255,255,0.9),rgba(31,63,116,0.05))',
    borderSoft: 'rgba(31,63,116,0.15)',
    borderMedium: 'rgba(31,63,116,0.22)',
    borderStrong: 'rgba(31,63,116,0.3)',
    borderLilac: 'rgba(31,63,116,0.12)',
    metaBg: 'rgba(31,63,116,.03)',
    noteBg: 'rgba(31,63,116,.06)',
    serviceBg: 'rgba(31,63,116,.03)',
    rowStripe: 'rgba(31,63,116,.04)',
    imgShadow: '0 12px 32px rgba(31,63,116,.15)',
    // A transparent-background screenshot PNG needs a light fallback backdrop on a light page —
    // the reference file's own figure img background, instead of Kesra's black.
    imgFallbackBg: '#eef2f9',
  },
};

// "الخلفية اسود و الكلام من درجات الاصفر و البرتقالي" — black background, with the brand's
// yellow/orange carrying the accents and title. Colors taken directly from the owner's own
// approved reference report (report-raheqalasal-fastgrowth.html, sent 2026-11-07): headings and
// body text stay white/cream (NOT yellow — an earlier version of this brand guessed bright yellow
// headings, which the reference file corrects), with burnt-orange/gold reserved for accents,
// borders, the badge, table header, and the hero title's gradient-clip text.
export const FAST_GROWTH_BRAND: ReportBrand = {
  id: 'fast_growth',
  footerText: 'Fast Growth',
  palette: {
    pageBg: '#0a0a0a',
    cardBg: '#1c160f',
    accentDeep: '#6b3317',
    accent: '#e2772f',
    accentLight: '#e8c468',
    bodyText: '#f1e6d8',
    headingText: '#ffffff',
    onAccentText: '#ffffff',
    mutedText: '#b8a99a',
    roasGood: '#a9f5c1',
    roasMid: '#f5e29a',
    roasBad: '#f5a3a3',
    // Flat, not a multi-stop gradient — the reference file points these straight at a single
    // token (var(--black)/var(--purple-light)) rather than blending two colors; `background`
    // accepts a plain color just as well as a gradient() function, so this renders correctly
    // either way.
    gradientPage: '#0a0a0a',
    gradientHero: '#0a0a0a',
    gradientTitleText: '#e8c468',
    gradientCard: '#1c160f',
    gradientBadge: '#6b3317',
    gradientSection: '#110d0a',
    borderSoft: 'rgba(226,119,47,0.25)',
    borderMedium: 'rgba(226,119,47,0.35)',
    borderStrong: 'rgba(226,119,47,0.4)',
    borderLilac: 'rgba(232,196,104,0.2)',
    metaBg: 'rgba(255,255,255,.04)',
    noteBg: 'rgba(226,119,47,.08)',
    serviceBg: 'rgba(226,119,47,.05)',
    rowStripe: 'rgba(226,119,47,.05)',
    imgShadow: '0 12px 32px rgba(226,119,47,.15)',
    imgFallbackBg: '#000',
  },
};

const BRANDS_BY_COMPANY: Record<ClientCompanyBrandId, ReportBrand> = {
  kesra: KESRA_BRAND,
  fast_growth: FAST_GROWTH_BRAND,
  top_rate: TOP_RATE_BRAND,
};

// null/undefined/'kesra'/anything unrecognized all resolve to the fixed Kesra identity — never a
// guess: an employee-scope report (which can span several companies) always calls this with
// null/undefined, by its call site's own design, never with a half-determined guess at a company.
export function resolveReportBrand(company?: string | null): ReportBrand {
  if (company && company in BRANDS_BY_COMPANY) {
    return BRANDS_BY_COMPANY[company as ClientCompanyBrandId];
  }
  return KESRA_BRAND;
}
