// THE IOWA SFM PV WORKSHEET AS A FORM: recognised by its own labels, filled through the real
// form-fill engine, and registered as a requirement where the per-job lookup stores documents.
//
// No public URL for the SFM blank has been retrieved, so the blank is recognised by ANCHORS —
// its printed labels at the exact positions the 2020-NEC edition prints them. The test draws a
// SYNTHETIC blank carrying those labels (pdf-lib, no customer data, not the operator's copy),
// stores it through acquireFromBytes (the upload path), fills it with buildFilledFormsForProject,
// and reads the filled text layer back at the value positions. A blank with one anchor moved or
// re-worded (the 2023-NEC edition circulates) is REFUSED, never filled with 2020 coordinates.
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapvform-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const clients = await import("../src/clients");
const ws = await import("../src/iowaPvWorksheet");
const auto = await import("../src/ahjFormAuto");
const forms = await import("../src/ahjForms");
const req = await import("../src/requiredDocuments");
const pp = await import("../src/permitProcess");
const { extractLabels } = await import("../src/formTextLayer");
const { createLLMProvider } = await import("../src/llm");

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

async function syntheticBlank(mutate?: (a: { page: number; text: string; x: number; y: number }) => { page: number; text: string; x: number; y: number } | null): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [0, 1, 2, 3].map(() => doc.addPage([612, 792]));
  for (const a0 of ws.IOWA_PV_WORKSHEET_ANCHORS) {
    const a = mutate ? mutate(a0) : a0;
    if (!a) continue;
    pages[a.page].drawText(a.text, { x: a.x, y: a.y, size: 10, font });
  }
  pages[0].drawText("SYNTHETIC TEST BLANK", { x: 72, y: 60, size: 8, font });
  return doc.save();
}

const client = clients.createClient(db, { companyName: "Prairie Form Test Solar LLC" });
const JOB = { owner: "Form Test Owner", street: "2 Synthetic Ave", city: "Iowa City", state: "IA", zip: "52240", ahj: "City of Iowa City",
  utility: "MidAmerican Energy", moduleMake: "Qcells", moduleModel: "SYNTH-395", moduleQty: "10", mounting: "Roof Mount", dwellingUnits: "1",
  pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US", pvMicroQty: "10", pvMicroOutputW: "1.21", azimuth: "180", tilt: "20",
  interco: "Load-side breaker", mainServiceRating: "200", mainBreaker: "200", busRating: "200", pvBreaker: "20", serviceVoltage: "240V",
  moduleVoc: "45.00", moduleVocTempCoeff: "-0.27", siteLowTempC: "-26" };
const make = (over: Record<string, unknown> = {}) => repo.getProjectDetail(db, repo.createProject(db, { clientId: client.id, ...JOB, ...over } as never).project.id).project;

// ── recognition ──────────────────────────────────────────────────────────────────────────
await check("(r1) MUST-PASS: a blank carrying every anchor at its position is recognised and mapped", async () => {
  const map = await ws.iowaPvWorksheetTemplate(await syntheticBlank(), "upload");
  assert.ok(map, "recognised");
  assert.equal(map!.fillMode, "overlay");
  assert.ok(map!.overlayFields.every((f) => f.source.startsWith("computed.iaPv.") || (f.source === "lit:X" && f.onlyIf?.source.startsWith("computed.iaPv."))));
  // attestations are placed but only ever tick on an "X" the values never produce
  assert.ok(map!.overlayFields.some((f) => f.onlyIf?.source === "computed.iaPv.p4.3"));
});
await check("(r2) MUST-EXCLUDE: one anchor moved 6 pt, one re-worded (2023 renumbering), or one missing -> refused", async () => {
  const moved = await syntheticBlank((a) => a.text === "NEC 705.12(B)(3)(2)" ? { ...a, y: a.y - 6 } : a);
  assert.equal(await ws.iowaPvWorksheetTemplate(moved, "upload"), null, "moved");
  const reworded = await syntheticBlank((a) => a.text === "NEC 705.12(B)(1)(a)" ? { ...a, text: "NEC 705.12(A)(1)" } : a);
  assert.equal(await ws.iowaPvWorksheetTemplate(reworded, "upload"), null, "2023-style row");
  const missing = await syntheticBlank((a) => a.text === "CALCULATION SHEET" ? null : a);
  assert.equal(await ws.iowaPvWorksheetTemplate(missing, "upload"), null, "missing");
});

