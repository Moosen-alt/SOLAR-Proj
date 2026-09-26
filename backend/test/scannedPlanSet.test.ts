// IMAGE-ONLY PLAN SETS (scannedPlanSet.ts): read by vision, capped, labelled.
//
// Two Iowa City plan sets were scans with a 0-character text layer, and the parser page assumed
// "the plan set is always vector text". The test builds a SYNTHETIC image-only PDF — a text plan
// set rendered to PNGs and re-embedded as images, so its text layer is genuinely empty — and pins:
//   - an empty/near-empty text layer is detected (and a real text layer is NOT sent to vision);
//   - only the key sheets are rendered (cover, site plan, middle/one-line, last/spec), at most 4;
//   - the images reach the extraction as PLAN_SET page images, and every field that comes back is
//     listed as a vision read, with the pages, in visionFields/visionPages and the notes.
// A fake LLM records what it was given — no spend in the unit chain.
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { REPO } from "./_isolate";

const scan = await import("../src/scannedPlanSet");
const { renderPdfPageToPng } = await import("../src/pageImages");

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

async function textPlanSet(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([792, 612]);
    p.drawText(`SHEET PV-${i}  SYNTHETIC SOLAR PLAN SET`, { x: 40, y: 560, size: 22, font });
    p.drawText(i === 1 ? "SYSTEM SIZE: 6.40 KW DC / 4.64 KW AC   (16) SYNTH-400 MODULES" : `DETAIL ${i}`, { x: 40, y: 500, size: 18, font });
  }
  return doc.save();
}
async function imageOnly(pages: number): Promise<Uint8Array> {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scan-src-")), "src.pdf");
  fs.writeFileSync(tmp, await textPlanSet(pages));
  const out = await PDFDocument.create();
  for (let i = 1; i <= pages; i++) {
    const png = await out.embedPng(await renderPdfPageToPng(tmp, i, 0.8));
    const page = out.addPage([792, 612]);
    page.drawImage(png, { x: 0, y: 0, width: 792, height: 612 });
  }
  return out.save();
}
function fakeLlm() {
  const calls: Array<{ planPageImages?: Array<{ page: number; base64: string; mimeType: string }>; planText?: string }> = [];
  return {
    calls,
    async extractProjectFields(input: { planPageImages?: Array<{ page: number; base64: string; mimeType: string }>; planText?: string }) {
      calls.push(input);
      return { provider: "claude" as const, fields: { dcKw: { value: 6.4, confidence: 0.8, evidence: { source: "plan_set" as const, sheet: "page 1", excerpt: "SYSTEM SIZE: 6.40 KW DC" } } }, lowConfidenceFields: [], notes: "read" };
    },
  };
}

await check("(k1) key-sheet selection: cover, site plan, middle, last — distinct, capped at 4", () => {
  assert.deepEqual(scan.selectKeySheetPages(12), [1, 2, 7, 12]);
  assert.deepEqual(scan.selectKeySheetPages(6), [1, 2, 3, 6]);
  assert.deepEqual(scan.selectKeySheetPages(30), [1, 2, 17, 30]);
  assert.deepEqual(scan.selectKeySheetPages(2), [1, 2]);
  assert.deepEqual(scan.selectKeySheetPages(4), [1, 2, 3, 4], "a set no longer than the cap is read whole (its one-line is page 3)");
  assert.deepEqual(scan.selectKeySheetPages(1), [1]);
  assert.deepEqual(scan.selectKeySheetPages(30, 2), [1, 2]);
  assert.ok(scan.selectKeySheetPages(500).length <= scan.MAX_VISION_PAGES);
});
await check("(k2) the near-empty predicate ignores page markers", () => {
  assert.equal(scan.planTextIsNearEmpty("--- PAGE 1 ---\n\n--- PAGE 2 ---", 2), true);
  assert.equal(scan.planTextIsNearEmpty("SHEET PV-1 SYSTEM SIZE 6.40 KW DC ".repeat(4), 1), false);
});
await check("(v1) MUST-PASS: a synthetic image-only PDF (0-char text layer) is read by vision: 4 key pages, PNG images, fields labelled vision", async () => {
  const llm = fakeLlm();
  const read = await scan.readPlanSetForExtraction(llm as never, await imageOnly(6));
  assert.equal(read.mode, "vision");
  assert.equal(read.textChars, 0, "the scan has no text layer");
  assert.equal(llm.calls.length, 1);
  const imgs = llm.calls[0].planPageImages ?? [];
  assert.deepEqual(imgs.map((i) => i.page), [1, 2, 3, 6]);
  for (const i of imgs) { assert.equal(i.mimeType, "image/png"); assert.ok(i.base64.startsWith("iVBOR") && i.base64.length > 1000, "a real PNG"); }
  assert.equal(llm.calls[0].planText, undefined, "no text is sent for a scan");
  assert.deepEqual(read.extraction?.visionFields, ["dcKw"]);
  assert.deepEqual(read.extraction?.visionPages, [1, 2, 3, 6]);
  assert.match(read.extraction?.notes ?? "", /^IMAGE-ONLY PLAN SET: .*pages 1, 2, 3, 6 .*read by VISION.*\(dcKw\)/);
});
await check("(v2) MUST-EXCLUDE: a plan set WITH a text layer is never sent to vision", async () => {
  const llm = fakeLlm();
  const read = await scan.readPlanSetForExtraction(llm as never, await textPlanSet(6));
  assert.equal(read.mode, "text");
  assert.ok(read.textChars > 100);
  assert.equal(llm.calls.length, 0);
});
await check("(v3) the page cap holds for a long scan and for a caller's tighter cap", async () => {
  const llm = fakeLlm();
  const read = await scan.readPlanSetForExtraction(llm as never, await imageOnly(9), { maxPages: 2 });
  assert.deepEqual(read.extraction?.visionPages, [1, 2]);
  assert.equal(llm.calls[0].planPageImages?.length, 2);
});
await check("(u1) the parser page posts a scan to the vision route under the same 40-chars-per-page rule and names vision fields", () => {
  const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
  assert.match(html, /\/api\/parser\/plan-scan-extract/);
  assert.match(html, /planChars < 40 \* Math\.max\(1, state\.planDoc\?\.pageCount \|\| 1\)/);
  assert.match(html, /fields from vision: /);
  const server = fs.readFileSync(path.join(REPO, "backend", "src", "server.ts"), "utf8");
  assert.match(server, /app\.post\(\s*"\/api\/parser\/plan-scan-extract"/);
});

console.log(failures ? `scannedPlanSet: ${failures} FAILED, ${passed} passed` : `scannedPlanSet: ${passed}/${passed} passed`);
process.exit(failures ? 1 : 0);
