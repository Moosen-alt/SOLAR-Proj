// GATE CHECKS FROM IOWA CITY'S REAL CORRECTION THEMES (pvWorksheetGate.ts), synthetic values.
//
// The corpus's applicant errors, each as a filed worksheet the gate must catch — and the same
// worksheet with the numbers right, which it must NOT flag:
//   circuit current as ONE micro's amps; max system voltage entered as 240 (AC); both / neither
//   interconnection box; a line-side connection with a load-side row; load side with no row or
//   several rows; a worksheet contradicting the plan's side (stale after a revision); arrays =
//   module count; a worksheet attached before the newest plan set; the one-line's MSP rating
//   disagreeing with the rest of the set (Roesler's 100/100 -> 200/200 correction).
// The filed worksheet is a SYNTHETIC blank (the anchor labels) with values drawn where a filer
// types them, read back by position through the real upload -> extraction -> reviewer path.
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pvwsgate-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const clients = await import("../src/clients");
const ws = await import("../src/iowaPvWorksheet");
const gate = await import("../src/pvWorksheetGate");
const docs = await import("../src/projectDocuments");

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

// A filed worksheet: the anchor labels + the typed values at the filer's positions.
type Filed = Partial<Record<"arrays" | "maxV" | "circuit" | "inverters" | "ocpd" | "line" | "load" | "bus", string>> & { rows?: string[] };
const ROW_Y: Record<string, number> = { B1a: 183, B1b: 168, B2: 152, B31: 137, B32: 122, B33: 107, B34: 91, B35: 76, B36: 61 };
async function filedWorksheet(f: Filed): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [0, 1, 2, 3].map(() => doc.addPage([612, 792]));
  for (const a of ws.IOWA_PV_WORKSHEET_ANCHORS) pages[a.page].drawText(a.text, { x: a.x, y: a.y, size: 10, font });
  const put = (v: string | undefined, x: number, y: number) => { if (v) pages[1].drawText(v, { x, y, size: 9, font }); };
  put(f.arrays, 80, 539); put(f.maxV, 242, 401); put(f.circuit, 242, 379); put(f.inverters, 242, 357); put(f.ocpd, 242, 313);
  put(f.line, 494, 401); put(f.load, 494, 379); put(f.bus, 494, 313);
  for (const r of f.rows ?? []) put("X", 168, ROW_Y[r] + 1);
  return doc.save();
}

const client = clients.createClient(db, { companyName: "Gate Test Solar LLC" });
const JOB = { owner: "Gate Test Owner", street: "3 Synthetic Ave", city: "Iowa City", state: "IA", zip: "52240", ahj: "City of Iowa City",
  utility: "MidAmerican Energy", moduleMake: "Qcells", moduleModel: "SYNTH-395", moduleQty: "10", mounting: "Roof Mount", dwellingUnits: "1",
  pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US", pvMicroQty: "10", pvMicroOutputW: "1.21", azimuth: "180", tilt: "20",
  interco: "Load-side breaker", mainServiceRating: "200", mainBreaker: "200", busRating: "200", pvBreaker: "20", serviceVoltage: "240V",
  moduleVoc: "45.00", moduleVocTempCoeff: "-0.27", siteLowTempC: "-26" };
const make = (over: Record<string, unknown> = {}) => repo.getProjectDetail(db, repo.createProject(db, { clientId: client.id, ...JOB, ...over } as never).project.id).project;
const GOOD: Filed = { arrays: "1", maxV: "51.2 V DC", circuit: "12.1A", inverters: "10", ocpd: "20A", load: "X", bus: "200", rows: ["B32"] };
const ids = async (f: Filed, over: Record<string, unknown> = {}, extra: Partial<Parameters<typeof gate.pvWorksheetFindings>[1]> = {}) => {
  const reading = await gate.readFiledPvWorksheet(await filedWorksheet(f));
  assert.ok(reading, "the filed worksheet reads");
  return gate.pvWorksheetFindings(make(over), { reading, ...extra });
};

