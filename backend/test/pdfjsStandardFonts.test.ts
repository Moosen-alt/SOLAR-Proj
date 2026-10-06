// #207 — every server-side pdfjs getDocument() carries `standardFontDataUrl`, so a page drawn in a
// NON-EMBEDDED standard font renders without "Warning: UnknownErrorException: Ensure that the
// `standardFontDataUrl` API parameter is provided." (once per font per document; dozens per project).
//
// The fixture is built here with pdf-lib: Symbol and ZapfDingbats are referenced, never embedded,
// and pdfjs has no system substitute for them even with useSystemFonts — the case that warned.
//
// KILL TESTS (each verified red by hand):
//   K1 pdfjsDocumentOptions returns the options without standardFontDataUrl → (h1), (r1), (r2) fail.
//   K2 one call site goes back to a bare getDocument({...})                  → (h2) fails.
//
// Run: npx tsx backend/test/pdfjsStandardFonts.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { pdfjsDocumentOptions, pdfjsStandardFontDataUrl } = await import("../src/pdfjsOptions");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const FONT_WARNING = /standardFontDataUrl/;
/** Every console.warn / console.log line printed while `fn` runs (pdfjs warns through console). */
async function captureConsole(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const ow = console.warn, ol = console.log;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.warn = ow; console.log = ol; }
  return lines;
}

async function nonEmbeddedFontPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 200]);
  page.drawText("Synthetic permit form", { x: 20, y: 160, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  page.drawText("αβγ", { x: 20, y: 120, size: 14, font: await pdf.embedFont(StandardFonts.Symbol) });
  page.drawText("✁✂", { x: 20, y: 80, size: 14, font: await pdf.embedFont(StandardFonts.ZapfDingbats) });
  return pdf.save();
}
const fixture = await nonEmbeddedFontPdf();

await check("(h1) the helper's options carry pdfjs-dist's standard_fonts path (trailing slash, the Symbol face inside) and pass the caller's own flags through", () => {
  const opts = pdfjsDocumentOptions({ data: new Uint8Array(4), useSystemFonts: true, disableWorker: true });
  assert.equal(opts.standardFontDataUrl, pdfjsStandardFontDataUrl());
  assert.ok(opts.standardFontDataUrl.endsWith("/"), "pdfjs refuses a factory url without a trailing slash");
  assert.ok(/pdfjs-dist\/standard_fonts\/$/.test(opts.standardFontDataUrl), opts.standardFontDataUrl);
  assert.ok(fs.existsSync(path.join(opts.standardFontDataUrl, "FoxitSymbol.pfb")), "the directory holds pdfjs's standard font files");
  assert.equal(opts.useSystemFonts, true);
  assert.equal(opts.disableWorker, true);
  assert.equal(opts.data.length, 4);
});

await check("(h2) no server-side call site forgets: every getDocument( in backend/src opens through pdfjsDocumentOptions", () => {
  const dir = path.join(REPO, "backend/src");
  const bare: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    fs.readFileSync(path.join(dir, f), "utf8").split("\n").forEach((line, i) => {
      if (/\bgetDocument\(/.test(line) && !/getDocument\(pdfjsDocumentOptions\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) bare.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bare, []);
});

await check("(r0) the fixture really triggers the warning: a bare getDocument + render prints it (so r1/r2 are not vacuous)", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
  const { createCanvas } = await import("@napi-rs/canvas" as string);
  const lines = await captureConsole(async () => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fixture), useSystemFonts: true, disableWorker: true }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise;
  });
  assert.ok(lines.some((l) => FONT_WARNING.test(l)), `expected the standardFontDataUrl warning, got: ${JSON.stringify(lines)}`);
});

await check("(r1) a vision render of the non-embedded-font page (pageImages.openPdfForVisionRender) emits no standardFontDataUrl warning", async () => {
  const { openPdfForVisionRender } = await import("../src/pageImages");
  const lines = await captureConsole(async () => {
    const doc = await openPdfForVisionRender(fixture);
    const r = await doc.render(1, { maxLongEdge: 600, maxPixels: 600 * 600 });
    assert.ok(r.bytes.length > 0, "the page rendered");
    await doc.close();
  });
  assert.deepEqual(lines.filter((l) => FONT_WARNING.test(l)), []);
});

await check("(r2) the text-layer reads (formTextLayer.extractLabels, pdfTables.extractPdfTextItems) emit no standardFontDataUrl warning", async () => {
  const { extractLabels } = await import("../src/formTextLayer");
  const { extractPdfTextItems } = await import("../src/pdfTables");
  const lines = await captureConsole(async () => {
    const labels = await extractLabels(fixture);
    assert.ok(labels.some((l) => /Synthetic permit form/.test(l.str)), "the Helvetica line was read");
    await extractPdfTextItems(fixture);
  });
  assert.deepEqual(lines.filter((l) => FONT_WARNING.test(l)), []);
});

if (failures) { console.error(`\n${failures} pdfjsStandardFonts test(s) failed.`); process.exit(1); }
console.log("\nall pdfjsStandardFonts tests passed");
process.exit(0);
