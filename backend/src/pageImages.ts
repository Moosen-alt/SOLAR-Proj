import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { AppDb } from "./db";
import type { EvidenceTopic } from "./projectEvidence";
import { extractPdfPages } from "./batchImport";
import { text as s } from "./json";

// ---------------------------------------------------------------------------
// Source-page image rendering for the AHJ Reviewer Gate "screenshot crop slot".
//
// The reviewer report cites text evidence found in the parsed plan set. This
// module renders the actual source PDF page behind that evidence to a PNG so
// the reviewer sees the sheet, not just an excerpt. Renders are cached on disk
// (keyed by source mtime) so re-opening the report is cheap.
//
// Rasterization uses pdfjs-dist (already a dependency, for text extraction) plus
// @napi-rs/canvas, which ships prebuilt binaries (incl. win32-x64-msvc) so it
// installs without a native toolchain on the operator's Windows box.
// ---------------------------------------------------------------------------

const CACHE_DIR = path.resolve(process.cwd(), process.env.PAGE_IMAGE_CACHE_DIR || "backend/data/page-images");

type PdfjsRenderModule = {
  getDocument: (opts: { data: Uint8Array; useSystemFonts?: boolean; disableWorker?: boolean }) => { promise: Promise<PdfjsRenderDoc> };
  GlobalWorkerOptions: { workerSrc: string };
};
type PdfjsRenderDoc = { numPages: number; getPage: (n: number) => Promise<PdfjsRenderPage> };
type PdfjsRenderPage = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: { canvasContext: unknown; viewport: unknown; canvas: unknown }) => { promise: Promise<void> };
};

// See batchImport.ts — JBig2/JPEG2000/wasm image-decode warnings are harmless for our
// text + raster pipeline (we fall back to the page's vector/text content), so drop them.
const PDFJS_WARN_RE = /^Warning: (TT: undefined function:|Font "[^"]+" is not available|getHexString|Indexing all PDF objects|#instantiateWasm|#getJsModule|Unable to decode image|Dependent image isn't ready|.*[Jj]Big2|.*JBIG2|.*wasmUrl|.*nulljbig2|.*OpenJPEG|.*JpxError)/;

let _pdfjs: PdfjsRenderModule | null = null;
async function getPdfjs(): Promise<PdfjsRenderModule> {
  if (!_pdfjs) {
    const mod = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const req = createRequire(import.meta.url);
    const workerPath = req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    mod.GlobalWorkerOptions.workerSrc = `file://${workerPath}`;
    _pdfjs = mod as unknown as PdfjsRenderModule;
  }
  return _pdfjs;
}


// Find the best plan-set PDF for a project: the full plan set first, then a
// standalone SLD, the permit application, then any stored PDF. Path or null.
export function findPlanSetPdf(db: AppDb, projectId: string): string | null {
  const rows = db.query<Record<string, unknown>>(
    "SELECT doc_type, stored_path, content_type, original_filename FROM project_documents WHERE project_id = ? ORDER BY uploaded_at DESC",
    [projectId],
  );
  const isPdf = (row: Record<string, unknown>): boolean => {
    const ct = s(row.content_type).toLowerCase();
    const name = s(row.original_filename).toLowerCase();
    const p = s(row.stored_path);
    return Boolean(p) && fs.existsSync(p) && (ct.includes("pdf") || name.endsWith(".pdf") || p.toLowerCase().endsWith(".pdf"));
  };
  const byType = (type: string): string | null => {
    const hit = rows.find((row) => s(row.doc_type) === type && isPdf(row));
    return hit ? s(hit.stored_path) : null;
  };
  // PLAN SET FIRST. The old ladder led with "sld", which was harmless while a
  // standalone SLD only existed when an operator uploaded one — but the auto-split
  // chain now guarantees every project a 1-2 page `sld` SPLIT PART, newest row wins,
  // and every vision crop for every topic (rafter spans included) rendered the
  // electrical 3-line. The full plan set is a superset of every split; page
  // selection narrows within it. "sld" stays as the fallback for the project whose
  // ONLY document is a standalone SLD upload.
  return byType("plan_set") || byType("sld") || byType("permit_application") || byType("issued_permit") || (rows.find(isPdf) ? s(rows.find(isPdf)!.stored_path) : null);
}

