// ONE PAGE, ONE DOWNLOAD, TWO ANSWERS — AND A SECOND SOURCE THAT MUST NOT WIN QUIETLY.
//
// The whole pass, against a LOCAL http server serving a fixture jurisdiction page and three
// PDFs generated here. No public network, no Chromium (DOCUMENT_FETCH_BROWSER=0 forbids the
// escalation rung), no real LLM.
//
// The fixture is Coos County's shape, because that is where this was measured:
//   /solar-page       electrical application + prescriptive checklist + decoy links
//   /electrical.pdf   AcroForm fields AND the 2022 fee table, footer "Revised 12/23/2022"
//   /checklist.pdf    flat, solar wording, NO fee table
//   /fees-page        the adopted schedule, published separately
//   /adopted.pdf      the SAME three brackets at 2025 prices, "Effective 7-1-25"
//
// Two things in it are adversarial on purpose, and both are proved to be adversarial before
// they are proved to be handled — a fixture that passes without the fix proves nothing:
//
//  1. The fee table's text stream is SCRAMBLED the way the City of Coos Bay schedule's is:
//     two rows emit their dollar amount before their own description, and the lower row
//     before the upper one. Test 2 shows a reading-order pairing leaves the 5.01-15 kVA
//     bracket — the one most residential jobs land in — with no fee at all, on the same bytes
//     the harvest reads correctly.
//     (NOT reproduced here: money split across text items, "$ | 1 | 71 | . | 99". Measured —
//     pdfjs re-merges adjacent Tj operations into one item before pdfTables ever sees them,
//     so a pdf-lib fixture cannot express it. See the handoff note: when a real PDF does emit
//     those separately with a visible gap, pdfjs hands up "$ 1 71 . 99" and parseMoney
//     returns null, so the row is reported UNREADABLE rather than mis-priced — safe, but a
//     miss, and it belongs to pdfTables.)
//  2. The two sources label the same bracket DIFFERENTLY ("5 kva or less" vs "Renewable energy
//     5 KVA or less"). Test 7 shows a label-keyed conflict detector — the obvious
//     implementation — finds NO conflict at all, which is how $79 would quietly replace $135.
//
// Run: tsx backend/test/jurisdictionHarvest.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

// Before anything imports ../src/db. A scratch file, never backend/data/autopilot.sqlite.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "harvest.sqlite");
process.env.AUTOPILOT_LOG_FILE = "";
process.env.ANTHROPIC_API_KEY = "";
// No headed window may open from a unit test, and the walled-page case below must report a
// wall rather than spend two seconds trying to climb it.
process.env.DOCUMENT_FETCH_BROWSER = "0";

const { openDatabase } = await import("../src/db");
const {
  harvestJurisdiction,
  detectFeeConflict,
  bracketKey,
  readFeeTableFromPdf,
  FEE_CONFLICT_MARKER,
} = await import("../src/jurisdictionHarvest");
const { feeForProject, feeScheduleProfileKey, getFeeSchedule, markFeeScheduleVerified, saveFeeSchedule } =
  await import("../src/feeSchedules");
const { parseMoney } = await import("../src/pdfTables");
import type { LLMProvider } from "../../shared/src/types";
import type { FeeCandidate } from "../src/jurisdictionHarvest";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// The fixture PDFs
// ---------------------------------------------------------------------------

const SIZE = 10;
const LABEL_X = 55;
const VALUE_X = 400;

const draw = (p: PDFPage, font: PDFFont, s: string, x: number, y: number): void =>
  p.drawText(s, { x, y, size: SIZE, font });

/** The county's electrical permit application: real AcroForm fields for the AHJ-docs phase,
 *  the 2022 renewable-energy fee table for the fee phase, one document. */
async function electricalApplicationPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  draw(page, font, "COOS COUNTY ELECTRICAL PERMIT APPLICATION", LABEL_X, 740);
  draw(page, font, "Renewable Energy", LABEL_X, 660);

  draw(page, font, "5 kva or less", LABEL_X, 640);
  draw(page, font, "$79.00", VALUE_X, 640);

  // SCRAMBLED, exactly as the City of Coos Bay schedule scrambles: each of these two rows
  // emits its dollar amount before its own description, and the row below is emitted before
  // the row above. Reading the stream in order pairs both fees with the wrong bracket.
  draw(page, font, "$94.00", VALUE_X, 620);
  draw(page, font, "15.01 kva to 25 kva", LABEL_X, 600);
  draw(page, font, "$156.00", VALUE_X, 600);
  draw(page, font, "5.01 kva to 15 kva", LABEL_X, 620);

  draw(page, font, "Revised 12/23/2022", LABEL_X, 90);

  const form = doc.getForm();
  const applicant = form.createTextField("applicant_name");
  applicant.addToPage(page, { x: LABEL_X, y: 540, width: 220, height: 16 });
  const site = form.createTextField("site_address");
  site.addToPage(page, { x: LABEL_X, y: 512, width: 220, height: 16 });
  const contractor = form.createTextField("contractor_license");
  contractor.addToPage(page, { x: LABEL_X, y: 484, width: 220, height: 16 });
  return doc.save();
}

