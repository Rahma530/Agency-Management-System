// Same render-and-inspect pattern as checkPdfLinkAnnotations.ts: builds a real PDF via the actual
// exported buildReportDoc and inspects the raw bytes. loadEmbeddableImages itself (fetch/Image/
// FileReader) is browser-only and not exercised here, same accepted gap as loadArabicFontBundle's
// own network path — this checks buildReportDoc's synchronous, testable half: given an already-
// resolved imageAssets map, does it actually embed the picture, keep the link line either way, and
// leave a link with no matching asset exactly as it rendered before this feature existed.
import fs from 'node:fs';
import { buildReportDoc, ArabicFontBundle, EmbeddedImageAsset } from '../src/lib/pdfExport';

function loadFontBundle(): ArabicFontBundle {
  const normal = fs.readFileSync('public/fonts/NotoNaskhArabic-Regular.ttf').toString('base64');
  const bold = fs.readFileSync('public/fonts/NotoNaskhArabic-Bold.ttf').toString('base64');
  return { name: 'NotoNaskhArabic', normal, bold };
}

// A real, valid, minimal 1x1 transparent PNG — jsPDF decodes the actual bytes (to confirm it's a
// real PNG) even though the asset's own widthPx/heightPx below (not re-derived from these bytes)
// are what buildReportDoc actually draws at, same as the real pipeline: loadEmbeddableImages reads
// pixel size once via an offscreen Image() load and hands buildReportDoc the number, never asking
// it to redecode dimensions itself.
const ONE_PX_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function countMatches(pdfBytes: Uint8Array, pattern: RegExp): number {
  const matches = Buffer.from(pdfBytes).toString('latin1').match(pattern);
  return matches ? matches.length : 0;
}

const fontBundle = loadFontBundle();
const IMAGE_URL = 'https://example-storage.test/task-attachments/abc/photo.jpg';
const NON_IMAGE_URL = 'https://example-storage.test/task-attachments/abc/notes.pdf';

// 1) A link resolved to an embeddable image gets a real embedded /Subtype /Image XObject — AND
// keeps its plain clickable link line underneath, exactly as before this feature existed.
{
  const asset: EmbeddedImageAsset = { format: 'PNG', dataUrl: ONE_PX_PNG, widthPx: 1000, heightPx: 500 };
  const doc = buildReportDoc(fontBundle, {
    filename: 'test.pdf',
    title: 'عميل تجريبي',
    paragraphs: [{ heading: 'Work logs (primary source)', body: `Sara: رفعت التصميم ${IMAGE_URL}` }],
  }, new Map([[IMAGE_URL, asset]]));
  const pdfBytes = new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
  if (countMatches(pdfBytes, /\/Subtype\s*\/Image/g) < 1) throw new Error('An embeddable image must produce a real /Subtype /Image object, not just a link.');
  if (countMatches(pdfBytes, /\/Subtype\s*\/Link/g) < 1) throw new Error('The clickable link line must still be drawn even when the image is also embedded.');
  console.log('OK (1/2): a link resolved to an embeddable image is drawn as a real embedded picture AND keeps its clickable link line.');
}

// 2) A link with NO matching imageAssets entry (a non-image attachment, a failed fetch, an
// unsupported format, or simply no map at all) renders EXACTLY as it did before this feature —
// a plain clickable link line, never an image object.
{
  const doc = buildReportDoc(fontBundle, {
    filename: 'test.pdf',
    title: 'عميل تجريبي',
    paragraphs: [{ heading: 'Work logs (primary source)', body: `Sara: رفعت الملف ${NON_IMAGE_URL}` }],
  }); // no imageAssets argument at all — must behave identically to every PDF built before this feature
  const pdfBytes = new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
  if (countMatches(pdfBytes, /\/Subtype\s*\/Image/g) !== 0) throw new Error('A link with no resolved image asset must never produce an embedded image object.');
  if (countMatches(pdfBytes, /\/Subtype\s*\/Link/g) < 1) throw new Error('The link line itself must still be drawn.');
  console.log('OK (2/2): a link with no resolved image asset (or no imageAssets map at all) renders exactly as a plain link, unchanged from before this feature.');
}
