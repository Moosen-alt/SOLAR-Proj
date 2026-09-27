// IMAGE-ONLY PLAN SETS AND IMAGE-ONLY PAGES (scannedPlanSet.ts): chosen by content, read by
// vision, capped, labelled, and merged under the text read.
//
// Two Iowa City plan sets were scans with a 0-character text layer, and the parser page assumed
// "the plan set is always vector text". A third was a text set whose six datasheet pages were
// PICTURES (only the title block in the text layer), so the module Voc / Isc / temperature
// coefficient never reached the read. The tests build SYNTHETIC PDFs — text pages rendered to PNGs
// and re-embedded as images, so their text layer is genuinely empty — and pin:
//   - an empty/near-empty text layer is detected (and a real text layer is NOT sent to vision);
//   - WITH a page index, the pages are chosen by what they ARE (cover, site plan, one-line, calcs,
//     datasheets...), up to 8, turned upright; WITHOUT one, the position rule is unchanged;
//   - the per-read byte budget drops the least useful page and names it;
//   - a text set's image-only pages are found and read alone (hybrid), and that read merges UNDER
//     the text read (the text wins every field it answered; a disagreement is a conflict);
//   - the parser page renders the smart read's roof planes instead of "No roof planes parsed".
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
const { createCanvas, loadImage } = await import("@napi-rs/canvas" as string);

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
async function imageOnly(pages: number, size: [number, number] = [792, 612]): Promise<Uint8Array> {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scan-src-")), "src.pdf");
  fs.writeFileSync(tmp, await textPlanSet(pages));
  const out = await PDFDocument.create();
  for (let i = 1; i <= pages; i++) {
    const png = await out.embedPng(await renderPdfPageToPng(tmp, i, 0.8));
    const page = out.addPage(size);
    page.drawImage(png, { x: 0, y: 0, width: size[0], height: size[1] });
  }
  return out.save();
}
/** A text plan set whose pages in `imagePages` are PICTURES carrying only the title block as text
 *  (a datasheet pasted into a vector PDF), every other page a real text sheet. Synthetic. */