// Find a stored document by its doc_type (e.g. "meter_photo", "utility_bill").
// Returns the on-disk path + whether it is a PDF, or null. Used so evidence that
// lives in a STANDALONE uploaded file (the meter photo, the utility bill) renders
// that file — not a page of the plan set.
function findDocByType(db: AppDb, projectId: string, docTypes: string[]): { path: string; isPdf: boolean } | null {
  const rows = db.query<Record<string, unknown>>(
    "SELECT doc_type, stored_path, content_type, original_filename FROM project_documents WHERE project_id = ? ORDER BY uploaded_at DESC",
    [projectId],
  );
  for (const type of docTypes) {
    const hit = rows.find((row) => s(row.doc_type) === type && Boolean(s(row.stored_path)) && fs.existsSync(s(row.stored_path)));
    if (hit) {
      const ct = s(hit.content_type).toLowerCase();
      const name = s(hit.original_filename).toLowerCase();
      const p = s(hit.stored_path);
      const isPdf = ct.includes("pdf") || name.endsWith(".pdf") || p.toLowerCase().endsWith(".pdf");
      return { path: p, isPdf };
    }
  }
  return null;
}

// Topics whose evidence is a standalone uploaded file rather than a plan-set page.
const TOPIC_DOC_TYPES: Partial<Record<EvidenceTopic, string[]>> = {
  meterPhoto: ["meter_photo"],
  accountVerification: ["utility_bill"],
};

// Keywords used to score which page best matches a reviewer topic. Light-weight
// on purpose — the sheet label from the pageHint and the excerpt do most of the
// disambiguation; these are the fallback signal.
const TOPIC_KEYWORDS: Record<EvidenceTopic, string[]> = {
  accountVerification: ["account", "utility bill", "service address"],
  meterPhoto: ["meter", "service tag"],
  sld: ["single line", "one line", "3-line", "three line", "sld", "705", "interconnection", "rapid shutdown", "inverter", "msp", "main service panel", "ocpd", "breaker"],
  siteRoofPlan: ["site plan", "roof plan", "plot plan", "array", "layout", "setback"],
  firePathway: ["fire", "pathway", "setback", "ridge", "eave", "access"],
  roofFraming: ["rafter", "truss", "framing", "span", "structural", "roof section", "bearing wall", "o.c."],
  rackingAttachment: ["racking", "attachment", "standoff", "lag", "flashing", "rail", "mounting"],
  structuralLoads: ["snow", "dead load", "wind", "psf", "slope"],
  rapidShutdown: ["rapid shutdown", "rsd", "690.12", "initiator"],
  labels: ["label", "placard", "directory", "705.10"],
  inverterSettings: ["ul 1741", "smart inverter", "ieee 1547", "inverter settings", "spec", "datasheet"],
  batteryMode: ["battery", "ess", "powerwall", "encharge", "backup", "export"],
  utilityApproval: ["utility approval", "interconnection", "approval letter"],
  ownerAuthorization: ["signature", "owner authorization", "signed", "notary"],
};

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9.]{2,}/g) || [];
}

// THE SHEET'S OWN NAME. A plan sheet's title block carries its name as a bare text run —
// extracted text separates runs with two or more spaces, and on the real f7d7af7e set the
// title-block cell reads exactly "3-LINE DIAGRAM" on E 1.1 and exactly "NOTES" on E 1.2. A
// notes sheet listing BOTH 705.12 load-side and 705.11 supply-side options, OCPD and rapid
// shutdown matches every sld keyword, and it outranked the diagram it describes; the picker
// then cropped boilerplate as the "evidence" for a supply-side tap. A diagram sheet is the
// one whose NAME is the diagram, not the one that says the most electrical words.
//
// Only a WHOLE run counts: the sheet index lists "3-LINE DIAGRAM E 1.2:" and a notes body
// says "SEE 3-LINE DIAGRAM", and neither is a sheet named that.
const TOPIC_SHEET_TITLES: Partial<Record<EvidenceTopic, RegExp>> = {
  sld: /^(?:(?:3|three|one|single)[-\s]?line|electrical|riser)\s+diagram$/i,
};
// A sheet NAMED notes is boilerplate for a drawing topic — it describes every option the
// diagram might take, so it can never be the drawing.
// No trailing colon: "PHOTOVOLTAIC NOTES:" is a heading over a notes BLOCK, which a diagram
// sheet may well carry; the title-block cell naming the sheet has no colon.
const NOTES_SHEET_TITLE = /^(?:(?:general|electrical|site|pv|photovoltaic)\s+)?notes$/i;