/** The prescriptive checklist: solar wording everywhere, not one dollar amount. A document
 *  that is a FORM and not a fee source, which the report must say rather than guess. */
async function checklistPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  draw(page, font, "Prescriptive Rooftop-Mounted Solar PV Checklist", LABEL_X, 740);
  draw(page, font, "Solar array is mounted parallel to the roof surface", LABEL_X, 700);
  draw(page, font, "Yes / No", VALUE_X, 700);
  draw(page, font, "Photovoltaic modules weigh 5 psf or less", LABEL_X, 680);
  draw(page, font, "Yes / No", VALUE_X, 680);
  return doc.save();
}

/** The adopted schedule: the SAME three brackets, at 2025 prices, labelled differently, plus
 *  one row whose bound is strictly exclusive and must come back unreadable rather than guessed. */
async function adoptedSchedulePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  draw(page, font, "COMMUNITY DEVELOPMENT FEE SCHEDULE", LABEL_X, 740);
  draw(page, font, "Effective 7-1-25", LABEL_X, 722);
  draw(page, font, "Section F - Electrical Permit Fees", LABEL_X, 690);

  draw(page, font, "Renewable energy 5 KVA or less", LABEL_X, 660);
  draw(page, font, "$135.00", VALUE_X, 660);
  draw(page, font, "Renewable energy 5.01 KVA to 15 KVA", LABEL_X, 640);
  draw(page, font, "$160.00", VALUE_X, 640);
  draw(page, font, "Renewable energy 15.01 KVA to 25 KVA", LABEL_X, 620);
  draw(page, font, "$265.00", VALUE_X, 620);
  // Strictly exclusive: pdfTables refuses to invent a granularity for it, and so does this.
  draw(page, font, "Solar generation greater than 25 KVA", LABEL_X, 600);
  draw(page, font, "$600.00", VALUE_X, 600);
  return doc.save();
}

// ---------------------------------------------------------------------------
// The jurisdiction, locally
// ---------------------------------------------------------------------------

const ELECTRICAL = await electricalApplicationPdf();
const CHECKLIST = await checklistPdf();
const ADOPTED = await adoptedSchedulePdf();

const SOLAR_PAGE = `<html><body>
  <a href="/jobs">Employment opportunities</a>
  <a href="/permit-center">Permit Center hours</a>
  <a href="/building-permits">Building permit information</a>
  <a href="/forms/electrical-permit-application.pdf">Electrical permit application</a>
  <a href="/forms/prescriptive-solar-checklist.pdf">Prescriptive Rooftop-Mounted Solar PV Checklist</a>
  <a href="/forms/electrical-permit-application.pdf">Electrical permit application (PDF)</a>
  <a href="#top">Back to top</a>
</body></html>`;

