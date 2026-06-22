import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { AppDb } from "./db";
import type { EvidenceTopic } from "./projectEvidence";
import { extractPdfPages } from "./batchImport";

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

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

// Find the best plan-set PDF for a project: prefer the SLD, then the permit
// application, then any stored PDF. Returns the on-disk path or null.
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
  return byType("sld") || byType("plan_set") || byType("permit_application") || byType("issued_permit") || (rows.find(isPdf) ? s(rows.find(isPdf)!.stored_path) : null);
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
  roofFraming: ["rafter", "truss", "framing", "span", "structural"],
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

// Score every page against a topic + excerpt/hint. Returns the top N 1-based
// page numbers sorted best-first (or an empty array when nothing scores).
export function selectTopPagesForTopic(pages: string[], topic: EvidenceTopic, hint: string, excerpt: string, topN = 3): number[] {
  if (!pages.length) return [];
  const keywords = TOPIC_KEYWORDS[topic] || [];
  const sheetLabel = (hint.match(/\b([A-Z]{1,3}[-\s]?\d{1,2}(?:\.\d{1,2})?)\b/) || [])[1] || "";
  const excerptTokens = new Set(tokenize(excerpt).filter((t) => t.length >= 4));

  const scored: { score: number; page: number }[] = [];
  pages.forEach((text, idx) => {
    const lower = text.toLowerCase();
    let score = 0;
    for (const kw of keywords) if (lower.includes(kw)) score += 2;
    if (sheetLabel && lower.includes(sheetLabel.toLowerCase())) score += 6;
    if (excerptTokens.size) {
      const pageTokens = new Set(tokenize(text));
      let overlap = 0;
      for (const t of excerptTokens) if (pageTokens.has(t)) overlap += 1;
      score += Math.min(8, overlap);
    }
    if (score > 0) scored.push({ score, page: idx + 1 });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((s) => s.page);
}

// Convenience wrapper — returns only the best page (or null).
export function selectPageForTopic(pages: string[], topic: EvidenceTopic, hint: string, excerpt: string): number | null {
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