function sheetRuns(text: string): string[] {
  return text.split(/\s{2,}|\n/).map((run) => run.trim()).filter(Boolean);
}

// Score every page against a topic + excerpt/hint. Returns the top N 1-based
// page numbers sorted best-first (or an empty array when nothing scores).
export function selectTopPagesForTopic(pages: string[], topic: EvidenceTopic, hint: string, excerpt: string, topN = 3): number[] {
  if (!pages.length) return [];
  const sheetLabel = (hint.match(/\b([A-Z]{1,3}[-\s]?\d{1,2}(?:\.\d{1,2})?)\b/) || [])[1] || "";
  // THE TITLE BLOCK IS ON EVERY PAGE, so it is evidence for none of them. A token present on
  // every page of a multi-page set (company name, phone, address, revision date, "INVERTER"
  // in a project-summary strip) cannot tell pages apart; counting it only rewards the page
  // with the most text. A one-page set is exempt — there, every token is "common".
  const pageTokenSets = pages.map((text) => new Set(tokenize(text)));
  const everyPage = new Set<string>(
    pages.length >= 2 ? [...pageTokenSets[0]].filter((t) => pageTokenSets.every((set) => set.has(t))) : [],
  );
  const onEveryPage = (phrase: string): boolean => {
    const tokens = tokenize(phrase);
    return tokens.length > 0 && tokens.every((t) => everyPage.has(t)) && pages.every((p) => p.toLowerCase().includes(phrase));
  };
  const keywords = (TOPIC_KEYWORDS[topic] || []).filter((kw) => !onEveryPage(kw));
  const excerptTokens = new Set(tokenize(excerpt).filter((t) => t.length >= 4 && !everyPage.has(t)));
  const titleRe = TOPIC_SHEET_TITLES[topic];
  // THE PAGE THAT HOLDS THE QUOTE. An evidence excerpt now LEADS with the matched text
  // (projectEvidence.matchSources), so its opening words are a literal quote of one sheet.
  // The longest opening that some page contains names the page the evidence came from —
  // "SNOW LOAD: 16 PSF" sits on a cover that also carries the sheet index, and without this
  // the index penalty handed that crop to the plot plan. An opening shorter than 12 characters
  // is too generic to be a quote, and an excerpt whose opening is on EVERY page (title-block
  // text) favours none of them.
  const flat = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();
  const flatPages = pages.map(flat);
  const quote = flat(excerpt);
  let quotePages = new Set<number>();
  for (let len = Math.min(60, quote.length); len >= 12; len--) {
    const prefix = quote.slice(0, len);
    const holders = flatPages.map((p, i) => (p.includes(prefix) ? i : -1)).filter((i) => i >= 0);
    if (holders.length) {
      if (holders.length < pages.length || pages.length === 1) quotePages = new Set(holders);
      break;
    }
  }

  const scored: { score: number; page: number }[] = [];
  pages.forEach((text, idx) => {
    const lower = text.toLowerCase();
    let score = 0;
    // Not skipped on a sheet-index page: on a real Salem set the 3-line sheet itself carries the
    // index block, and its index ENTRIES ("3-LINE DIAGRAM E 1.2:") are never a whole run.
    if (titleRe) {
      const runs = sheetRuns(text);
      if (runs.some((run) => titleRe.test(run))) score += 12;
      else if (runs.some((run) => NOTES_SHEET_TITLE.test(run))) score -= 8;
    }
    // THE SHEET-INDEX PAGE MATCHES EVERYTHING. The cover/first sheet lists every sheet NAME,
    // so it scores for every topic and its sheer token count swallows excerpt overlap — on a
    // real Salem plan set the ELECTRICAL 3-line (which carries the index block) ranked in the
    // roofFraming top-3 while the actual ROOF SECTION sheet did not, and the vision pass then
    // confidently reported "no structural info on this sheet" about a sheet nobody should
    // have been looking at. Same guard the doc splitter has carried all along.
    if (/sheet\s*index/.test(lower)) score -= 8;
    for (const kw of keywords) if (lower.includes(kw)) score += 2;
    if (sheetLabel && lower.includes(sheetLabel.toLowerCase())) score += 6;
    if (excerptTokens.size) {
      const pageTokens = pageTokenSets[idx];
      let overlap = 0;
      for (const t of excerptTokens) if (pageTokens.has(t)) overlap += 1;
      score += Math.min(8, overlap);
    }
    if (quotePages.has(idx)) score += 14;
    if (score > 0) scored.push({ score, page: idx + 1 });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((s) => s.page);
}

// Convenience wrapper — returns only the best page (or null).
function selectPageForTopic(pages: string[], topic: EvidenceTopic, hint: string, excerpt: string): number | null {
  const top = selectTopPagesForTopic(pages, topic, hint, excerpt, 1);
  return top.length > 0 ? top[0] : null;
}

function cachePathFor(pdfPath: string, page: number, scale: number): string {
  const stat = fs.statSync(pdfPath);
  const base = path.basename(pdfPath).replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(CACHE_DIR, `${base}-p${page}-s${Math.round(scale * 100)}-m${Math.round(stat.mtimeMs)}.png`);
}

// Render one page of a PDF to a PNG buffer, caching the result on disk.
export async function renderPdfPageToPng(pdfPath: string, page: number, scale = 1.6): Promise<Buffer> {
  const cachePath = cachePathFor(pdfPath, page, scale);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);

  const { createCanvas } = await import("@napi-rs/canvas" as string);
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(pdfPath));

  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && PDFJS_WARN_RE.test(args[0])) return;
    origWarn.apply(console, args);
  };
  try {
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true, disableWorker: true }).promise;
    const target = Math.min(Math.max(1, page), doc.numPages);
    const pdfPage = await doc.getPage(target);
    const viewport = pdfPage.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    await pdfPage.render({ canvasContext: ctx, viewport, canvas }).promise;
    const buffer = canvas.toBuffer("image/png");
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, buffer);
    return buffer;
  } finally {
    console.warn = origWarn;
  }
}