const FEES_PAGE = `<html><body>
  <a href="/forms/community-development-fees.pdf">Community Development Fee Schedule effective 7-1-25</a>
  <a href="/jobs">Employment opportunities</a>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = (req.url || "").split("?")[0];
  const pdf = (bytes: Uint8Array) => { res.writeHead(200, { "content-type": "application/pdf" }); res.end(Buffer.from(bytes)); };
  if (url === "/solar-page") { res.writeHead(200, { "content-type": "text/html" }); res.end(SOLAR_PAGE); return; }
  if (url === "/fees-page") { res.writeHead(200, { "content-type": "text/html" }); res.end(FEES_PAGE); return; }
  if (url === "/forms/electrical-permit-application.pdf") return pdf(ELECTRICAL);
  if (url === "/forms/prescriptive-solar-checklist.pdf") return pdf(CHECKLIST);
  if (url === "/forms/community-development-fees.pdf") return pdf(ADOPTED);
  if (url === "/walled") {
    // Akamai's shape: a 403 with a body that names nothing but the refusal.
    res.writeHead(403, { "content-type": "text/html", server: "AkamaiGHost" });
    res.end("<html><head><title>Access Denied</title></head><body>You don't have permission to access this resource.</body></html>");
    return;
  }
  res.writeHead(404); res.end("not found");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// A field mapper that actually maps, so "how many fields" is a real number.
const llm = {
  async mapAcroFormFields(input: { fields: { name: string; type: string }[] }) {
    const textFields: Record<string, string> = {};
    for (const f of input.fields) {
      if (/name/i.test(f.name)) textFields[f.name] = "project.homeownerName";
      else if (/address/i.test(f.name)) textFields[f.name] = "computed.fullAddress";
      else if (/license/i.test(f.name)) textFields[f.name] = "client.ccbLicenseNumber";
    }
    return { provider: "stub" as const, textFields, checkboxes: {}, notes: "mapped by the test" };
  },
} as unknown as LLMProvider;

const db = await openDatabase();
const AHJ = "Coos County";
const STATE = "OR";
const KEY = feeScheduleProfileKey({ state: STATE, ahj: AHJ }, "permit");
const project = { state: STATE, ahj: AHJ, utility: "", systemSizeAcKw: 10, systemSizeDcKw: 12, parserSnapshot: {} } as unknown as Parameters<typeof feeForProject>[1];

const templates = (): Array<{ form_type: string; original_filename: string; field_map: string }> =>
  db.query("SELECT form_type, original_filename, field_map FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", [AHJ]);

console.log("\njurisdictionHarvest — one page, one download, two answers\n");

// ---------------------------------------------------------------------------
// 1. Indexing: kept, unsure, skipped — and nothing lost in silence.
// ---------------------------------------------------------------------------
await check("indexing keeps the documents, flags the pages unsure, and names the paper-shaped skips", async () => {
  const report = await harvestJurisdiction(db, { state: STATE, ahj: AHJ, pageUrl: `${base}/solar-page` }, { llm });
  assert.equal(report.kept.length, 3, `kept ${JSON.stringify(report.kept)}`);
  assert.ok(report.kept.every((k) => /\.pdf$/.test(k.href)), "every kept link is a file");
  // "Building permit information" matched on wording but is a page, not a file.
  assert.ok(report.unsure.some((u) => /building/i.test(u.text)), `unsure ${JSON.stringify(report.unsure)}`);
  assert.ok(report.unsure.every((u) => u.why.length > 0), "every unsure link says why");
  // "Permit Center hours" matched no document word at all — skipped, but LISTED, because it
  // is paper-shaped enough that a person should glance at it.
  assert.ok(report.nearMisses.some((n) => /permit center/i.test(n.text)), `nearMisses ${JSON.stringify(report.nearMisses)}`);
  assert.ok(!report.nearMisses.some((n) => /employment/i.test(n.text)), "ordinary nav is counted, not listed");
  assert.ok(report.skippedCount >= 2, `skippedCount ${report.skippedCount}`);
  // The same PDF is linked twice on the page; it is downloaded once.
  const duplicates = report.documents.filter((d) => d.duplicateOf);
  assert.equal(duplicates.length, 1, "the second link to the same bytes is reported as a duplicate");
});

// ---------------------------------------------------------------------------
// 2. The fixture is adversarial: reading order gets the wrong answer.
// ---------------------------------------------------------------------------
await check("PROOF the fixture is adversarial: a reading-order pairing mis-attributes the fees", async () => {
  const { extractPdfTextItems } = await import("../src/pdfTables");
  const items = await extractPdfTextItems(ELECTRICAL);
  const pairs: Array<{ label: string; feeUsd: number }> = [];
  let buf: string[] = [];
  for (const it of items) {
    const amount = parseMoney(it.str);
    if (amount != null) { pairs.push({ label: buf.join(" ").replace(/\s+/g, " ").trim(), feeUsd: amount }); buf = []; }
    else buf.push(it.str);
  }
  const ninetyFour = pairs.find((p) => p.feeUsd === 94);
  assert.ok(ninetyFour, "reading order does find a $94");
  assert.ok(
    !/5\.01 kva to 15 kva/i.test(ninetyFour.label),
    `reading order should NOT already pair $94 with its own row, but it produced "${ninetyFour.label}"`,
  );
  // The 5.01-15 kVA bracket — the one most residential jobs land in — gets no fee at all from
  // a reading-order pass, while the harvest below pairs it with $94 by geometry.
  assert.ok(
    !pairs.some((p) => /5\.01 kva to 15 kva/i.test(p.label)),
    `reading order leaves the 5.01-15 kVA row with no fee: ${JSON.stringify(pairs)}`,
  );
});

// ---------------------------------------------------------------------------
// 3. Dry run writes nothing.
// ---------------------------------------------------------------------------
await check("dry run: the numbers are reported and NOTHING is written", async () => {
  const report = await harvestJurisdiction(db, { state: STATE, ahj: AHJ, pageUrl: `${base}/solar-page` }, { llm });
  assert.equal(report.applied, false);
  assert.equal(templates().length, 0, "no template rows after a dry run");
  assert.equal(getFeeSchedule(db, KEY, "permit"), null, "no fee schedule row after a dry run");
  assert.equal(report.fee.action, "would_save", report.fee.reason);
  assert.ok(report.documents.some((d) => d.form.action === "would_store"), "forms report would_store");
  const app = report.documents.find((d) => d.formType === "electrical_application");
  assert.ok(app, "the electrical application is classified into its own slot");
  assert.equal(app.form.acroFields, 3, "the blank's real AcroForm field count is reported");
  assert.equal(app.form.mappedFields, 3, "and how many of them were mapped");
});

// ---------------------------------------------------------------------------
// 4. One download, two answers.
// ---------------------------------------------------------------------------
await check("apply: the same download becomes a stored template AND a quoted fee table", async () => {
  const report = await harvestJurisdiction(db, { state: STATE, ahj: AHJ, pageUrl: `${base}/solar-page` }, { llm, apply: true });

  const rows = templates();
  assert.equal(rows.length, 2, `stored form types: ${rows.map((r) => r.form_type).join(", ")}`);
  assert.ok(rows.some((r) => r.form_type === "electrical_application"), "the application went to its own slot");
  assert.ok(rows.some((r) => r.form_type === "solar_checklist"), "the checklist went to its own slot");
  const appRow = rows.find((r) => r.form_type === "electrical_application");
  const map = JSON.parse(appRow.field_map) as { textFields: Record<string, string>; sourceUrl: string; verified: boolean; notes: string };
  assert.equal(Object.keys(map.textFields).length, 3, "the AcroForm fields are mapped to project sources");
  assert.equal(map.verified, false, "a fresh auto-map is never verified");
  assert.ok(map.sourceUrl.includes("electrical-permit-application.pdf"), "the template remembers where it came from");
  assert.ok(map.notes.includes("Revised 12/23/2022"), `the document's own date rides in the map notes: ${map.notes}`);

  // The provenance columns, stamped from this pass: where it came from, what it says about
  // its own currency, and — the one only a harvest can answer — that these same bytes were
  // also the fee table, so a later sweep can find every form whose numbers may have moved.
  const prov = db.get<{ source_url: string; document_date: string; retrieved_at: string; fee_table_found: number }>(
    "SELECT source_url, document_date, retrieved_at, fee_table_found FROM ahj_form_templates WHERE lower(ahj_name) = lower(?) AND form_type = 'electrical_application'", [AHJ]);
  assert.ok(prov.source_url.includes("electrical-permit-application.pdf"), prov.source_url);
  assert.equal(prov.document_date, "Revised 12/23/2022");
  assert.ok(prov.retrieved_at, "and when we pulled it");
  assert.equal(prov.fee_table_found, 1, "this blank IS the fee schedule");
  const checklistProv = db.get<{ fee_table_found: number; document_date: string }>(
    "SELECT fee_table_found, document_date FROM ahj_form_templates WHERE lower(ahj_name) = lower(?) AND form_type = 'solar_checklist'", [AHJ]);
  assert.equal(checklistProv.fee_table_found, 0, "the checklist is a form and not a fee source");
  assert.equal(checklistProv.document_date, "", "and it never dated itself");

  // The fee table, off the very same bytes.
  const app = report.documents.find((d) => d.formType === "electrical_application");
  assert.ok(app.fee.found, `fee scan: ${app.fee.reason}`);
  assert.equal(app.fee.basis, "system_kw");
  assert.equal(app.fee.brackets.length, 3, JSON.stringify(app.fee.brackets));
  assert.deepEqual(app.fee.brackets.map((b) => b.feeUsd), [79, 94, 156], "same-row pairing, including the split $156.00");
  assert.deepEqual(app.fee.brackets.map((b) => [b.minKw, b.maxKw]), [[null, 5], [5.01, 15], [15.01, 25]]);
  assert.ok(app.fee.quote.includes(`"5.01 kva to 15 kva" | "$94.00"`), `verbatim same-row quote: ${app.fee.quote}`);

  // The checklist is a form and not a fee source, and says so rather than guessing.
  const checklist = report.documents.find((d) => d.formType === "solar_checklist");
  assert.equal(checklist.fee.found, false);
  assert.ok(checklist.fee.unreadableRows.length > 0, "its solar rows are reported unreadable, not silently dropped");

  // Stored, seeded, evaluable.
  assert.equal(report.fee.action, "saved", report.fee.reason);
  assert.equal(report.fee.conflict, null, "one source is not a conflict");
  const stored = getFeeSchedule(db, KEY, "permit");
  assert.equal(stored.confidence, "seeded", "research lands seeded, never verified");
  assert.equal(stored.basis, "system_kw");
  const resolved = feeForProject(db, project, "permit");
  assert.equal(resolved.feeUsd, 94, `a 10 kW job lands in the middle bracket: ${JSON.stringify(resolved)}`);
  assert.equal(resolved.bracketLabel, "5.01 kva to 15 kva");
});

