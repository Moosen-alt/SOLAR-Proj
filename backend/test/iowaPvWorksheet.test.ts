// THE IOWA SFM PV WORKSHEET, DERIVED FROM THE PROJECT (the fill key, synthetic values).
//
// The fill key (.probe/kin/ia/roesler/worksheet-fill-key.json) maps every worksheet control to a
// parsed field, a derivation, or an operator question, and records what the operator's own
// filled copy got wrong: "48.96 VOC" (uncorrected STC Voc, and the other plan set's module),
// "10.19 ISC" (a module DC Isc where the micro AC branch current belongs), "Inverters = 10"
// against its own "(5 x 2.92)", Part A holding a current, Part B per-unit, the 705.12(B) row
// blank on a load-side connection, and the "complete and accurate" items ticked anyway. In the
// Iowa City corpus 3 of 5 worksheets entered 240 (the AC service) as the max system voltage.
//
// Two synthetic projects mirror the key's two shapes (values invented, same arithmetic):
//   SHAPE22: 5 two-module micros @ 2.92 A, 100 A service, LINE-side tap
//   SHAPE23: 10 micros @ 1.21 A, 200/200 A, 20 A load-side breaker (120% rule: 240-200=40 >= 20)
//
// KILL TESTS (mutations run 2026-09-26, results recorded in the commit message).
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapv-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const clients = await import("../src/clients");
const ws = await import("../src/iowaPvWorksheet");

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const client = clients.createClient(db, { companyName: "Prairie Test Solar LLC" });
const BASE = { owner: "Worksheet Test Owner", street: "1 Synthetic Ave", city: "Iowa City", state: "IA", zip: "52240", ahj: "City of Iowa City",
  utility: "MidAmerican Energy", moduleMake: "Qcells", mounting: "Roof Mount", dwellingUnits: "1", constructionCategory: "R-3",
  electricalCalcText: "(E) GROUNDING ELECTRODE SYSTEM. SEE SPEC SHEETS.", azimuth: "241", tilt: "12" };
const SHAPE22 = { ...BASE, dcKw: "4.0", moduleModel: "SYNTH-400", moduleQty: "10", pvMicroMake: "Hoymiles", pvMicroModel: "MI-700", pvMicroQty: "5", pvMicroOutputW: "2.92",
  interco: "Line side tap in MSP", mainServiceRating: "100", mainBreaker: "100", busRating: "100", pvBreaker: "20", serviceVoltage: "240V",
  moduleVoc: "48.00", moduleVocTempCoeff: "-0.28", siteLowTempC: "-26" };
const SHAPE23 = { ...BASE, dcKw: "3.95", moduleModel: "SYNTH-395", moduleQty: "10", pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US", pvMicroQty: "10", pvMicroOutputW: "1.21",
  interco: "Load-side breaker", mainServiceRating: "200", mainBreaker: "200", busRating: "200", pvBreaker: "20", serviceVoltage: "120/240V",
  moduleVoc: "45.00", moduleVocTempCoeff: "-0.27", siteLowTempC: "-26", pvMicroMaxDcInputV: "60" };
const make = (over: Record<string, unknown>) => repo.getProjectDetail(db, repo.createProject(db, { clientId: client.id, ...over } as never).project.id).project;
const W = (over: Record<string, unknown>) => ws.iowaPvWorksheetValues(make(over));

