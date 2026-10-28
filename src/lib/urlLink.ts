// Shared by BriefFieldsReadOnly.tsx and DynamicBriefForm.tsx's Spreadsheet View — both need to
// turn a free-typed url-field value into a working href. Nothing stops an employee from typing a
// bare domain ("google.com") or non-URL text into a url-typed question — saving is never blocked
// on answer shape (see DynamicBriefForm.tsx) — so this is the one place that decides what actually
// happens when someone clicks it. A value that already carries a scheme is used as-is; a bare
// domain-shaped value (no whitespace) gets https:// prepended so it resolves as a real external
// link instead of a broken relative path within this app; a value with no usable host at all
// (empty after trimming, or containing whitespace — no real URL does) isn't linkified. The
// displayed text is always exactly what was typed — only the underlying href is adjusted.
export const toUrlHref = (rawValue: string): string | null => {
  const trimmed = rawValue.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};