// ---------------------------------------------------------------------------
// 5. Document dates.
// ---------------------------------------------------------------------------
await check("each harvested document carries its own stated date, off its own bytes", async () => {
  const report = await harvestJurisdiction(db, { state: STATE, ahj: AHJ, pageUrl: `${base}/solar-page` }, { llm });
  const app = report.documents.find((d) => d.formType === "electrical_application");
  assert.equal(app.documentDate, "Revised 12/23/2022", "the application says how old it is");
  assert.equal(app.documentDateIso, "2022-12-23");
  assert.equal(app.documentStale, true, "three years old, by the shared two-year rule");
  const checklist = report.documents.find((d) => d.formType === "solar_checklist");
  assert.equal(checklist.documentDate, "", "an undated document stays blank — never a guess");
  assert.equal(checklist.documentStale, false, "and undated is NOT stale; it is unknown");
});

// ---------------------------------------------------------------------------
// 6. A SECOND SOURCE WITH DIFFERENT NUMBERS CONFLICTS — IT DOES NOT OVERWRITE.
// ---------------------------------------------------------------------------
await check("a second source disagreeing on a bracket produces a CONFLICT, not an overwrite", async () => {
  const report = await harvestJurisdiction(db, { state: STATE, ahj: AHJ, pageUrl: `${base}/fees-page` }, { llm, apply: true });

  assert.equal(report.fee.action, "conflict_saved", report.fee.reason);
  assert.ok(report.fee.conflict, "the conflict is in the report");
  assert.equal(report.fee.conflict.brackets.length, 3, `disputed brackets: ${report.fee.conflict.summary}`);
  assert.ok(/1\.70x/.test(report.fee.conflict.ratioNote), `uniform ratio noticed: ${report.fee.conflict.ratioNote}`);
  // The strictly-exclusive row is reported, never guessed at.
  const adopted = report.documents.find((d) => d.fee.found);
  assert.ok(adopted.fee.unreadableRows.some((u) => /greater than 25/i.test(u)), JSON.stringify(adopted.fee.unreadableRows));

  const stored = getFeeSchedule(db, KEY, "permit");
  assert.equal(stored.basis, "other", "a conflicted schedule is not a function of anything");
  assert.ok(stored.brackets.length >= 2, "BOTH candidates' brackets are kept — this is the invariant the refusal rests on");
  assert.ok(stored.brackets.some((b) => b.feeUsd === 79), "the 2022 candidate survives");
  assert.ok(stored.brackets.some((b) => b.feeUsd === 135), "the 2025 candidate survives");
  assert.ok(stored.brackets.every((b) => /^\[S\d\]/.test(b.label || "")), "every bracket says which source printed it");
  assert.ok(stored.notes.includes(FEE_CONFLICT_MARKER), `the conflict is on the row: ${stored.notes}`);
  assert.ok(stored.notes.includes("12/23/2022") && stored.notes.includes("7-1-25"), "both document dates are on the row");
});