async function hybridSet(pages: number, imagePages: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // a busy raster, 1200 x 800 = 0.96 MP — a scanned datasheet stand-in
  const cv = createCanvas(1200, 800);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1200, 800); ctx.fillStyle = "#000"; ctx.font = "28px sans-serif";
  for (let y = 60; y < 800; y += 44) ctx.fillText(`SYNTH MODULE DATASHEET  Voc 41.${y % 10} V  Isc 9.${y % 7} A  TEMP COEFF -0.2${y % 9} %/C`, 30, y);
  const raster = await doc.embedPng(cv.toBuffer("image/png"));
  const titleBlock = (i: number) => `CONTRACTOR: SYNTHETIC SOLAR CO  ADDRESS: 1 EXAMPLE WAY ANYTOWN  SHEET NUMBER PV-${i}  SHEET SIZE ANSI B 11 X 17  HOMEOWNER INFO JANE EXAMPLE 2 SAMPLE ST`;
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([1224, 792]);
    p.drawText(titleBlock(i), { x: 30, y: 20, size: 8, font });
    if (imagePages.includes(i)) {
      p.drawImage(raster, { x: 30, y: 60, width: 1100, height: 700 });
    } else {
      for (let r = 0; r < 18; r++) p.drawText(`SHEET ${i} NOTE ${r}: ${["CONDUCTOR", "BREAKER", "RAFTER", "SETBACK", "AZIMUTH", "BUSBAR"][r % 6]} ${i * 100 + r} ${["AWG", "AMP", "IN OC", "FT", "DEG", "A"][r % 6]} PER PLAN ${i}-${r}`, { x: 40, y: 740 - r * 36, size: 14, font });
    }
  }
  return doc.save();
}
type FakeInput = { planPageImages?: Array<{ page: number; base64: string; mimeType: string; label?: string }>; planText?: string; planImageMode?: string };
function fakeLlm(index?: (pages: number[]) => unknown) {
  const calls: FakeInput[] = [];
  const indexCalls: Array<Array<{ page: number; base64: string; mimeType: string }>> = [];
  const llm: Record<string, unknown> = {
    calls,
    indexCalls,
    async extractProjectFields(input: FakeInput) {
      calls.push(input);
      return { provider: "claude" as const, fields: { dcKw: { value: 6.4, confidence: 0.8, evidence: { source: "plan_set" as const, sheet: "page 1", excerpt: "SYSTEM SIZE: 6.40 KW DC" } } }, lowConfidenceFields: [], notes: "read" };
    },
  };
  if (index) llm.classifyPlanPages = async (input: { pageImages: Array<{ page: number; base64: string; mimeType: string }> }) => { indexCalls.push(input.pageImages); return index(input.pageImages.map((p) => p.page)); };
  return llm as { calls: FakeInput[]; indexCalls: typeof indexCalls; extractProjectFields: (i: FakeInput) => Promise<unknown> };
}
/** The index a reader would return for a 16-page residential set (sheet index on the cover). */
const SIXTEEN: Record<number, [string, string]> = {
  1: ["cover", "COVER PAGE"], 2: ["site_plan", "SITE PLAN WITH MODULES"], 3: ["attachment", "ATTACHMENT DETAIL"], 4: ["one_line", "SINGLE LINE DIAGRAM"],
  5: ["calcs", "WIRING CALCULATIONS"], 6: ["labels", "PLACARDS"], 7: ["module_spec", "MODULE SPEC"], 8: ["inverter_spec", "MICROINVERTER SPEC"],
  9: ["other_spec", "COMBINER SPEC"], 10: ["racking_spec", "RAIL SPEC"], 11: ["racking_spec", "ATTACHMENT SPEC"], 12: ["other_spec", "GATEWAY SPEC"],
  13: ["other_spec", "DISCONNECT SPEC"], 14: ["certificate", "UL LISTING"], 15: ["certificate", "UL LISTING"], 16: ["certificate", "UL CERT"],
};
const sixteenIndex = (rotate = 0) => (pages: number[]) => ({
  pages: pages.map((page) => ({ page, sheet: `PV-${page}`, title: SIXTEEN[page]?.[1] ?? "", kind: SIXTEEN[page]?.[0] ?? "other", rotate })),
  sheetIndex: Object.entries(SIXTEEN).map(([k, v]) => ({ sheet: `PV-${k}`, title: v[1] })),
});
const jpegDims = async (b64: string) => { const im = await loadImage(Buffer.from(b64, "base64")); return { w: im.width as number, h: im.height as number }; };