await check("(a1) MUST-PASS shape 2022: micro array, roof, RSD yes, 1 array, 5 inverters (not 10), N battery, N/A DC-DC", () => {
  const { values: v } = W(SHAPE22);
  assert.equal(v["p2.microArray"], "X"); assert.equal(v["p2.standardString"], "");
  assert.equal(v["p2.roofMount"], "X"); assert.equal(v["p2.groundMount"], "");
  assert.equal(v["p2.rsdYes"], "X"); assert.equal(v["p2.rsdNo"], "");
  assert.equal(v["p2.arrays"], "1");
  assert.equal(v["p2.numInverters"], "5");
  assert.equal(v["p2.battery"], "N");
  assert.equal(v["p2.dcdc"], "N/A");
});
await check("(a2) MUST-PASS circuit current = qty x per-unit A; OCPD = x1.25 -> next standard size", () => {
  const a = W(SHAPE22).values; const b = W(SHAPE23).values;
  assert.equal(a["p2.maxCircuitCurrent"], "14.6A");
  assert.equal(b["p2.maxCircuitCurrent"], "12.1A");
  assert.equal(a["p2.minPvOcpd"], "20A", "14.6 x 1.25 = 18.25 -> 20");
  assert.equal(b["p2.minPvOcpd"], "20A", "12.1 x 1.25 = 15.125 -> 20");
  assert.equal(ws.nextStandardOcpd(40.01), 45);
  assert.equal(ws.nextStandardOcpd(60), 60);
});
await check("(a3) MUST-PASS interconnection: line side -> 705.11 box and NO 705.12(B) row; load side 200/200/20 -> (B)(3)(2) only, arithmetic in the basis", () => {
  const a = W(SHAPE22);
  assert.equal(a.values["p2.lineside"], "X"); assert.equal(a.values["p2.loadside"], "");
  assert.ok(Object.keys(a.values).filter((k) => k.startsWith("p2.lsc.")).every((k) => a.values[k] === ""));
  const b = W(SHAPE23);
  assert.equal(b.values["p2.loadside"], "X"); assert.equal(b.values["p2.lineside"], "");
  const rows = Object.keys(b.values).filter((k) => k.startsWith("p2.lsc.") && b.values[k] === "X");
  assert.deepEqual(rows, ["p2.lsc.B32"]);
  assert.match(b.basis["p2.lsc.B32"], /200 A x 1\.2 - 200 A = 40 A >= 20 A PV breaker/);
  assert.equal(b.values["p2.serviceVoltage"], "240"); assert.equal(b.values["p2.serviceAmps"], "200"); assert.equal(b.values["p2.busRating"], "200");
});
await check("(a4) 100% rule when it holds; the plan's own cited subsection wins over the derivation", () => {
  const v = W({ ...SHAPE23, busRating: "225" }).values; // 1.25 x 12.1 + 200 = 215.1 <= 225
  assert.equal(v["p2.lsc.B31"], "X"); assert.equal(v["p2.lsc.B32"], "");
  const c = W({ ...SHAPE23, busRating: "225", labelsText: "PER NEC 705.12(B)(3)(2) PV BREAKER AT OPPOSITE END" });
  assert.equal(c.values["p2.lsc.B32"], "X"); assert.equal(c.values["p2.lsc.B31"], "");
  assert.match(c.basis["p2.lsc.B32"], /plan's own method/);
});
await check("(a5) MUST-PASS max system voltage is the 690.7(A)(1) corrected Voc (V DC), Part A shows volts, not amps", () => {
  const b = W(SHAPE23);
  // 45 x (1 + 0.0027 x 51) = 51.2
  assert.equal(b.values["p2.maxSystemVoltage"], "51.2 V DC");
  assert.equal(b.values["p3.A1"], "X");
  assert.match(b.values["p3.A.calc"], /^690\.7\(A\)\(1\): 45 V x \(1 \+ 0\.27%\/C x \(25 - \(-26\) C\)\) = 51\.2 V per micro input \(<= 60 V micro max DC input\)$/);
  assert.doesNotMatch(b.values["p3.A.calc"], /\d\s*A\b/);
});
await check("(a6) string: x modules in series; no coefficient -> Table 690.7(A) (the corpus's Voc x 1.21 at -26 C)", () => {
  const s = { ...BASE, invMake: "SynthInverter", invModel: "SI-7600", invQty: "1", invOutputW: "32", moduleVoc: "40", siteLowTempC: "-26", modulesPerString: "10", interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40" };
  const v = W(s).values;
  assert.equal(v["p2.standardString"], "X");
  assert.equal(v["p2.maxSystemVoltage"], "484 V DC", "40 x 1.21 x 10");
  assert.equal(v["p3.A2"], "X"); assert.equal(v["p3.A1"], "");
  assert.equal(v["p2.maxCircuitCurrent"], "32A");
  assert.equal(v["p2.minPvOcpd"], "40A");
});
await check("(a7) Part B is qty x A (the circuit), Part C writes the 1.25 x and the standard size", () => {
  const v = W(SHAPE22).values;
  assert.equal(v["p3.B.e"], "X");
  assert.equal(v["p3.B.calc"], "690.8(A)(1)(e) inverter output circuit: 5 x 2.92 A = 14.6 A");
  assert.equal(v["p3.C.B"], "X");
  assert.equal(v["p3.C.calc"], "(5 x 2.92 A) x 1.25 = 18.25 A -> 20 A OCPD (NEC 240.6(A))");
  assert.equal(v["p3.loc12fam"], "X");
});
await check("(e1) MUST-EXCLUDE max system voltage is NEVER the 240 V service, whatever is missing -> blank + the question", () => {
  for (const drop of ["moduleVoc", "siteLowTempC"]) {
    const over: Record<string, unknown> = { ...SHAPE22 }; delete over[drop];
    const r = W(over);
    assert.equal(r.values["p2.maxSystemVoltage"], "", `${drop} missing`);
    assert.ok(r.questions.some((q) => q.key === drop), `${drop} asked`);
    assert.doesNotMatch(Object.values(r.values).join("|"), /\b240 ?V\b/);
  }
  const str = { ...BASE, invMake: "SynthInverter", invModel: "SI-7600", invQty: "1", invOutputW: "32", moduleVoc: "40", siteLowTempC: "-26" };
  const r = W(str);
  assert.equal(r.values["p2.maxSystemVoltage"], "", "string without modules-in-series");
  assert.ok(r.questions.some((q) => q.key === "modulesPerString"));
});
await check("(e2) MUST-EXCLUDE a micro whose module Voc is unknown uses the micro's listed max DC input, never AC", () => {
  const over: Record<string, unknown> = { ...SHAPE23 }; delete over.moduleVoc;
  const v = W(over).values;
  assert.equal(v["p2.maxSystemVoltage"], "60 V DC");
});
await check("(e3) MUST-EXCLUDE optimizers: 690.7(B) is a question, no (A) value", () => {
  const r = W({ ...BASE, invMake: "SolarEdge", invModel: "SE7600H-US", invQty: "1", invOutputW: "32", moduleVoc: "40", siteLowTempC: "-26", modulesPerString: "10" });
  assert.equal(r.values["p2.maxSystemVoltage"], ""); assert.equal(r.values["p3.A1"], ""); assert.equal(r.values["p3.A2"], "");
  assert.equal(r.values["p2.dcdc"], "Yes");
  assert.ok(r.questions.some((q) => q.key === "iaPvDcDcMaxVoltage"));
});
await check("(e4) MUST-EXCLUDE arrays = planes, never the module count", () => {
  assert.equal(W({ ...SHAPE23, pvArrays: [{ quantity: 6, tilt: 20, azimuth: 180 }, { quantity: 4, tilt: 20, azimuth: 90 }] }).values["p2.arrays"], "2");
  assert.equal(W({ ...SHAPE23, pvArrays: [{ quantity: 6, tilt: 20, azimuth: 180 }, { quantity: 4, tilt: 20, azimuth: 180 }] }).values["p2.arrays"], "1", "same plane twice is one array");
  const none: Record<string, unknown> = { ...SHAPE23 }; delete none.azimuth; delete none.tilt;
  const r = W(none);
  assert.equal(r.values["p2.arrays"], "", `unknown, not moduleQty 10 (${r.basis["p2.arrays"]})`);
  assert.ok(r.questions.some((q) => q.key === "iaPvArrayCount"));
});
await check("(e5) MUST-EXCLUDE attestations 3, 4, 10 are never auto-ticked; the service conductor is a question", () => {
  const r = W(SHAPE23);
  for (const id of ["p4.3", "p4.4", "p4.10"]) assert.equal(r.values[id], "", id);
  assert.equal(r.values["p2.serviceConductor"], "");
  assert.ok(r.questions.some((q) => q.key === "serviceConductorSize"));
  assert.equal(W({ ...SHAPE23, serviceConductorSize: "4/0 AL" }).values["p2.serviceConductor"], "4/0 AL");
});
await check("(e6) ambiguous interconnection -> neither box, a question; a 2017-numbered '705.12(A)' on a line-side tap stays supply side", () => {
  const r = W({ ...SHAPE23, interco: "Supply side tap / load side breaker" });
  assert.equal(r.values["p2.lineside"], ""); assert.equal(r.values["p2.loadside"], "");
  assert.ok(r.questions.some((q) => q.key === "iaPvInterconnection"));
  assert.equal(ws.interconnectionSide("LINE SIDE TAP PER NEC 705.12(A)"), "supply");
  assert.equal(ws.interconnectionSide("Load-side breaker"), "load");
});
await check("(e7) AC-coupled ESS on a micro system adds its inverter amps to the circuit current", () => {
  const v = W({ ...SHAPE23, batteryMake: "SynthStore", batteryModel: "SS-10", batteryQty: "1", batteryOutputKw: "5" }).values;
  assert.equal(v["p2.battery"], "Y");
  assert.equal(v["p2.maxCircuitCurrent"], "32.93A", "12.1 + 5000/240 = 32.93");
});

console.log(failures ? `iowaPvWorksheet: ${failures} FAILED, ${passed} passed` : `iowaPvWorksheet: ${passed}/${passed} passed`);
if (failures) process.exit(1);