await check("and feeForProject then REFUSES to answer", () => {
  const resolved = feeForProject(db, project, "permit");
  assert.ok(resolved, "the schedule is still found");
  assert.equal(resolved.feeUsd, null, `a fee with two candidate values must not be answered: ${JSON.stringify(resolved)}`);
  assert.ok(/needs a human/i.test(resolved.reason), resolved.reason);
});

await check("a conflict already on file is not re-flattened by the next pass", async () => {
  const before = getFeeSchedule(db, KEY, "permit");
  const report = await harvestJurisdiction(db, { state: STATE, ahj: AHJ, pageUrl: `${base}/fees-page` }, { llm, apply: true });
  assert.equal(report.fee.action, "conflict_already_recorded", report.fee.reason);
  const after = getFeeSchedule(db, KEY, "permit");
  assert.equal(after.brackets.length, before.brackets.length, "nothing was added on top of the open question");
  assert.equal(after.updatedAt, before.updatedAt, "the row was not touched at all");
});

// ---------------------------------------------------------------------------
// 7. KILL-TESTING THE CONFLICT DETECTOR.
// ---------------------------------------------------------------------------
const candidate = (tag: string, brackets: Array<Partial<FeeCandidate["brackets"][number]>>): FeeCandidate => ({
  tag, name: tag, sourceUrl: `${base}/${tag}.pdf`, sourceQuote: "q", documentDate: "", documentDateIso: "",
  basis: "system_kw", origin: "harvested",
  brackets: brackets.map((b) => ({ minKw: null, maxKw: null, feeUsd: 0, label: "", ...b })),
});