await check("(r1) the filed worksheet reads back by position", async () => {
  const r = (await gate.readFiledPvWorksheet(await filedWorksheet(GOOD)))!;
  assert.equal(r.values["p2.maxCircuitCurrent"], "12.1A");
  assert.equal(r.values["p2.maxSystemVoltage"], "51.2 V DC");
  assert.equal(r.values["p2.loadside"], "X"); assert.equal(r.values["p2.lineside"], "");
  assert.deepEqual(r.lscRows, ["B32"]);
  assert.equal(r.values["p2.arrays"], "1");
});
await check("(x1) MUST-EXCLUDE: a worksheet whose numbers agree with the plan raises NOTHING", async () => {
  const f = await ids(GOOD, {}, { planText: "PV BREAKER AT OPPOSITE END PER NEC 705.12(B)(3)(2)" });
  assert.deepEqual(f.map((x) => x.id), []);
});
await check("(c1) MUST-PASS: circuit current = ONE micro's amps -> blocker naming both numbers", async () => {
  const f = (await ids({ ...GOOD, circuit: "1.21A" })).find((x) => x.id === "city.elec.pvws-circuit-current");
  assert.ok(f && f.severity === "blocker");
  assert.match(f!.message, /ONE inverter's output current/);
  assert.match(f!.message, /10 x 1\.21 A = 12\.1 A/);
});
await check("(c2) the ESS inverter counts: a worksheet leaving the battery out is flagged, one including it is not", async () => {
  const over = { batteryMake: "SynthStore", batteryModel: "SS-10", batteryQty: "1", batteryOutputKw: "5" };
  assert.ok((await ids({ ...GOOD, circuit: "12.1A", rows: [] , load: "X" }, over)).some((x) => x.id === "city.elec.pvws-circuit-current"));
  assert.ok(!(await ids({ ...GOOD, circuit: "32.93A" }, over)).some((x) => x.id === "city.elec.pvws-circuit-current"));
});
await check("(v1) MUST-PASS: max system voltage entered as 240 (the AC service) -> blocker with the 690.7 value", async () => {
  const f = (await ids({ ...GOOD, maxV: "240" })).find((x) => x.id === "city.elec.pvws-max-voltage-ac");
  assert.ok(f && f.severity === "blocker");
  assert.match(f!.message, /51\.2 V DC/);
});
await check("(v3) MUST-PASS: a '120/240V' service is named as the 240 V service it is, never 120", async () => {
  const f = (await ids({ ...GOOD, maxV: "240" }, { serviceVoltage: "120/240V" })).find((x) => x.id === "city.elec.pvws-max-voltage-ac");
  assert.ok(f); assert.match(f!.message, /the 240 V AC service/); assert.doesNotMatch(f!.message, /the 120 V AC service/);
});
await check("(v2) an uncorrected STC Voc -> the max-voltage warning; the corrected value -> nothing", async () => {
  assert.ok((await ids({ ...GOOD, maxV: "45.00 VOC" })).some((x) => x.id === "city.elec.pvws-max-voltage"));
  assert.ok(!(await ids({ ...GOOD, maxV: "51.5 V" })).some((x) => x.id.startsWith("city.elec.pvws-max-voltage")), "within 5%");
});
await check("(i1) MUST-PASS: both boxes / neither box / line side with a load-side row / load side with no row / four rows", async () => {
  assert.ok((await ids({ ...GOOD, line: "X" })).some((x) => x.id === "city.elec.pvws-interconnection-both"));
  assert.ok((await ids({ ...GOOD, load: undefined, rows: [] })).some((x) => x.id === "city.elec.pvws-interconnection-none"));
  const lineRow = await ids({ ...GOOD, load: undefined, line: "X" }, { interco: "Line side tap" });
  assert.ok(lineRow.some((x) => x.id === "city.elec.pvws-interconnection-line-side-row"));
  const noRow = (await ids({ ...GOOD, rows: [] })).find((x) => x.id === "city.elec.pvws-interconnection-rows");
  assert.ok(noRow); assert.match(noRow!.message, /leaves the 705\.12\(B\) section blank.*705\.12\(B\)\(3\)\(2\)/);
  assert.ok((await ids({ ...GOOD, rows: ["B1a", "B2", "B31", "B32"] })).some((x) => x.id === "city.elec.pvws-interconnection-rows"));
});
await check("(i2) MUST-PASS: a worksheet saying line side on a plan that now shows a load breaker (stale after revision)", async () => {
  const f = (await ids({ ...GOOD, load: undefined, line: "X", rows: [] })).find((x) => x.id === "city.elec.pvws-interconnection-contradicts-plan");
  assert.ok(f); assert.match(f!.message, /Load-side breaker/);
});
await check("(i3) the plan's own method: a different row is flagged; a 2017 citation maps to the 2020 row; a non-2020 citation is named, not mapped", async () => {
  assert.ok((await ids({ ...GOOD }, {}, { planText: "PER NEC 705.12(B)(3)(1) 100% RULE" })).some((x) => x.id === "city.elec.pvws-interconnection-row-differs"));
  assert.deepEqual((await ids({ ...GOOD }, {}, { planText: "120% RULE PER 705.12(B)(2)(3)(b)" })).map((x) => x.id), [], "2017 (B)(2)(3)(b) is the 2020 (B)(3)(2)");
  const odd = (await ids({ ...GOOD }, {}, { planText: "LOAD SIDE PER 705.12(B)(5)" })).find((x) => x.id === "city.elec.pvws-code-edition");
  assert.ok(odd && odd.severity === "callout"); assert.match(odd!.message, /705\.12\(B\)\(5\)/);
});
await check("(a1) MUST-PASS: arrays = module count is named as such; MUST-EXCLUDE the plane count", async () => {
  const all = await ids({ ...GOOD, arrays: "10" });
  const f = all.find((x) => x.id === "city.elec.pvws-arrays");
  assert.ok(f, all.map((x) => x.id).join(",")); assert.match(f!.title, /modules as arrays/);
  assert.ok(!(await ids({ ...GOOD, arrays: "2" }, { azimuth: "180/90", tilt: "20/20" })).some((x) => x.id === "city.elec.pvws-arrays"));
});
await check("(s1) worksheet attached before the newest plan set -> stale; after it -> nothing", async () => {
  assert.ok((await ids(GOOD, {}, { worksheetUploadedAt: "2026-09-01T00:00:00Z", newestPlanUploadedAt: "2026-09-10T00:00:00Z" })).some((x) => x.id === "city.elec.pvws-stale"));
  assert.ok(!(await ids(GOOD, {}, { worksheetUploadedAt: "2026-09-12T00:00:00Z", newestPlanUploadedAt: "2026-09-10T00:00:00Z" })).some((x) => x.id === "city.elec.pvws-stale"));
});
await check("(m1) MUST-PASS: the set states the existing MSP as 100 A on the one-line and 200 A elsewhere -> blocker quoting both", () => {
  const f = gate.serviceRatingConsistencyFindings(make(), "PV-5 LINE DIAGRAM (E) 100A MSP WITH 100A MAIN BREAKER ... PV-1 SITE PLAN (E) 200A MSP");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /100 A \("[^"]*100A MSP[^"]*"\) and 200 A/);
});
await check("(m2) MUST-EXCLUDE: agreeing ratings, a 225 A bus under a 200 A main, an MPU, and a NEW panel raise nothing", () => {
  const p = make();
  assert.deepEqual(gate.serviceRatingConsistencyFindings(p, "(E) 200A MSP ... MSP 200A ... 200A MAIN BREAKER"), []);
  assert.deepEqual(gate.serviceRatingConsistencyFindings(p, "(E) 200A MSP WITH 225A BUS AND 200A MAIN BREAKER"), []);
  assert.deepEqual(gate.serviceRatingConsistencyFindings(p, "MPU: REPLACE (E) 100A MSP WITH 200A MSP"), []);
  assert.deepEqual(gate.serviceRatingConsistencyFindings(p, "(N) 225A MSP ... (E) 200A MSP"), []);
  assert.deepEqual(gate.serviceRatingConsistencyFindings(p, "COMBINER PANEL 125A BUS ... MSP 200A BUS RATING 200A"), [], "a combiner's bus is not the service's");
  // Measured 2026-09-26: 0 fires on 48 Iowa City corpus plan-set texts and on both Roesler sets.
});
await check("(e2e) through the real path: upload -> extraction reads the worksheet -> the reviewer report carries the finding; an agreeing one carries none", async () => {
  const bad = make();
  docs.saveProjectDocument(db, bad.id, { docType: "pv_worksheet", filename: "worksheet.pdf", contentType: "application/pdf", buffer: Buffer.from(await filedWorksheet({ ...GOOD, maxV: "240" })) });
  const good = make();
  docs.saveProjectDocument(db, good.id, { docType: "pv_worksheet", filename: "worksheet.pdf", contentType: "application/pdf", buffer: Buffer.from(await filedWorksheet(GOOD)) });
  for (let i = 0; i < 100; i++) {
    const rows = db.query<{ form_reading_json: string }>("SELECT form_reading_json FROM project_documents WHERE project_id IN (?, ?)", [bad.id, good.id]);
    if (rows.length === 2 && rows.every((r) => r.form_reading_json)) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const badIds = repo.buildReviewerReportFor(db, repo.getProjectDetail(db, bad.id).project).findings.map((f) => f.id);
  assert.ok(badIds.includes("city.elec.pvws-max-voltage-ac"), badIds.join(","));
  const goodIds = repo.buildReviewerReportFor(db, repo.getProjectDetail(db, good.id).project).findings.map((f) => f.id);
  assert.ok(!goodIds.some((x) => x.startsWith("city.elec.pvws-") || x === "city.elec.service-rating-mismatch"), goodIds.filter((x) => x.includes("pvws")).join(","));
});

console.log(failures ? `pvWorksheetGate: ${failures} FAILED, ${passed} passed` : `pvWorksheetGate: ${passed}/${passed} passed`);
// The reviewer queues background code-profile research for an un-profiled state; exit explicitly.
process.exit(failures ? 1 : 0);