// ── acquisition + fill through the real engine ───────────────────────────────────────────
await check("(f1) MUST-EXCLUDE: the Iowa worksheet uploaded for an Oregon AHJ is refused", async () => {
  const res = await auto.acquireFromBytes(db, createLLMProvider(), { ahj: "City of Maple Hollow", state: "OR", formType: "permit_application", formName: "upload.pdf", bytes: await syntheticBlank(), sourceUrl: "" });
  assert.equal(res.status, "needs_manual");
});
await check("(f2) MUST-PASS: uploaded for Iowa City it is stored as pv_worksheet, filled, and the filled page reads the derived values", async () => {
  const res = await auto.acquireFromBytes(db, createLLMProvider(), { ahj: "City of Iowa City", state: "IA", formType: "permit_application", formName: "PV Worksheet.pdf", bytes: await syntheticBlank(), sourceUrl: "" });
  assert.equal(res.status, "acquired", res.message);
  const row = db.get<{ form_type: string }>("SELECT form_type FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", ["City of Iowa City"]);
  assert.equal(row?.form_type, "pv_worksheet", "not reclassified as the prescriptive checklist");
  const p = make();
  const pkg = await forms.buildFilledFormsForProject(db, p);
  const filled = pkg.forms.find((f) => f.formName === ws.IOWA_PV_WORKSHEET_FORM_NAME);
  assert.ok(filled && filled.status === "filled" && filled.outputPath, JSON.stringify(pkg.forms.map((f) => [f.formName, f.status, f.message])));
  const labels = await extractLabels(new Uint8Array(fs.readFileSync(filled!.outputPath!)));
  const at = (page: number, x: number, y: number) => labels.filter((l) => l.page === page && Math.abs(l.x - x) < 1.5 && Math.abs(l.y - y) < 1.5).map((l) => l.str).join(" ");
  assert.equal(at(1, 242, 401), "51.2 V DC", "max system voltage");
  assert.equal(at(1, 242, 379), "12.1A", "circuit current");
  assert.equal(at(1, 242, 357), "10", "inverters");
  assert.equal(at(1, 242, 313), "20A", "min OCPD");
  assert.equal(at(1, 494, 379), "X", "load side box");
  assert.equal(at(1, 494, 401), "", "line side box empty");
  assert.equal(at(1, 168, 123), "X", "705.12(B)(3)(2) row");
  assert.equal(at(1, 168, 138), "", "705.12(B)(3)(1) row empty");
  assert.equal(at(3, 116, 396), "", "attestation item 3 left for the filer");
  assert.match(at(2, 90, 69), /^\(10 x 1\.21 A\) x 1\.25 = 15\.13 A -> 20 A OCPD/);
  // the unknown (service conductor) is reported as missing, not invented
  assert.ok((filled!.unmappedRequested ?? []).concat(filled!.message ?? "").join(" ").match(/service conductor/i), `missing list: ${filled!.unmappedRequested} / ${filled!.message}`);
});

