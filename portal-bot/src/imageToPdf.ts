// A PHOTO THE PORTAL WILL ACCEPT.
//
// PacifiCorp's page 7 asks for "Upload a photo of meter where system will be interconnected"
// and then declares `accept=".docx, .pdf"` — it wants a photograph, but not as an image file.
// Our meter photo is a .jpg, the accept-list guard correctly refused it, and the required
// upload stayed empty until the utility rejected the submission naming that field. Operators
// already work around this by hand (there are jpg-to-pdf zips in the downloads folder).
//
// So when a slot will not take the image but will take a PDF, wrap the image in one. This
// changes the CONTAINER, never the content: one page, the photograph at its own aspect ratio,
// nothing added and nothing recompressed.

import fs from "node:fs";
import path from "node:path";

const IMAGE_EXT = /\.(jpe?g|png)$/i;

/** Images pdf-lib can embed directly. HEIC/TIFF/WebP are NOT convertible here — better to
 *  report an unfilled slot than to ship a PDF containing a broken image. */
export function isConvertibleImage(filePath: string): boolean {
  return IMAGE_EXT.test(filePath);
}

/** Does this accept list take a PDF? (An empty list means unrestricted, so yes.) */
export function acceptsPdf(accept: string): boolean {
  const list = String(accept || "").trim();
  if (!list) return true;
  return /(^|[,\s])\.pdf(\s*[,;]|\s*$)/i.test(list) || /application\/pdf/i.test(list) || /\*\/\*/.test(list);
}

/**
 * True when the slot refuses this file but would take it as a PDF — i.e. converting is the
 * difference between a filled required upload and an empty one.
 */
export function shouldConvertToPdf(filePath: string, accept: string, alreadyAllowed: boolean): boolean {
  if (alreadyAllowed) return false;
  if (!String(accept || "").trim()) return false; // unrestricted slots never needed converting
  return isConvertibleImage(filePath) && acceptsPdf(accept);
}

/** Wrap an image file in a single-page PDF sized to the image. Returns the PDF bytes. */
export async function imageToPdfBytes(filePath: string): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const bytes = fs.readFileSync(filePath);
  const doc = await PDFDocument.create();
  const ext = path.extname(filePath).toLowerCase();
  const image = ext === ".png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  // The page IS the photograph — no letterboxing, no scaling decisions to get wrong.
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return Buffer.from(await doc.save());
}

/** The filename to present, with the extension swapped for .pdf. */
export function pdfNameFor(filePath: string): string {
  const base = path.basename(filePath);
  return `${base.replace(IMAGE_EXT, "")}.pdf`;
}
