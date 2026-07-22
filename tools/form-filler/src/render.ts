// Rasterize PDF pages to PNG for the vision-based overlay mapper. Adapted from
// backend/src/pageImages.ts, but renders from in-memory bytes with no disk
// cache and no database. Uses pdfjs-dist (legacy build) + @napi-rs/canvas,
// which ships prebuilt binaries so it installs without a native toolchain.
import { createRequire } from "node:module";

type PdfjsModule = {
  getDocument: (opts: { data: Uint8Array; useSystemFonts?: boolean; disableWorker?: boolean }) => {
    promise: Promise<PdfjsDoc>;
  };
  GlobalWorkerOptions: { workerSrc: string };
};
type PdfjsDoc = { numPages: number; getPage: (n: number) => Promise<PdfjsPage> };
type PdfjsPage = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: { canvasContext: unknown; viewport: unknown; canvas: unknown }) => { promise: Promise<void> };
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
};

// Image-decode warnings (JBig2/JPEG2000/wasm) are harmless for rasterization of
// government forms — drop them so CLI output stays readable.
const PDFJS_WARN_RE = /^Warning: (TT: undefined function:|Font "[^"]+" is not available|getHexString|Indexing all PDF objects|#instantiateWasm|#getJsModule|Unable to decode image|Dependent image isn't ready|.*[Jj]Big2|.*JBIG2|.*wasmUrl|.*nulljbig2|.*OpenJPEG|.*JpxError)/;

let _pdfjs: PdfjsModule | null = null;
async function getPdfjs(): Promise<PdfjsModule> {
  if (!_pdfjs) {
    const mod = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const req = createRequire(import.meta.url);
    const workerPath = req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    mod.GlobalWorkerOptions.workerSrc = `file://${workerPath}`;
    _pdfjs = mod as unknown as PdfjsModule;
  }
  return _pdfjs;
}

async function withQuietWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && PDFJS_WARN_RE.test(args[0])) return;
    origWarn.apply(console, args);
  };
  try {
    return await fn();
  } finally {
    console.warn = origWarn;
  }
}

export interface RenderedPage {
  png: Buffer;
  /** Rendered pixel size (pageSize × scale) — NOT PDF points. */
  width: number;
  height: number;
}

/** Render the first `maxPages` pages to PNG buffers. */
export async function renderPdfPagesToPng(bytes: Uint8Array, maxPages = 3, scale = 1.6): Promise<RenderedPage[]> {
  const { createCanvas } = await import("@napi-rs/canvas" as string);
  const pdfjs = await getPdfjs();
  return withQuietWarnings(async () => {
    // Copy: pdfjs may detach/transfer the buffer it is handed.
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableWorker: true }).promise;
    const n = Math.min(doc.numPages, maxPages);
    const out: RenderedPage[] = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      out.push({ png: canvas.toBuffer("image/png"), width: viewport.width, height: viewport.height });
    }
    return out;
  });
}

/** Extract plain text per page (used by tests to verify overlay draws). */
export async function extractPdfText(bytes: Uint8Array, maxPages = 5): Promise<string[]> {
  const pdfjs = await getPdfjs();
  return withQuietWarnings(async () => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableWorker: true }).promise;
    const n = Math.min(doc.numPages, maxPages);
    const pages: string[] = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => it.str ?? "").join(" "));
    }
    return pages;
  });
}