// ── the requirement ──────────────────────────────────────────────────────────────────────
await check("(q1) MUST-PASS: Iowa City requires it (blocking, electrical, pv_worksheet) — path-independent", () => {
  const row = req.requiredApplicationDocs(make(), {}).find((d) => d.docType === "pv_worksheet");
  assert.ok(row, "row present");
  assert.equal(row!.blocking, true);
  assert.equal(row!.discipline, "electrical");
  assert.match(row!.why, /Standard or Micro-Inverter Array/);
});
await check("(q2) elsewhere in Iowa it is advisory; the per-job lookup's documents make it blocking for that AHJ", () => {
  const dsm = req.requiredApplicationDocs(make({ ahj: "City of Synthville", city: "Synthville" }), {}).find((d) => d.docType === "pv_worksheet");
  assert.ok(dsm && dsm.blocking === false, "advisory");
  const empty = (why: string) => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
  pp.savePermitProcessLookup(db, { state: "IA", ahj: "City of Synthville", issuingAgency: empty("n/a"), permitStructure: empty("n/a"), lookedUpAt: "2026-09-26T00:00:00Z",
    permits: [{ discipline: "electrical", label: "Electrical", issuingAgency: empty("n/a"), portalUrl: empty("n/a"), recordType: empty("n/a"),
      documents: { value: ["Site plan", "Photovoltaic Worksheet (State Fire Marshal)"], sourceUrl: "https://example.invalid/synthville/solar", quote: "Photovoltaic Worksheet", origin: "lookup" },
      fee: empty("n/a") }] } as never);
  const now = req.requiredApplicationDocs(make({ ahj: "City of Synthville", city: "Synthville" }), {}).find((d) => d.docType === "pv_worksheet");
  assert.ok(now && now.blocking === true, "lookup documents make it blocking");
  assert.match(now!.why, /Photovoltaic Worksheet \(State Fire Marshal\)/);
});
await check("(q3) MUST-EXCLUDE: an Oregon project is never asked for the Iowa worksheet", () => {
  const or = make({ state: "OR", ahj: "City of Maple Hollow", city: "Maple Hollow", zip: "97352" });
  assert.ok(!req.requiredApplicationDocs(or, { permitStructure: "separate", requiresPrescriptiveChecklist: true }).some((d) => d.docType === "pv_worksheet"));
  assert.equal(ws.namesPvWorksheet("Solar prescriptive checklist"), false);
  assert.equal(ws.namesPvWorksheet("Standard or Micro-Inverter Array Worksheet"), true);
});
await check("(q4) the filled worksheet counts as the document the row asks for: missing before the fill, present after", async () => {
  const p = make();
  const before = req.documentInventory(db, p).presence.find((d) => d.docType === "pv_worksheet");
  assert.ok(before, "row in the inventory");
  assert.equal(before!.present, false, "nothing filled yet");
  await forms.buildFilledFormsForProject(db, p);
  const after = req.documentInventory(db, p).presence.find((d) => d.docType === "pv_worksheet");
  assert.equal(after?.present, true, `after the fill: ${JSON.stringify(after)}`);
});

await check("(i1) an ambiguous interconnection is ASKED through intake; the answer lands on the project and settles the box", async () => {
  const intake = await import("../src/intakeRequests");
  const p = make({ interco: "Supply side tap / load side breaker" });
  const qs = await intake.unansweredPortalQuestions(db, p);
  const q = qs.find((x) => x.key === "iaPvInterconnection");
  assert.ok(q, `asked: ${qs.map((x) => x.key)}`);
  await intake.answerPortalQuestions(db, p.id, { iaPvInterconnection: "Load side (705.12)" });
  const after = repo.getProjectDetail(db, p.id).project;
  const v = ws.iowaPvWorksheetValues(after).values;
  assert.equal(v["p2.loadside"], "X"); assert.equal(v["p2.lineside"], "");
  assert.ok(!(await intake.unansweredPortalQuestions(db, after)).some((x) => x.key === "iaPvInterconnection"), "answered, no longer asked");
  // MUST-EXCLUDE: an Oregon project is never asked the Iowa worksheet's questions
  const or = make({ state: "OR", ahj: "City of Maple Hollow", city: "Maple Hollow", zip: "97352", interco: "Supply side tap / load side breaker" });
  assert.ok(!(await intake.unansweredPortalQuestions(db, or)).some((x) => x.key.startsWith("iaPv")));
});

console.log(failures ? `iowaPvWorksheetForm: ${failures} FAILED, ${passed} passed` : `iowaPvWorksheetForm: ${passed}/${passed} passed`);
if (failures) process.exit(1);
