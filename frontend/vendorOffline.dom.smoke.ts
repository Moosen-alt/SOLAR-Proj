// THE PDF TOOLS WORK WITH THE INTERNET OFF — real Chromium, the pages as shipped.
//
// The Parser, Form filler and Fill a form loaded pdf.js (and the Parser also tesseract.js,
// pdf-lib, JSZip and FileSaver) from cdnjs / jsdelivr. On venue wifi that is a coin toss, and a
// failed CDN load does not look like one: the Parser's `if (window.pdfjsLib)` guard lets the page
// render, and the first plan set dropped on it reads as nothing. tesseract.js is worse — the
// <script> tag alone is not offline; recognize() fetches its worker, a 4 MB WASM core and the
// English data from jsdelivr each time it is first called.
//
// Network OFF here means Chromium is launched with every host name except 127.0.0.1 resolving to
// NOTFOUND, so no request can leave the machine — a page, a worker or a WASM import alike — and
// the context additionally aborts and RECORDS any request that is not to the local server.
//
//   MUST PASS  — parser.html: window.pdfjsLib loads, its worker is /vendor/…, a PDF built here
//                opens and its text reads back (a PDF only opens when the worker really loaded:
//                pdf.js 3 rejects with "Setting up fake worker failed" otherwise).
//   MUST PASS  — parser.html: the page's OWN OCR function (extractPdfFirstPagesWithOcr) reads the
//                words off that PDF — worker, WASM core and eng.traineddata all from /vendor.
//   MUST PASS  — form-filler.html: pdf.js loads, worker from /vendor, the same PDF opens.
//   MUST PASS  — fill-form.html loads with no uncaught page error.
//   MUST EXCLUDE — any request, from any of the three pages, to a host that is not the local
//                server (the recorded list must be empty).
//
// KILL: VENDOR_SMOKE_FRONTEND=<a copy of frontend/ with the old CDN tags> fails every MUST PASS
// above for the page that was reverted.
//
// Hermetic: a throwaway static server over frontend/, /api/* answers 404. No backend, no DB.
// Discovered from disk by scripts/run-dom-smokes.ts. Alone: `npx tsx frontend/vendorOffline.dom.smoke.ts`

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { PDFDocument, StandardFonts } = require("pdf-lib");

const FRONTEND = path.resolve(process.env.VENDOR_SMOKE_FRONTEND || path.dirname(fileURLToPath(import.meta.url)));
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon",
  ".gz": "application/gzip", ".wasm": "application/wasm",
};

const startServer = async (): Promise<{ base: string; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not stubbed"}');
      return;
    }
    const file = path.join(FRONTEND, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    if (file.startsWith(FRONTEND) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

const WORDS = "OFFLINE VENDOR 4263";

async function fixturePdf(): Promise<number[]> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 396]);
  page.drawText(WORDS, { x: 40, y: 200, size: 40, font });
  return [...(await doc.save())];
}