await check("(k1) position rule (no usable page index): cover, site plan, middle, last — distinct, capped at 4", () => {
  assert.deepEqual(scan.selectKeySheetPages(12), [1, 2, 7, 12]);
  assert.deepEqual(scan.selectKeySheetPages(6), [1, 2, 3, 6]);
  assert.deepEqual(scan.selectKeySheetPages(30), [1, 2, 17, 30]);
  assert.deepEqual(scan.selectKeySheetPages(2), [1, 2]);
  assert.deepEqual(scan.selectKeySheetPages(4), [1, 2, 3, 4], "a set no longer than the cap is read whole (its one-line is page 3)");
  assert.deepEqual(scan.selectKeySheetPages(1), [1]);
  assert.deepEqual(scan.selectKeySheetPages(30, 2), [1, 2]);
  assert.ok(scan.selectKeySheetPages(500).length <= scan.POSITION_RULE_PAGES);
});
await check("(k2) the near-empty predicate ignores page markers", () => {
  assert.equal(scan.planTextIsNearEmpty("--- PAGE 1 ---\n\n--- PAGE 2 ---", 2), true);
  assert.equal(scan.planTextIsNearEmpty("SHEET PV-1 SYSTEM SIZE 6.40 KW DC ".repeat(4), 1), false);
});
await check("(v1) MUST-PASS: an image-only PDF with NO page index falls back to the position rule: 4 key pages, JPEG images, fields labelled vision", async () => {
  const llm = fakeLlm();
  const read = await scan.readPlanSetForExtraction(llm as never, await imageOnly(6));
  assert.equal(read.mode, "vision");
  assert.equal(read.textChars, 0, "the scan has no text layer");
  assert.equal(llm.calls.length, 1);
  const imgs = llm.calls[0].planPageImages ?? [];
  assert.deepEqual(imgs.map((i) => i.page), [1, 2, 3, 6]);
  for (const i of imgs) { assert.equal(i.mimeType, "image/jpeg"); assert.ok(i.base64.startsWith("/9j/") && i.base64.length > 1000, "a real JPEG"); }
  assert.equal(llm.calls[0].planText, undefined, "no text is sent for a scan");
  assert.deepEqual(read.extraction?.visionFields, ["dcKw"]);
  assert.deepEqual(read.extraction?.visionPages, [1, 2, 3, 6]);
  assert.match(read.extraction?.notes ?? "", /^IMAGE-ONLY PLAN SET: .*pages 1, 2, 3, 6 .*by POSITION.*read by VISION.*\(dcKw\)/);
  assert.equal(read.extraction?.visionPageRoles, undefined, "a position pick claims no sheet role");
});
await check("(v2) MUST-EXCLUDE: a plan set WITH a text layer and no image page is never sent to vision", async () => {
  const llm = fakeLlm(sixteenIndex());
  const read = await scan.readPlanSetForExtraction(llm as never, await textPlanSet(6));
  assert.equal(read.mode, "text");
  assert.ok(read.textChars > 100);
  assert.equal(llm.calls.length, 0);
  assert.equal(llm.indexCalls.length, 0, "no page-index read either");
});
await check("(v3) the page cap holds for a caller's tighter cap (position rule)", async () => {
  const llm = fakeLlm();
  const read = await scan.readPlanSetForExtraction(llm as never, await imageOnly(9), { maxPages: 2 });
  assert.deepEqual(read.extraction?.visionPages, [1, 2]);
  assert.equal(llm.calls[0].planPageImages?.length, 2);
});