/** How a page is rendered for a VISION read (scannedPlanSet.ts). */
export interface VisionRenderOptions {
  /** Longest edge of the output image, px. */
  maxLongEdge: number;
  /** Output area ceiling, px (the model downscales anything larger, so more buys nothing). */
  maxPixels: number;
  /** Never render above this scale (a tiny page must not become a huge upscale). Default 4. */
  maxScale?: number;
  /** Clockwise degrees applied AFTER rendering, to turn a sideways sheet upright. */
  rotate?: 0 | 90 | 180 | 270;
  /** JPEG quality 1-100 (default 85). Page images go as JPEG: a 3.6 MP scan as PNG runs to
   *  several MB, over the per-image byte cap, where the same page as JPEG is ~1 MB. */
  quality?: number;
}

export interface VisionRender {
  page: number;
  bytes: Buffer;
  width: number;
  height: number;
  scale: number;
  mimeType: "image/jpeg";
}

/** The scale that fits a `w` x `h` point page inside the vision limits. */
export function visionRenderScale(w: number, h: number, opts: Pick<VisionRenderOptions, "maxLongEdge" | "maxPixels" | "maxScale">): number {
  const longEdge = Math.max(1, w, h);
  const area = Math.max(1, w * h);
  return Math.max(0.05, Math.min(opts.maxScale ?? 4, opts.maxLongEdge / longEdge, Math.sqrt(opts.maxPixels / area)));
}

