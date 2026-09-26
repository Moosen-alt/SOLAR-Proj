// IMAGE-ONLY PLAN SETS: read by vision, capped, and labelled as such.
//
// Two of the Iowa City corpus's plan sets (.probe/kin/ia/corpus) were SCANS: the text layer held
// 0 characters, so the text parser had nothing to read and every field came back empty — the
// parser page's own comment said "The plan set is always vector text (pdfjs) — no OCR either
// way", which those two sets disprove.
//
// When the text layer is empty or near-empty, the plan's KEY SHEETS are rendered to images and
// read with the same extraction contract as the text path (llm.extractProjectFields with
// planPageImages). With no text there is nothing to classify sheets by, so the pages are chosen
// by position — the cover/title (page 1), the site plan (page 2), the one-line (about the middle
// of a residential set) and the spec sheets (the last page) — at most MAX_VISION_PAGES pages at a
// modest render scale, which caps the cost of one read. Every field that comes back is listed in
// `visionFields`, the pages in `visionPages`, and the notes say so first, so nobody mistakes a
// vision read of a scan for a text extraction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LLMProvider, ParserLlmExtraction } from "../../shared/src/types";

/** At most this many page images per read (the cost cap). */
export const MAX_VISION_PAGES = 4;
/** Render scale: ~1.4 x 72 dpi keeps a 17x11 sheet legible at a bounded image size. */
export const VISION_RENDER_SCALE = 1.4;
/** A page with fewer letters/digits than this carries no usable text layer. */
const MIN_CHARS_PER_PAGE = 40;

/** Letters/digits in the text, ignoring the "--- PAGE n ---" markers the extractors add. */
export function meaningfulChars(text: string): number {
  return String(text ?? "").replace(/---\s*(?:OCR\s+)?PAGE\s+\d+\s*---/gi, "").replace(/[^A-Za-z0-9]/g, "").length;
}

/** Empty or near-empty text layer for a set of `pageCount` pages. */
export function planTextIsNearEmpty(text: string, pageCount: number): boolean {
  return meaningfulChars(text) < MIN_CHARS_PER_PAGE * Math.max(1, pageCount);
}

/** The pages to read when nothing can be classified: cover, site plan, the middle (the one-line
 *  on a residential set), the last (spec sheets) — distinct, in order, capped. */
export function selectKeySheetPages(pageCount: number, cap = MAX_VISION_PAGES): number[] {
  const n = Math.max(0, Math.floor(pageCount));
  if (!n) return [];
  // A set no longer than the cap is read whole (a 4-page set's one-line is page 3, which the
  // position picks below would skip).
  if (n <= cap) return Array.from({ length: n }, (_, i) => i + 1);
  const picks = [1, 2, Math.max(1, Math.round(n * 0.55)), n].filter((p) => p >= 1 && p <= n);
  return [...new Set(picks)].sort((a, b) => a - b).slice(0, Math.max(1, cap));
}

export interface ScannedPlanRead {
  /** "text" = the text layer is usable; nothing was sent to vision. */
  mode: "text" | "vision";
  pageCount: number;
  textChars: number;
  extraction?: ParserLlmExtraction;
}

/** Read a plan-set PDF: its text layer if it has one; otherwise its key sheets by vision. */
export async function readPlanSetForExtraction(
  llm: Pick<LLMProvider, "extractProjectFields">,
  pdfBytes: Uint8Array,
  opts: { defaultState?: string; maxPages?: number } = {},
): Promise<ScannedPlanRead> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pageCount = doc.getPageCount();
  const { extractLabels } = await import("./formTextLayer");
  const text = (await extractLabels(pdfBytes)).map((l) => l.str).join(" ");
  const textChars = meaningfulChars(text);
  if (!planTextIsNearEmpty(text, pageCount)) return { mode: "text", pageCount, textChars };

  const pages = selectKeySheetPages(pageCount, Math.min(MAX_VISION_PAGES, opts.maxPages ?? MAX_VISION_PAGES));
  const { renderPdfPageToPng } = await import("./pageImages");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scanplan-")), "plan.pdf");
  fs.writeFileSync(tmp, pdfBytes);
  const planPageImages: Array<{ page: number; base64: string; mimeType: "image/png" }> = [];
  try {
    for (const page of pages) {
      const png = await renderPdfPageToPng(tmp, page, VISION_RENDER_SCALE);
      planPageImages.push({ page, base64: png.toString("base64"), mimeType: "image/png" });
    }
  } finally {
    try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* temp */ }
  }
  const result = await llm.extractProjectFields({ planPageImages, defaultState: opts.defaultState });
  const visionFields = Object.keys(result.fields ?? {});
  const lead = `IMAGE-ONLY PLAN SET: the PDF has no usable text layer (${textChars} characters over ${pageCount} page(s)), so pages ${pages.join(", ")} (cover, site plan, one-line, spec — at most ${MAX_VISION_PAGES}) were read by VISION. Every value below came from those images${visionFields.length ? ` (${visionFields.join(", ")})` : " — none was read"}; verify each against the sheet.`;
  return {
    mode: "vision", pageCount, textChars,
    extraction: { ...result, visionFields, visionPages: pages, notes: [lead, result.notes].filter(Boolean).join(" ") },
  };
}
