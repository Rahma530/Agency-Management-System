// Shared image-embedding helper: turns an attachment URL into an inline, portable asset (a data:
// URI, fetched once and kept in memory) instead of leaving it as a bare clickable link. Extracted
// out of pdfExport.ts's original loadEmbeddableImages so every report-export format (the existing
// jsPDF `pdfExport.ts`, and the new `reportHtmlExport.ts`) shares the exact same Content-Type
// sniffing, size cap, and format allowlist — never two copies that could silently drift apart.
//
// Deliberately conservative, same as the original: a link that isn't a real raster image (decided
// by the response's ACTUAL Content-Type, never guessed from the URL's file extension — a signed
// Storage URL's path is not a reliable content-type signal), fails to fetch, or is over the byte
// cap is simply left out of the returned map. Every caller treats "missing from the map" as "fall
// back to a plain link," never as an error — nothing here can turn a working export into a broken
// one.
//
// 2026-11-26 audit (owner-reported: "report images don't show, a long raw link shows instead"):
// two real gaps in this allowlist, found by comparing it against what a task attachment is
// actually allowed to BE (taskAttachmentValidation.ts's TASK_ATTACHMENT_ALLOWED_MIME_TYPES) —
// GIF and SVG screenshots upload and attach to a task completely normally, but neither format was
// in this map, so EVERY GIF/SVG attachment silently fell back to a link, 100% of the time, not
// just occasionally. Both are added below. GIF/SVG are NOT added to jsPDF's own supported-format
// set in pdfExport.ts (jsPDF's addImage has no SVG/GIF support) — see that file's own comment for
// how the (currently unused/hidden) PDF export degrades gracefully for just those two formats
// instead of either crashing or silently mislabeling a link as "View image" when no image was
// actually drawn.
export const EMBEDDABLE_IMAGE_FORMATS: Record<string, 'JPEG' | 'PNG' | 'WEBP' | 'GIF' | 'SVG'> = {
  'image/jpeg': 'JPEG',
  'image/jpg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'image/gif': 'GIF',
  'image/svg+xml': 'SVG',
};
export const MAX_EMBEDDED_IMAGES = 30; // a generous ceiling against a pathologically image-heavy report
// 2026-11-26: raised from 8MB. Task attachments themselves are allowed up to 50MB
// (TASK_ATTACHMENT_MAX_BYTES), so a real, un-shrunk phone-camera photo (routinely 8-20MB on a
// modern phone) uploaded fine as a task attachment but was then silently dropped from every report
// export — the single biggest real-world cause of "the report has no pictures" reports. 20MB
// comfortably covers an ordinary photo/screenshot while still rejecting the rare pathological case
// (and a genuinely 20MB+ "screenshot" is almost certainly the wrong file attached to the task in
// the first place, not something a report should try to silently inline anyway).
export const MAX_EMBEDDED_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB

export interface EmbeddedImageAsset {
  format: 'JPEG' | 'PNG' | 'WEBP' | 'GIF' | 'SVG';
  dataUrl: string;
  widthPx: number;
  heightPx: number;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImagePixelSize(dataUrl: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Resolves whichever of `urls` turn out to be an embeddable raster image, keyed by the exact URL
// string so a caller can look each one up by the same link it already has in its own text. Caps
// at MAX_EMBEDDED_IMAGES candidates (first N after de-duplication) — a caller that cares about
// WHICH N (e.g. "the first images in reading order") should pass `urls` already in that order.
export async function resolveEmbeddableImages(urls: Iterable<string>): Promise<Map<string, EmbeddedImageAsset>> {
  const assets = new Map<string, EmbeddedImageAsset>();
  const candidates = [...new Set(urls)].slice(0, MAX_EMBEDDED_IMAGES);
  await Promise.all(candidates.map(async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const format = EMBEDDABLE_IMAGE_FORMATS[contentType];
      if (!format) return;
      const blob = await res.blob();
      if (blob.size > MAX_EMBEDDED_IMAGE_BYTES) return;
      const dataUrl = await readBlobAsDataUrl(blob);
      const size = await loadImagePixelSize(dataUrl);
      if (!size) return;
      assets.set(url, { format, dataUrl, widthPx: size.width, heightPx: size.height });
    } catch (err) {
      console.error(`Could not embed image from ${url}, leaving it as a plain link:`, err);
    }
  }));
  return assets;
}