/** Open a PDF (bytes — nothing touches the disk cache) and render pages from it for a VISION
 *  read: fitted to the model's image limits, turned upright, JPEG-encoded. One parse of the PDF
 *  serves every page; call close() when done. */
export async function openPdfForVisionRender(pdfBytes: Uint8Array): Promise<{
  numPages: number;
  render: (page: number, opts: VisionRenderOptions) => Promise<VisionRender>;
  close: () => Promise<void>;
}> {
  const { createCanvas } = await import("@napi-rs/canvas" as string);
  const pdfjs = await getPdfjs();
  const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string" && PDFJS_WARN_RE.test(args[0])) return;
      origWarn.apply(console, args);
    };
    return fn().finally(() => { console.warn = origWarn; });
  };
  // pdfjs may detach the buffer it is given — hand it a copy.
  const doc = await quiet(() => pdfjs.getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true, disableWorker: true }).promise);
  return {
    numPages: doc.numPages,
    render: (page, opts) => quiet(async () => {
      const target = Math.min(Math.max(1, Math.floor(page)), doc.numPages);
      const pdfPage = await doc.getPage(target);
      const unit = pdfPage.getViewport({ scale: 1 });
      const scale = visionRenderScale(unit.width, unit.height, opts);
      const viewport = pdfPage.getViewport({ scale });
      // floor, not ceil: the area must stay inside maxPixels (a sub-pixel sliver is all it costs).
      const w = Math.max(1, Math.floor(viewport.width)), h = Math.max(1, Math.floor(viewport.height));
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext("2d");
      // JPEG has no alpha: a transparent page background would encode black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      await pdfPage.render({ canvasContext: ctx, viewport, canvas }).promise;
      const rot = opts.rotate ?? 0;
      let out = canvas;
      if (rot === 90 || rot === 180 || rot === 270) {
        const swap = rot !== 180;
        out = createCanvas(swap ? h : w, swap ? w : h);
        const octx = out.getContext("2d");
        octx.translate(out.width / 2, out.height / 2);
        octx.rotate((rot * Math.PI) / 180);
        octx.drawImage(canvas, -w / 2, -h / 2);
      }
      const bytes: Buffer = out.toBuffer("image/jpeg", Math.max(1, Math.min(100, Math.round(opts.quality ?? 85))));
      return { page: target, bytes, width: out.width, height: out.height, scale, mimeType: "image/jpeg" as const };
    }),
    close: async () => { try { await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.(); } catch { /* best effort */ } },
  };
}

// Top-level helper for the evidence-image endpoint: locate the plan set, pick
// the page that backs this topic's evidence, and render it. Returns null when
// there is no plan-set PDF or no page scores — the report then falls back to the
// text hint placeholder.
export async function renderEvidenceImage(
  db: AppDb,
  projectId: string,
  topic: EvidenceTopic,
  hint: string,
  excerpt: string,
): Promise<Buffer | null> {
  // Meter photo / utility bill evidence is a standalone uploaded file — render
  // THAT, not a page of the plan set (which was showing the plot plan for the
  // meter-photo crop slot).
  const docTypes = TOPIC_DOC_TYPES[topic];
  if (docTypes) {
    const doc = findDocByType(db, projectId, docTypes);
    if (doc) {
      try {
        if (doc.isPdf) return await renderPdfPageToPng(doc.path, 1);
        // Image file (jpg/png) — return the bytes directly.
        return fs.readFileSync(doc.path);
      } catch {
        return null;
      }
    }
    // No standalone file stored for this topic — don't fall back to the plan set
    // (that's what caused the wrong-sheet crop). Show the text hint instead.
    return null;
  }

  const pdfPath = findPlanSetPdf(db, projectId);
  if (!pdfPath) return null;
  let pages: string[];
  try {
    pages = await extractPdfPages(pdfPath, 60);
  } catch {
    return null;
  }
  const page = selectPageForTopic(pages, topic, hint, excerpt) || 1;
  try {
    return await renderPdfPageToPng(pdfPath, page);
  } catch {
    return null;
  }
}
