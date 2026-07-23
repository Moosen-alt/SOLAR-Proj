// ---------------------------------------------------------------------------
// Standalone form-filler tool — deliberately decoupled from projects/DB/LLM.
// Upload any flat AHJ/utility form (PDF, or DOCX converted via LibreOffice),
// place text values by coordinate, and download the filled PDF. Reuses pdf-lib
// (already a dependency); the browser does rendering + placement, the server
// does DOCX→PDF conversion and the final overlay draw (kept server-side so the
// coordinate math is unit-tested).
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/** A single text value drawn on a page. Coordinates are PDF points with the
 *  ORIGIN AT THE BOTTOM-LEFT (pdf-lib's native convention); the browser converts
 *  from its top-left screen space before sending. page is 0-indexed. */
export interface Placement {
  page: number;
  x: number;
  y: number;
  text: string;
  size?: number;
}

const PDF_MAGIC = Buffer.from("%PDF-");

export function isPdf(bytes: Buffer | Uint8Array): boolean {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return b.length > 5 && b.subarray(0, 5).equals(PDF_MAGIC);
}

/** Inspect an uploaded PDF: page count + per-page point dimensions, so the
 *  browser can render at a matching scale and map clicks back to PDF points. */
export async function inspectPdf(bytes: Uint8Array): Promise<{ pageCount: number; pages: { width: number; height: number }[] }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
  return { pageCount: pages.length, pages };
}

/** Draw the placements onto the PDF and return the filled bytes. Out-of-range
 *  pages and non-finite coordinates are skipped rather than throwing, so one bad
 *  placement can never nuke the whole fill. */
export async function overlayText(bytes: Uint8Array, placements: Placement[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (const p of placements) {
    if (!Number.isInteger(p.page) || p.page < 0 || p.page >= pages.length) continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const text = String(p.text ?? "");
    if (!text) continue;
    const size = Number.isFinite(p.size) && (p.size as number) > 0 ? (p.size as number) : 11;
    pages[p.page].drawText(text, { x: p.x, y: p.y, size, font, color: rgb(0.06, 0.06, 0.06) });
  }
  return doc.save();
}

const SOFFICE_BIN = process.env.SOFFICE_BIN || "soffice";

/** Convert a DOCX/DOC buffer to PDF via LibreOffice headless. Throws a clear,
 *  actionable error (never a raw spawn failure) when LibreOffice isn't available
 *  so the UI can tell the operator to upload a PDF instead. Requires `soffice`
 *  on the host (added to the Docker image); verify on the real deploy. */
export async function convertDocxToPdf(docxBytes: Uint8Array): Promise<Uint8Array> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "formfill-"));
  const inPath = path.join(workdir, "in.docx");
  const outPath = path.join(workdir, "in.pdf");
  fs.writeFileSync(inPath, docxBytes);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        SOFFICE_BIN,
        ["--headless", `-env:UserInstallation=file://${path.join(workdir, "profile")}`, "--convert-to", "pdf", "--outdir", workdir, inPath],
        { timeout: 120_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    if (!fs.existsSync(outPath)) {
      throw new Error("conversion produced no PDF");
    }
    return new Uint8Array(fs.readFileSync(outPath));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `DOCX→PDF conversion failed (${msg}). LibreOffice (soffice) must be installed on the server; otherwise save the form as PDF and upload that instead.`,
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}
