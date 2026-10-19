// Shared between pdfExport.ts (renders a link on its own clickable LTR line below a paragraph/
// bullet/table cell) and the work_items AI-rephrasing pipeline in ComparisonDisplay.tsx
// (runWorkItemBatches strips a link out before sending text to ai-router, and reattaches it
// unchanged afterward by id) — one definition of what counts as a link and how it's separated
// from/reattached to a line of text, so both sides agree exactly on the shape.
export const URL_RE = /https?:\/\/[^\s)»"'<>]+/g;

// Pulls every URL out of `text`, returning the links in their original order and the remaining
// text with them removed and any whitespace they leave behind collapsed (never just left as a
// gap, and never dropping adjacent punctuation). `links` is empty when there's nothing to find —
// callers should treat that as "nothing to draw/strip", not an error.
export function extractLinks(text: string): { cleanText: string; links: string[] } {
  const links = text.match(URL_RE) || [];
  if (links.length === 0) return { cleanText: text, links: [] };
  const cleanText = text
    .replace(URL_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { cleanText, links };
}

// The inverse of extractLinks: appends each link on its own line below `text`, exactly the shape
// extractLinks expects to find and pull back out again later (e.g. pdfExport.ts's own paragraph/
// bullet drawing, once this text reaches the PDF).
export function reattachLinks(text: string, links: string[]): string {
  if (links.length === 0) return text;
  return [text, ...links].join('\n');
}