await check("kill-test: two sources that AGREE are not a conflict", () => {
  const a = candidate("S1", [{ maxKw: 5, feeUsd: 135, label: "5 kva or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "x" }]);
  const b = candidate("S2", [{ maxKw: 5, feeUsd: 135, label: "Renewable energy 5 KVA or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "y" }]);
  assert.equal(detectFeeConflict([a, b]), null, "same numbers, different wording — agreement");
});

await check("kill-test: sources covering DIFFERENT rows are coverage, not conflict", () => {
  const a = candidate("S1", [{ maxKw: 5, feeUsd: 135, label: "5 or less" }]);
  const b = candidate("S2", [{ minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 to 15" }]);
  assert.equal(detectFeeConflict([a, b]), null, "no shared bracket, nothing to disagree about");
});

await check("kill-test: one source alone can never conflict with itself", () => {
  assert.equal(detectFeeConflict([candidate("S1", [{ maxKw: 5, feeUsd: 79 }, { minKw: 5.01, maxKw: 15, feeUsd: 94 }])]), null);
});

await check("kill-test: a flat fee disagreement is caught even with no bounds and no shared wording", () => {
  const a = candidate("S1", [{ feeUsd: 200, label: "Solar Permit (prescriptive path)" }]);
  const b = candidate("S2", [{ feeUsd: 250, label: "Rooftop photovoltaic installation" }]);
  const conflict = detectFeeConflict([a, b]);
  assert.ok(conflict, "two single-line sources that disagree on the price must still conflict");
  assert.equal(conflict.brackets[0].key, "flat");
});

await check("kill-test: keying on LABEL instead of BOUNDS misses the real conflict entirely", () => {
  // The obvious implementation, written here so it can be shown to fail on the real fixture's
  // wording. If bracketKey ever starts keying on the label, this test goes red.
  const naive = (a: FeeCandidate, b: FeeCandidate): boolean => {
    const byLabel = new Map(a.brackets.map((x) => [String(x.label).toLowerCase().trim(), x.feeUsd]));
    return b.brackets.some((x) => {
      const hit = byLabel.get(String(x.label).toLowerCase().trim());
      return hit != null && Math.abs(hit - x.feeUsd) >= 0.005;
    });
  };
  const app = candidate("S1", [
    { maxKw: 5, feeUsd: 79, label: "5 kva or less" },
    { minKw: 5.01, maxKw: 15, feeUsd: 94, label: "5.01 kva to 15 kva" },
    { minKw: 15.01, maxKw: 25, feeUsd: 156, label: "15.01 kva to 25 kva" },
  ]);
  const adopted = candidate("S2", [
    { maxKw: 5, feeUsd: 135, label: "Renewable energy 5 KVA or less" },
    { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "Renewable energy 5.01 KVA to 15 KVA" },
    { minKw: 15.01, maxKw: 25, feeUsd: 265, label: "Renewable energy 15.01 KVA to 25 KVA" },
  ]);
  assert.equal(naive(app, adopted), false, "the label-keyed detector finds NOTHING — this is the bug being prevented");
  const real = detectFeeConflict([app, adopted]);
  assert.ok(real, "keying on bounds finds it");
  assert.equal(real.brackets.length, 3);
  assert.equal(bracketKey({ minKw: null, maxKw: 5, feeUsd: 0 }), bracketKey({ minKw: null, maxKw: 5, feeUsd: 999 }),
    "the key is the bounds and nothing else");
});

// ---------------------------------------------------------------------------
// 8. Human-verified knowledge is never auto-overwritten.
// ---------------------------------------------------------------------------
await check("a form template whose map a human verified is left alone", async () => {
  const before = db.get<{ id: string; field_map: string; updated_at: string }>(
    "SELECT id, field_map, updated_at FROM ahj_form_templates WHERE lower(ahj_name) = lower(?) AND form_type = 'electrical_application'", [AHJ]);
  const map = JSON.parse(before.field_map);
  map.verified = true;
  map.textFields = { applicant_name: "project.homeownerName" }; // a human's narrower, correct map
  db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [JSON.stringify(map), before.id]);

  const report = await harvestJurisdiction(db, { state: STATE, ahj: AHJ, pageUrl: `${base}/solar-page` }, { llm, apply: true });
  const doc = report.documents.find((d) => d.formType === "electrical_application");
  assert.equal(doc.form.action, "skipped_verified", doc.form.note);

  const after = db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [before.id]);
  const afterMap = JSON.parse(after.field_map) as { verified: boolean; textFields: Record<string, string> };
  assert.equal(afterMap.verified, true, "storeAhjFormTemplate would have stamped verified:false over this");
  assert.equal(Object.keys(afterMap.textFields).length, 1, "the human's map is intact");
});

await check("a human-verified fee schedule is never rewritten, and the disagreement lands in its notes", async () => {
  const OTHER = "Verified County";
  const otherKey = feeScheduleProfileKey({ state: STATE, ahj: OTHER }, "permit");
  saveFeeSchedule(db, { state: STATE, ahj: OTHER, track: "permit" }, {
    found: true, reason: "", basis: "system_kw",
    brackets: [
      { maxKw: 5, feeUsd: 135, label: "5 KVA or less" },
      { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 KVA to 15 KVA" },
      { minKw: 15.01, maxKw: 25, feeUsd: 265, label: "15.01 KVA to 25 KVA" },
    ],
    notes: "hand-read from the adopted schedule", sourceUrl: `${base}/forms/community-development-fees.pdf`,
    sourceQuote: '"Renewable energy 5 KVA or less" | "$135.00"', sourceKind: "official",
  });
  markFeeScheduleVerified(db, otherKey, "permit", "the lead");

  const report = await harvestJurisdiction(db, { state: STATE, ahj: OTHER, pageUrl: `${base}/solar-page` }, { llm, apply: true });
  assert.equal(report.fee.action, "refused_verified", report.fee.reason);
  assert.ok(report.fee.conflict, "the disagreement is still reported to the operator");

  const after = getFeeSchedule(db, otherKey, "permit");
  assert.equal(after.confidence, "verified");
  assert.equal(after.basis, "system_kw", "a verified row is not turned into a conflicted one");
  assert.deepEqual(after.brackets.map((b) => b.feeUsd), [135, 160, 265], "the human's numbers stand");
  assert.ok(/NOT applied/.test(after.notes), `the finding went to notes: ${after.notes}`);
});

await check("a document that AGREES but prints fewer rows does not shrink the stored schedule", async () => {
  // The real shape: the lead's hand-read Coos County row carries FOUR brackets including the
  // ">25 kVA = $265 + $10/kVA" formula line; the adopted PDF yields three, because the fourth
  // is strictly-exclusive phrasing parseBracketRow refuses to guess at. The three AGREE, so
  // nothing conflicts — and storing the reading would quietly lose the largest tier.
  const WIDE = "Wide County";
  const wideKey = feeScheduleProfileKey({ state: STATE, ahj: WIDE }, "permit");
  saveFeeSchedule(db, { state: STATE, ahj: WIDE, track: "permit" }, {
    found: true, reason: "", basis: "system_kw",
    brackets: [
      { maxKw: 5, feeUsd: 135, label: "5 KVA or less" },
      { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 KVA to 15 KVA" },
      { minKw: 15.01, maxKw: 25, feeUsd: 265, label: "15.01 KVA to 25 KVA" },
      { minKw: 25.01, maxKw: 100, feeUsd: 265, label: "Solar >25 KVA: $265 + $10 per additional kVA — FORMULA, not flat" },
    ],
    notes: "hand-read by the lead", sourceUrl: `${base}/forms/community-development-fees.pdf`,
    sourceQuote: '"Renewable energy 5 KVA or less" | "$135.00"', sourceKind: "official",
  });

  const report = await harvestJurisdiction(db, { state: STATE, ahj: WIDE, pageUrl: `${base}/fees-page` }, { llm, apply: true });
  assert.equal(report.fee.conflict, null, "the rows it does print agree exactly");
  assert.equal(report.fee.action, "refused_less_coverage", report.fee.reason);
  assert.ok(/does not print 1 row/.test(report.fee.reason), report.fee.reason);
  assert.ok(/FORMULA/.test(report.fee.reason), "and names the row that would have been lost");

  const after = getFeeSchedule(db, wideKey, "permit");
  assert.equal(after.brackets.length, 4, "the wider table stands");
  const big = feeForProject(db, { ...project, ahj: WIDE, systemSizeAcKw: 30 } as typeof project, "permit");
  assert.equal(big.feeUsd, 265, "and a 30 kVA job still resolves instead of falling off the table");
});

// ---------------------------------------------------------------------------
// 9. A page we were refused is not a page with no forms on it.
// ---------------------------------------------------------------------------
await check("a walled page reports the wall, not an empty jurisdiction", async () => {
  const report = await harvestJurisdiction(db, { state: STATE, ahj: "Walled City", pageUrl: `${base}/walled` }, { llm });
  assert.equal(report.documents.length, 0);
  assert.ok(/UNREACHABLE/.test(report.pageReason), `pageReason: ${report.pageReason}`);
  assert.ok(/403/.test(report.pageReason), "and names the status that refused us");
  assert.ok(report.warnings.some((w) => /UNREACHABLE/.test(w)), "it is a warning, not a footnote");
  assert.equal(report.fee.action, "none");
});

await check("a 404 page is reported as reachable-but-empty, which is a different repair", async () => {
  const report = await harvestJurisdiction(db, { state: STATE, ahj: "Gone City", pageUrl: `${base}/missing` }, { llm });
  assert.ok(/UNREACHABLE|404/.test(report.pageReason), `pageReason: ${report.pageReason}`);
  assert.ok(!/permission/i.test(report.pageReason), "a 404 is not a wall");
});

// ---------------------------------------------------------------------------
// 10. Direct document links, with no page to index.
// ---------------------------------------------------------------------------
await check("direct document links (the KB carries plenty) are harvested with no page at all", async () => {
  const report = await harvestJurisdiction(db, { state: STATE, ahj: "Direct County" }, {
    llm,
    findPage: async () => ({ pageUrl: "", directUrls: [`${base}/forms/community-development-fees.pdf`], how: "knowledge base (free)" }),
  });
  assert.equal(report.documents.length, 1);
  assert.ok(report.documents[0].fee.found, report.documents[0].fee.reason);
  assert.equal(report.fee.action, "would_save");
  assert.deepEqual(report.documents[0].fee.brackets.map((b) => b.feeUsd), [135, 160, 265]);
  assert.equal(report.documents[0].documentDate, "Effective 7-1-25");
});

// ---------------------------------------------------------------------------
// 11. A WIND ROW IS NOT A SOLAR FEE, however cleanly it is paired.
//
// Measured on the real Coos County application, which prints wind sizes and solar
// sizes in one column under two headings. Every amount paired correctly with its
// own printed line, and the harvest still stored the wind rates as this
// jurisdiction's solar brackets: a 30 kVA job was quoted $204 and a 60 kVA job
// $469. Nothing about those rows is unreadable — the row says "25.01to50kva" and
// "$204.00" and means it. What it does not say is what it is a fee FOR.
// ---------------------------------------------------------------------------
await check("a fee row under a WIND heading never becomes a solar bracket", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 700;
  const line = (label: string, amount?: string): void => {
    draw(page, font, label, LABEL_X, y);
    if (amount) draw(page, font, amount, VALUE_X, y);
    y -= 34;
  };
  line("Renewable Energy");
  line("5 kva or less", "$79.00");
  line("Wind Generation Systems greater than 25 kva");
  line("25.01to50kva", "$204.00");
  line("50.01 kva to 100 kva", "$469.00");
  line("Solar Generation Systems greater than 25 kva");
  line("25.01 kva to 50 kva", "$162.25");

  const table = await readFeeTableFromPdf(await doc.save());
  assert.ok(table.found, table.reason);
  const stored = table.brackets.map((b) => b.feeUsd).sort((a, b) => a - b);
  assert.deepEqual(stored, [79, 162.25], `the wind rates must not be stored: ${JSON.stringify(table.brackets)}`);
  assert.ok(
    table.unreadableRows.some((r) => r.includes("204") && /Wind Generation/i.test(r)),
    `the wind row must be REPORTED with its heading, not silently dropped: ${JSON.stringify(table.unreadableRows)}`,
  );
  // ...and the solar row BELOW the wind block still lands: the heading advances.
  assert.ok(table.brackets.some((b) => b.feeUsd === 162.25 && b.minKw === 25.01 && b.maxKw === 50),
    `the row under the SOLAR heading must survive: ${JSON.stringify(table.brackets)}`);
});

server.close();
db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold the file */ }

console.log(failures === 0 ? "\njurisdictionHarvest: all checks passed\n" : `\njurisdictionHarvest: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