// --- content choice -------------------------------------------------------------------------
const scan16 = await imageOnly(16, [612, 792]);
await check("(c1) MUST-PASS: a 16-page scan WITH a page index is read by CONTENT — cover, site plan, attachment, one-line, calcs, labels, module + micro datasheets — not by position", async () => {
  const llm = fakeLlm(sixteenIndex());
  const read = await scan.readPlanSetForExtraction(llm as never, scan16);
  assert.equal(llm.indexCalls.length, 1, "one page-index read");
  assert.deepEqual(llm.indexCalls[0].map((p) => p.page), Array.from({ length: 16 }, (_, i) => i + 1), "every page is indexed");
  for (const t of llm.indexCalls[0]) {
    const d = await jpegDims(t.base64);
    assert.ok(Math.max(d.w, d.h) <= (t.page <= 2 ? 1600 : 1000), `index thumbnails are small (page ${t.page}: ${d.w}x${d.h})`);
  }
  assert.deepEqual(read.extraction?.visionPages, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.notDeepEqual(read.extraction?.visionPages, scan.selectKeySheetPages(16), "the position rule would have read 1, 2, 9, 16");
  const imgs = llm.calls[0].planPageImages ?? [];
  assert.deepEqual(imgs.map((i) => i.page), [1, 2, 3, 4, 5, 6, 7, 8], "sent in page order");
  assert.match(imgs[3].label ?? "", /one-line, PV-4/, "each image is labelled with what it is");
  assert.equal(llm.calls[0].planImageMode, "scan");
  const n = read.extraction?.notes ?? "";
  assert.match(n, /^IMAGE-ONLY PLAN SET: .*pages 1, 2, 3, 4, 5, 6, 7, 8 \(chosen by their sheet titles from the page index — 1 cover, PV-1; 2 site plan, PV-2; .*4 one-line, PV-4; 5 electrical calcs, PV-5; .*7 module datasheet, PV-7; 8 inverter datasheet, PV-8 — at most 8\) were read by VISION\./);
  assert.match(n, /Not read: pages 9, 12, 13 \(equipment datasheet — over the 8-page cap\); pages 10, 11 \(racking datasheet — over the 8-page cap\); pages 14, 15, 16 \(certificate — over the 8-page cap\)\./);
  assert.deepEqual(read.extraction?.visionSkipped?.map((s) => s.page), [9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(read.extraction?.visionPageRoles?.find((r) => r.page === 2)?.kind, "site_plan");
});
await check("(c2) a sideways sheet is turned upright before it is read (the index's rotation)", async () => {
  const llm = fakeLlm(sixteenIndex(90));
  await scan.readPlanSetForExtraction(llm as never, scan16);
  const img = (llm.calls[0].planPageImages ?? [])[1];
  const d = await jpegDims(img.base64);
  assert.ok(d.w > d.h, `a portrait page turned 90° reads landscape (${d.w}x${d.h})`);
  assert.ok(d.w <= scan.VISION_MAX_LONG_EDGE && d.w * d.h <= scan.VISION_MAX_PIXELS, "inside the model's image limits");
  assert.match(img.label ?? "", /turned 90° upright/);
});
await check("(c3) an index that names no key sheet (all 'other' / blank) falls back to the unchanged position rule; a failing index read does too", async () => {
  const llmA = fakeLlm((pages) => ({ pages: pages.map((page) => ({ page, kind: page % 2 ? "other" : "blank", rotate: 0 })) }));
  const a = await scan.readPlanSetForExtraction(llmA as never, scan16);
  assert.deepEqual(a.extraction?.visionPages, [1, 2, 9, 16]);
  assert.match(a.extraction?.notes ?? "", /by POSITION because the page index named no key sheet/);
  const llmB = fakeLlm(() => { throw new Error("upstream 529"); });
  const b = await scan.readPlanSetForExtraction(llmB as never, scan16);
  assert.deepEqual(b.extraction?.visionPages, [1, 2, 9, 16]);
  assert.match(b.extraction?.notes ?? "", /by POSITION because the page-index read failed \(upstream 529\)/);
});
await check("(c4) choice by content: 40-page set holds the 8-page cap; an index on page 2 and a set with no cover are handled; the model's junk is dropped", () => {
  const kinds = ["cover", "notes", "site_plan", "roof_plan", "roof_plan", "attachment", "structural", "one_line", "one_line", "calcs", "labels", "module_spec", "inverter_spec", "battery_spec"];
  const idx40 = scan.normalizePageIndex({ pages: Array.from({ length: 40 }, (_, i) => ({ page: i + 1, kind: kinds[i] ?? "other_spec", rotate: 0 })) }, Array.from({ length: 40 }, (_, i) => i + 1));
  const c40 = scan.choosePagesByContent(idx40, Array.from({ length: 40 }, (_, i) => i + 1), scan.MAX_VISION_PAGES)!;
  assert.equal(c40.pages.length, 8);
  assert.deepEqual(c40.pages.map((p) => p.page), [1, 3, 8, 10, 12, 13, 6, 11], "one of each key sheet, in priority order");
  assert.equal(c40.skipped.length, 32);
  // Sheet index on page 2 (a notes/index sheet), no page called "cover": page 1 still leads.
  const idx2 = scan.normalizePageIndex({ pages: [{ page: 1, kind: "other" }, { page: 2, kind: "notes", title: "SHEET INDEX" }, { page: 3, kind: "one_line" }, { page: 4, kind: "site_plan" }] }, [1, 2, 3, 4]);
  assert.deepEqual(scan.choosePagesByContent(idx2, [1, 2, 3, 4], 3)!.pages.map((p) => p.page), [1, 4, 3]);
  // Junk from the model: pages never shown, duplicates, unknown kinds, odd rotations.
  const junk = scan.normalizePageIndex({ pages: [{ page: 99, kind: "cover" }, { page: 2, kind: "one_line", rotate: -90 }, { page: 2, kind: "cover" }, { page: 3, kind: "hologram", rotate: 45 }, "x", null] }, [1, 2, 3]);
  assert.deepEqual(junk.pages, [{ page: 2, kind: "one_line", rotate: 270 }, { page: 3, kind: "other", rotate: 0 }]);
  assert.equal(scan.choosePagesByContent(scan.normalizePageIndex({ pages: [] }, [1]), [1], 8), null);
});
await check("(b1) the per-read BYTE budget drops the least useful page first, names it, and is never exceeded", async () => {
  const llm = fakeLlm(sixteenIndex());
  // measure one page image, then allow room for about three
  const probe = fakeLlm(sixteenIndex());
  await scan.readPlanSetForExtraction(probe as never, scan16, { maxPages: 1 });
  const one = Buffer.from(probe.calls[0].planPageImages![0].base64, "base64").length;
  const budget = Math.floor(one * 3.5);
  const read = await scan.readPlanSetForExtraction(llm as never, scan16, { maxBytes: budget });
  const imgs = llm.calls[0].planPageImages ?? [];
  const total = imgs.reduce((s, i) => s + Buffer.from(i.base64, "base64").length, 0);
  assert.ok(total <= budget, `images ${total} bytes <= budget ${budget}`);
  assert.ok(imgs.length >= 2 && imgs.length < 8, `some pages dropped (${imgs.length} read)`);
  assert.deepEqual(imgs.map((i) => i.page), [1, 2, 4].slice(0, imgs.length).concat(imgs.length > 3 ? [5] : []).sort((a, b) => a - b), "the highest-priority sheets survive: cover, site plan, one-line (then calcs)");
  assert.match(read.extraction?.notes ?? "", new RegExp(`over the ${budget}-byte per-read image budget`));
  assert.ok((read.extraction?.visionSkipped ?? []).some((s) => s.page === 8 && /byte per-read image budget/.test(s.reason)), "the microinverter sheet (lower priority) is named as skipped");
});

// --- hybrid ---------------------------------------------------------------------------------
await check("(h1) body text less the repeated title block: title-block-only pages read as near-empty", () => {
  const tb = "CONTRACTOR SYNTH CO SHEET NAME EQUIPMENT SPECIFICATION ANSI B 11 X 17 HOMEOWNER JANE";
  const pages = [`${tb} PV-1 ${"CONDUCTOR 10 AWG BREAKER 40 AMP ".repeat(20)}`, `${tb} PV-2 ${"RAFTER 24 IN OC SETBACK 3 FT ".repeat(20)}`, `${tb} PV-3`, `${tb} PV-4`];
  const body = scan.bodyCharsPerPage(pages);
  assert.ok(body[0] > 300 && body[1] > 300, `drawing pages keep their body (${body})`);
  assert.ok(body[2] < 10 && body[3] < 10, `title-block-only pages are near-empty (${body})`);
  assert.deepEqual(scan.imageOnlyPages(pages, [0, 2_000_000, 900_000, 0]), [3], "near-empty AND a large raster; a page with no raster is not an image page");
});
await check("(h2) MUST-PASS: a TEXT set with image-only datasheet pages reads ONLY those pages by vision (mode hybrid), in hybrid mode", async () => {
  const pdf = await hybridSet(8, [6, 7]);
  const px = await scan.rasterPixelsPerPage(pdf);
  assert.ok(px[5] >= 900_000 && px[0] === 0, `raster found on the image pages (${px})`);
  const llm = fakeLlm(sixteenIndex());
  const read = await scan.readPlanSetForExtraction(llm as never, pdf);
  assert.equal(read.mode, "hybrid");
  assert.deepEqual(read.imagePages, [6, 7]);
  assert.equal(llm.indexCalls.length, 0, "two image pages fit the cap: no index read");
  assert.equal(llm.calls.length, 1);
  assert.deepEqual((llm.calls[0].planPageImages ?? []).map((i) => i.page), [6, 7]);
  assert.equal(llm.calls[0].planImageMode, "hybrid");
  assert.equal(llm.calls[0].planText, undefined, "the text layer is read by the text pass, not here");
  assert.deepEqual(read.extraction?.visionPages, [6, 7]);
  assert.equal(read.extraction?.planReadMode, "hybrid");
});
await check("(h3) MUST-EXCLUDE: the same text set with no image page stays on the text path", async () => {
  const llm = fakeLlm(sixteenIndex());
  const read = await scan.readPlanSetForExtraction(llm as never, await hybridSet(8, []));
  assert.equal(read.mode, "text");
  assert.equal(llm.calls.length, 0);
});

// --- merge ----------------------------------------------------------------------------------
const f = (value: unknown, confidence = 0.9, sheet = "PV-1") => ({ value, confidence, evidence: { source: "plan_set" as const, sheet, excerpt: String(value) } });
const textRead = {
  provider: "claude" as const,
  fields: { moduleMake: f("SynthCo"), moduleModel: f("SC-400"), busRating: f("200A"), moduleVoc: f(41.2), electricalCalcText: f("SLD on PV-4") },
  lowConfidenceFields: ["busRating"], notes: "text notes",
};
const imageRead = {
  provider: "claude", planReadMode: "hybrid", visionPages: [7, 8],
  fields: {
    moduleMake: f("SynthCo Solar", 0.95, "page 7"), busRating: f(225, 0.95, "page 7"), moduleVoc: f("41.2 V", 0.9, "page 7"),
    moduleIsc: f(9.8, 0.9, "page 7"), moduleVocTempCoeff: f(-0.27, 0.9, "page 7"), pvMicroMaxDcInputV: f(60, 0.9, "page 8"),
    electricalCalcText: f("datasheet only", 0.9, "page 7"), "bad key!": f("x"), empty: f(""), huge: f("x".repeat(5000)),
  },
  lowConfidenceFields: ["moduleIsc", "moduleMake"],
  uncertainties: [{ field: "moduleIsc", kind: "unreadable", reason: "blurry" }, { field: "moduleMake", kind: "guessed", reason: "n/a" }],
  notes: "only datasheets shown",
};
await check("(m1) MUST-PASS: the merge keeps the TEXT value for every field the text answered, fills only the gaps from vision, and records a disagreement as a conflict", async () => {
  const m = scan.mergeImagePageRead(textRead as never, imageRead);
  assert.equal(m.fields.moduleMake.value, "SynthCo", "text wins (same make, different wording: no conflict)");
  assert.equal(m.fields.busRating.value, "200A", "text wins a disagreement");
  assert.equal(m.fields.moduleVoc.value, 41.2, "text wins (41.2 == '41.2 V')");
  assert.equal(m.fields.electricalCalcText.value, "SLD on PV-4");
  assert.equal(m.fields.moduleIsc.value, 9.8);
  assert.equal(m.fields.pvMicroMaxDcInputV.value, 60);
  assert.deepEqual(m.visionFields, ["moduleIsc", "moduleVocTempCoeff", "pvMicroMaxDcInputV"], "only the gap-filled keys are vision fields");
  assert.deepEqual((m.conflicts ?? []).map((c) => c.field), ["busRating"], "only the real disagreement is a conflict");
  assert.equal(m.fields["bad key!"], undefined); assert.equal(m.fields.empty, undefined); assert.equal(m.fields.huge, undefined);
  assert.deepEqual(m.lowConfidenceFields, ["busRating", "moduleIsc"], "vision low-confidence only for fields vision supplied");
  assert.deepEqual((m.uncertainties ?? []).map((u) => u.field), ["moduleIsc"]);
  assert.equal(m.planReadMode, "hybrid");
  assert.deepEqual(m.visionPages, [7, 8]);
  assert.match(m.notes, /^IMAGE-ONLY PAGES: pages 7, 8 of this plan set carry no text layer .*read by VISION and merged under the text read — the text layer stays authoritative.*Fields from vision: moduleIsc, moduleVocTempCoeff, pvMicroMaxDcInputV; .*\(busRating\), both readings are listed as conflicts\. text notes Image pages: only datasheets shown$/);
});
await check("(m2) a malformed / empty image read changes nothing", async () => {
  for (const junk of [null, "x", 42, { fields: "no" }, { fields: {}, visionPages: [] }]) {
    const m = scan.mergeImagePageRead(textRead as never, junk);
    assert.deepEqual(m, textRead);
  }
});

// --- the parser page and the routes ---------------------------------------------------------
const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
const server = fs.readFileSync(path.join(REPO, "backend", "src", "server.ts"), "utf8");
await check("(u1) the parser page posts a scan to the vision route under the same 40-chars-per-page rule and names vision fields", () => {
  assert.match(html, /\/api\/parser\/plan-scan-extract/);
  assert.match(html, /planChars < 40 \* Math\.max\(1, state\.planDoc\?\.pageCount \|\| 1\)/);
  assert.match(html, /fields from vision: /);
  assert.match(server, /app\.post\(\s*"\/api\/parser\/plan-scan-extract"/);
});
await check("(u2) a TEXT plan set is posted to the same route (the server finds its image-only pages) and that read rides back to llm-extract, which merges it under the text read", () => {
  assert.match(html, /planChars >= 40 \* Math\.max\(1, state\.planDoc\?\.pageCount \|\| 1\)\)\{[\s\S]{0,400}fetch\(`\/api\/parser\/plan-scan-extract\$\{planScanQuery\}`/);
  assert.match(html, /v\.planReadMode === 'hybrid'/);
  assert.match(html, /postJson\('\/api\/parser\/llm-extract', \{[^\n]*planImageRead/);
  assert.match(server, /mergeImagePageRead\(extraction, req\.body\.planImageRead\)/);
  assert.match(server, /if \(read\.mode === "hybrid"\) \{ res\.json\(read\.extraction/);
});
await check("(u3) MUST-PASS: the parser page shows the smart read's roof planes (never 'No roof planes parsed' over a roof plan that was read)", () => {
  assert.match(html, /await runLlmAssist\(\);\s*\n\s*renderRoofPlanesFromSmartRead\(\);/, "called right after the smart read");
  const src = html.match(/function renderRoofPlanesFromSmartRead\(\)\{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(src, "the function exists");
  const run = (state: unknown) => {
    const out: Record<string, string> = {};
    const fn = new Function("state", "setVal", `${src}; renderRoofPlanesFromSmartRead(); `);
    fn(state, (id: string, v: string) => { out[id] = v; });
    return out.roofPlanesField;
  };
  const planes = run({ planData: { roofPlanes: [] }, llmSnapshot: { pvArrays: [{ quantity: 28, tilt: 40, azimuth: 300 }, { quantity: 12, tilt: 45, azimuth: 170 }] }, planReadRoles: [{ page: 2, kind: "site_plan", sheet: "PV-2" }] });
  assert.match(planes, /^Roof #1: 28 module\(s\), tilt 40°, azimuth 300°\nRoof #2: 12 module\(s\), tilt 45°, azimuth 170°\nTotal roof-plane modules \(read by vision from page 2, PV-2\): 40$/);
  const single = run({ planData: {}, llmSnapshot: { tilt: 30, azimuth: 180 }, planReadRoles: [{ page: 2, kind: "roof_plan" }] });
  assert.match(single, /^The roof\/site plan was read by vision from page 2 but lists no per-plane table — one array: tilt 30°, azimuth 180°/);
  assert.doesNotMatch(single, /No roof planes parsed/);
  assert.equal(run({ planData: { roofPlanes: [{ roof: 1 }] }, llmSnapshot: { pvArrays: [{ quantity: 1 }] } }), undefined, "the regex planes (text layer) stay");
  assert.equal(run({ planData: {}, llmSnapshot: {} }), undefined, "nothing read: the regex path's message stands");
});

console.log(failures ? `scannedPlanSet: ${failures} FAILED, ${passed} passed` : `scannedPlanSet: ${passed}/${passed} passed`);
process.exit(failures ? 1 : 0);