async function main(): Promise<void> {
  const { base, close } = await startServer();
  const pdf = await fixturePdf();
  const browser = await chromium.launch({
    headless: true,
    // The network switch: every name but the local server fails to resolve, for pages AND workers.
    args: ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"],
  });
  const external = new Set<string>();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript("globalThis.__name = (f) => f;");
    await ctx.route("**/*", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => {
      const u = route.request().url();
      if (u.startsWith(base) || u.startsWith("data:") || u.startsWith("blob:")) return route.continue();
      external.add(u);
      return route.abort();
    });
    ctx.on("request", (r: { url(): string }) => {
      const u = r.url();
      if (!u.startsWith(base) && !u.startsWith("data:") && !u.startsWith("blob:")) external.add(u);
    });

    // ── parser.html ───────────────────────────────────────────────────────────────────────
    console.log("\nparser.html");
    {
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(String(e)));
      await page.goto(`${base}/parser.html`, { waitUntil: "load", timeout: 60000 });
      const lib = await page.evaluate(() => {
        const w = window as unknown as { pdfjsLib?: { GlobalWorkerOptions: { workerSrc: string } }; Tesseract?: unknown };
        return { pdfjs: Boolean(w.pdfjsLib), workerSrc: w.pdfjsLib?.GlobalWorkerOptions.workerSrc || "", tesseract: Boolean(w.Tesseract) };
      });
      check(lib.pdfjs, "parser: window.pdfjsLib is loaded with the network off");
      check(lib.workerSrc.startsWith("/vendor/"), "parser: the pdf.js worker is served from /vendor", lib.workerSrc);
      check(lib.tesseract, "parser: window.Tesseract is loaded with the network off");
      const text = await page.evaluate(async (bytes: number[]) => {
        try {
          const w = window as unknown as { pdfjsLib: any };
          const doc = await w.pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
          const content = await (await doc.getPage(1)).getTextContent();
          return content.items.map((i: { str: string }) => i.str).join(" ");
        } catch (e) { return `ERROR ${(e as Error).message}`; }
      }, pdf).catch((e: Error) => `ERROR ${e.message}`);
      check(text.includes(WORDS), "parser: a PDF opens through the vendored worker and its text reads back", text.slice(0, 160));
      // The page's own OCR path, end to end: pdf.js renders the page, tesseract reads it.
      const ocr = await page.evaluate(async (bytes: number[]) => {
        try {
          const file = new File([new Uint8Array(bytes)], "smoke.pdf", { type: "application/pdf" });
          const out = await (window as unknown as { extractPdfFirstPagesWithOcr: (f: File, n: number, l: string) => Promise<{ text: string; notes: string[] }> })
            .extractPdfFirstPagesWithOcr(file, 1, "smoke");
          return `${out.text} ${(out.notes || []).join(" ")}`;
        } catch (e) { return `ERROR ${(e as Error).message || e}`; }
      }, pdf).catch((e: Error) => `ERROR ${e.message}`);
      const normalized = ocr.toUpperCase().replace(/\s+/g, " ");
      check(/OFFLINE/.test(normalized) && /4263/.test(normalized),
        "parser: the page's OCR (worker, WASM core, eng data) reads the words with the network off", normalized.slice(0, 200));
      check(errors.length === 0, "parser: no uncaught page error", errors.join(" | ").slice(0, 300));
      await page.close();
    }

    // ── form-filler.html ──────────────────────────────────────────────────────────────────
    console.log("\nform-filler.html");
    {
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(String(e)));
      await page.goto(`${base}/form-filler.html`, { waitUntil: "load", timeout: 60000 });
      const res = await page.evaluate(async (bytes: number[]) => {
        const w = window as unknown as { pdfjsLib?: any };
        if (!w.pdfjsLib) return { pdfjs: false, workerSrc: "", text: "" };
        try {
          const doc = await w.pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
          const content = await (await doc.getPage(1)).getTextContent();
          return { pdfjs: true, workerSrc: w.pdfjsLib.GlobalWorkerOptions.workerSrc, text: content.items.map((i: { str: string }) => i.str).join(" ") };
        } catch (e) { return { pdfjs: true, workerSrc: w.pdfjsLib.GlobalWorkerOptions.workerSrc, text: `ERROR ${(e as Error).message}` }; }
      }, pdf);
      check(res.pdfjs, "form-filler: window.pdfjsLib is loaded with the network off");
      check(String(res.workerSrc).startsWith("/vendor/"), "form-filler: the pdf.js worker is served from /vendor", String(res.workerSrc));
      check(res.text.includes(WORDS), "form-filler: a PDF opens and its text reads back", res.text.slice(0, 160));
      check(errors.length === 0, "form-filler: no uncaught page error", errors.join(" | ").slice(0, 300));
      await page.close();
    }

    // ── fill-form.html ────────────────────────────────────────────────────────────────────
    console.log("\nfill-form.html");
    {
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(String(e)));
      await page.goto(`${base}/fill-form.html`, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(500);
      check(errors.length === 0, "fill-form: loads with no uncaught page error", errors.join(" | ").slice(0, 300));
      await page.close();
    }

    console.log("\nall three pages");
    check(external.size === 0, "MUST EXCLUDE: no page asked for anything off the local server", [...external].slice(0, 8).join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await close();
  }
  console.log(failures.length ? `\nVENDOR OFFLINE: ${failures.length} FAILED\n  ${failures.join("\n  ")}` : "\nVENDOR OFFLINE: all checks passed.");
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
