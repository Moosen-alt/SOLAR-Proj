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

// parser.html's regex path on a micro + battery system: the micro's make/model/amps sit in
// invMake/invModel/invOutputW, and a Tesla battery swaps in the Powerwall model while invOutputW
// keeps the micro's 1.21 A when no battery kW was read.
const ENPHASE_5P = { ...SHAPE23, batteryMake: "Enphase", batteryModel: "IQ Battery 5P", batteryQty: "1", invMake: "Enphase", invModel: "IQ8PLUS-72-2-US", invQty: "10", invOutputW: "1.21" };
const PW3_MICRO_AMPS = { ...SHAPE23, batteryMake: "Tesla", batteryModel: "Powerwall 3", batteryQty: "1", invMake: "Tesla", invModel: "Powerwall 3", invQty: "1", invOutputW: "1.21" };
await check("(ess1) MUST-EXCLUDE the ESS current is never the micro's per-unit amps (micro model in the inverter fields, or a Powerwall carrying the micro's 1.21 A) -> blank + the ESS question", () => {
  for (const [name, over] of [["Enphase micro + IQ Battery 5P", ENPHASE_5P], ["micro + Powerwall 3 with the micro's amps", PW3_MICRO_AMPS],
    ["micro + battery, invOutputW with no inverter named", { ...SHAPE23, batteryMake: "SynthStore", batteryModel: "SS-10", batteryQty: "1", invOutputW: "1.21" }],
    ["micro + battery, an unnamed string-looking inverter", { ...SHAPE23, batteryMake: "SynthStore", batteryModel: "SS-10", batteryQty: "1", invMake: "Enphase", invModel: "IQ8M-72-2-US", invOutputW: "1.33" }]] as const) {
    const r = W(over);
    assert.equal(r.values["p2.maxCircuitCurrent"], "", `${name}: ${r.basis["p2.maxCircuitCurrent"]}`);
    assert.notEqual(r.values["p2.maxCircuitCurrent"], "13.31A", name);
    assert.equal(r.values["p2.minPvOcpd"], "20A", `${name}: falls back to the plan's PV breaker, not a computed OCPD`);
    assert.match(r.basis["p2.minPvOcpd"], /no circuit current to check it against/, name);
    assert.ok(r.questions.some((q) => q.key === "iaPvEssOutputA"), `${name}: the ESS question`);
  }
});
await check("(ess2) MUST-PASS the ESS inverter's own current: ONE battery's rated kW, or the operator's answer", () => {
  assert.equal(W({ ...ENPHASE_5P, batteryOutputKw: "3.84" }).values["p2.maxCircuitCurrent"], "28.1A", "12.1 + 3840/240 = 28.1");
  assert.equal(W({ ...ENPHASE_5P, batteryOutputKw: "3.84", batteryQty: "1" }).values["p2.maxCircuitCurrent"], "28.1A", "an explicit quantity of one files the same");
  assert.equal(W({ ...ENPHASE_5P, iaPvEssOutputA: "16" }).values["p2.maxCircuitCurrent"], "28.1A", "the operator's answer");
  assert.ok(!W({ ...ENPHASE_5P, iaPvEssOutputA: "16" }).questions.some((q) => q.key === "iaPvEssOutputA"));
  const answered = W({ ...PW3_MICRO_AMPS, invOutputW: "47.92", iaPvEssOutputA: "47.92" });
  assert.equal(answered.values["p3.C.calc"], "(10 x 1.21 A + ESS 47.92 A) x 1.25 = 75.03 A -> 80 A OCPD (NEC 240.6(A))", "the operator's answer drives the OCPD calc");
});
// Skeptic 2026-09-26 (MF2 look-alikes): on a micro system invOutputW holds the MICRO's amps even when a Powerwall
// is swapped into invMake/invModel, and a per-unit battery kW is not the total when there is more than one battery.
await check("(ess3) MUST-EXCLUDE invOutputW is never read as the ESS rating, and a per-unit kW is never filed for several batteries -> blank + the ESS question", () => {
  for (const [name, over] of [
    ["Powerwall named, invOutputW differs from pvMicroOutputW (the regex path)", { ...PW3_MICRO_AMPS, invOutputW: "47.92" }],
    ["Powerwall named, invOutputW 1.35 while pvMicroOutputW 1.21", { ...PW3_MICRO_AMPS, invOutputW: "1.35" }],
    ["two batteries at a per-unit 11.5 kW", { ...PW3_MICRO_AMPS, batteryOutputKw: "11.5", batteryQty: "2" }],
    ["two Enphase 5P at 3.84 kW each", { ...ENPHASE_5P, batteryOutputKw: "3.84", batteryQty: "2" }],
  ] as const) {
    const r = W(over);
    assert.equal(r.values["p2.maxCircuitCurrent"], "", `${name}: no circuit current filed`);
    assert.ok(r.questions.some((q) => q.key === "iaPvEssOutputA"), `${name}: the ESS question is asked`);
  }
});
// ── MF1: DC-DC converters come from the EQUIPMENT, never from prose ─────────────────────────
const STRING_JOB = { ...BASE, invMake: "SynthInverter", invModel: "SI-7600", invQty: "1", invOutputW: "32", moduleVoc: "40", moduleVocTempCoeff: "-0.27", siteLowTempC: "-26", modulesPerString: "10",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40", serviceVoltage: "240V" };
const RAIL_SHEET = "RAIL DATASHEET. INTEGRATED BONDING. SECURES AND BONDS MOST MICRO-INVERTERS AND OPTIMIZERS TO RAIL. CONNECTORS AND WIRES ROUTE UNDERNEATH.";
await check("(dc1) MUST-EXCLUDE optimizer PROSE is not equipment: a rail sheet's marketing line, 'MLPE (microinverters or optimizers)', an RSD datasheet listing its optimizer sibling", () => {
  const micro = W({ ...SHAPE23, electricalCalcText: "RAPID SHUTDOWN PER NEC 690.12 VIA MODULE LEVEL POWER ELECTRONICS (MICROINVERTERS OR OPTIMIZERS). GROUNDING ELECTRODE" });
  assert.equal(micro.values["p2.dcdc"], "N/A"); assert.equal(micro.values["p2.maxSystemVoltage"], "51.2 V DC");
  assert.ok(!micro.questions.some((q) => q.key === "iaPvDcDcMaxVoltage"));
  for (const [name, over] of [
    ["string + rapid-shutdown devices + a rail sheet", { ...STRING_JOB, mciMake: "SynthRSD", mciModel: "MCI-2", planSetExtractedText: `PV-3 ONE LINE. (10) SYNTHRSD MCI-2 RAPID SHUTDOWN DEVICES. ${RAIL_SHEET}` }],
    ["string + an RSD family datasheet", { ...STRING_JOB, planSetExtractedText: "RSD DATASHEET: TS4-A-F (FIRE SAFETY), TS4-A-O (OPTIMIZATION), TS4-A-S (SAFETY) - SELECT THE VARIANT. RAPID SHUTDOWN DEVICE: (10) TS4-A-F" }],
    ["string + 'works with optimizers' inverter sheet", { ...STRING_JOB, planSetExtractedText: "INVERTER DATASHEET. SPECIFICALLY DESIGNED TO WORK WITH POWER OPTIMIZERS. PAGE 3 POWER OPTIMIZER FOR NORTH AMERICA" }],
  ] as const) {
    const r = W(over);
    assert.notEqual(r.values["p2.dcdc"], "Yes", name);
    assert.equal(r.values["p2.maxSystemVoltage"], "455.1 V DC", `${name}: 40 x (1 + 0.0027 x 51) x 10 — the 690.7(A) value, not a DC-DC question`);
    assert.ok(!r.questions.some((q) => q.key === "iaPvDcDcMaxVoltage"), name);
    assert.match(r.basis["p2.dcdc"], /string inverter; no DC-DC converter/, name);
  }
});
await check("(dc2) MUST-PASS optimizers in the EQUIPMENT: a SolarEdge inverter, an MLPE field, or an equipment-schedule line -> DC-DC Yes + the 690.7(B) question", () => {
  for (const [name, over] of [
    ["label: (qty) make model", { ...STRING_JOB, planSetExtractedText: "EQUIPMENT SCHEDULE. INVERTER: (1) SYNTHINVERTER SI-7600. OPTIMIZER: (10) TIGO TS4-A-O. RACKING: SYNTH RAIL" }],
    ["qty new make label model", { ...STRING_JOB, planSetExtractedText: "(N) 10 SYNTH MODULES. 10 NEW SYNTHCO POWER OPTIMIZERS S440, MOUNTED ON THE BACK OF EACH MODULE." }],
    ["(qty) model label", { ...STRING_JOB, electricalCalcText: "STRING OF (10) P401 OPTIMIZERS & (10) SYNTH-400 MODULES" }],
    ["MLPE field", { ...STRING_JOB, mciMake: "Tigo", mciModel: "TS4-A-O" }],
    ["SolarEdge inverter fields", { ...STRING_JOB, invMake: "SolarEdge", invModel: "SE7600H-US" }],
  ] as const) {
    const r = W(over);
    assert.equal(r.values["p2.dcdc"], "Yes", name);
    assert.equal(r.values["p2.maxSystemVoltage"], "", name);
    assert.ok(r.questions.some((q) => q.key === "iaPvDcDcMaxVoltage"), name);
    assert.match(r.basis["p2.dcdc"], /in the equipment — /, name);
  }
});

// ── MF3: the 705.12(B) row through the EDITION it is cited under ─────────────────────────────
const lscRows = (r: ReturnType<typeof W>) => Object.keys(r.values).filter((k) => k.startsWith("p2.lsc.") && r.values[k] === "X");
await check("(lc1) MUST-PASS a citation maps through its edition and the plan's own facts: 2023 (B)(2) = 120%; untagged (B)(2) + a breaker/120% = 120%, + a tap = Taps; a 2017 shape tagged 2020 maps by shape", () => {
  // bus 225 so the arithmetic alone would say (B)(3)(1): only the citation can give (B)(3)(2)
  const r2023 = W({ ...SHAPE23, busRating: "225", labelsText: "WARNING INVERTER OUTPUT CONNECTION DO NOT RELOCATE THIS OVERCURRENT DEVICE 2023 NEC 705.12(B)(2) - STICKER AT MAIN PANEL" });
  assert.deepEqual(lscRows(r2023), ["p2.lsc.B32"]); assert.match(r2023.basis["p2.lsc.B32"], /plan's own method: .*2023 NEC 705\.12\(B\)\(2\).*-> 705\.12\(B\)\(3\)\(2\) \(2020 NEC row\)/);
  const untagged = W({ ...SHAPE23, busRating: "225", electricalCalcText: "BUSBAR: 120% RULE PER NEC 705.12(B)(2): 225 x 1.2 = 270 >= 200 + 20. GROUNDING ELECTRODE" });
  assert.deepEqual(lscRows(untagged), ["p2.lsc.B32"]);
  const tap = W({ ...SHAPE23, interco: "Load side tap", electricalCalcText: "PV CONNECTION PER NEC 705.12(B)(2). GROUNDING ELECTRODE" });
  assert.deepEqual(lscRows(tap), ["p2.lsc.B2"]);
  const t2020 = W({ ...SHAPE23, interco: "Load side tap", electricalCalcText: "PER 2020 NEC 705.12(B)(2) TAP CONDUCTORS SIZED PER 240.21(B)" });
  assert.deepEqual(lscRows(t2020), ["p2.lsc.B2"]);
  const mis = W({ ...SHAPE23, busRating: "225", electricalCalcText: "BACKFEED BREAKER PER 2020 NEC 705.12(B)(2)(3)(b) AT OPPOSITE END OF BUS" });
  assert.deepEqual(lscRows(mis), ["p2.lsc.B32"], "a 2017 shape tagged 2020 maps by its shape");
  // the tag is LOCAL: a spec sheet's 'NEC 2017' far away does not tag the plan's citation
  const far = W({ ...SHAPE23, busRating: "225", planSetExtractedText: `RSD UNIT NEC 2017 COMPLIANT. ${"SPEC DATA ".repeat(12)} BACKFED PV BREAKER PER 705.12(B)(2)` });
  assert.deepEqual(lscRows(far), ["p2.lsc.B32"]);
  assert.equal(ws.loadSideCitation("2023 NEC 705.12(B)(2)").row, "B32");
});
await check("(lc2) MUST-EXCLUDE a 2023 (B)(2) is never the 2020 Taps row; an unsettled edition/method is a question, never a guess; several cited rows establish nothing alone", () => {
  const r2023 = W({ ...SHAPE23, labelsText: "DO NOT RELOCATE THIS OVERCURRENT DEVICE 2023 NEC 705.12(B)(2)" });
  assert.equal(r2023.values["p2.lsc.B2"], "");
  const unsettled = W({ ...SHAPE23, interco: "Load side", electricalCalcText: "PV INTERCONNECTION PER NEC 705.12(B)(2). GROUNDING ELECTRODE" });
  assert.deepEqual(lscRows(unsettled), [], "untagged (B)(2) with neither a tap nor a breaker");
  const q = unsettled.questions.find((x) => x.key === "iaPvLoadSideRow");
  assert.ok(q && q.options.length === 9); assert.match(q!.label, /with no edition/);
  const other2023 = W({ ...SHAPE23, labelsText: "PER 2023 NEC 705.12(B)(3)" });
  assert.deepEqual(lscRows(other2023), []);
  assert.match(other2023.questions.find((x) => x.key === "iaPvLoadSideRow")!.label, /2023 NEC 705\.12\(B\)\(3\)/);
  const notes = "GENERAL NOTES: BACKFEED PER 2020 NEC 705.12(B)(3)(2) OR 2020 NEC 705.12(B)(3)(3) AS APPLICABLE";
  const both = W({ ...SHAPE23, electricalCalcText: notes }); // the ratings give (B)(3)(2), which the plan cites
  assert.deepEqual(lscRows(both), ["p2.lsc.B32"]); assert.match(both.basis["p2.lsc.B32"], /one of the rows the plan cites/);
  const neither = W({ ...SHAPE23, busRating: "225", electricalCalcText: notes }); // the ratings give (B)(3)(1), not cited
  assert.deepEqual(lscRows(neither), []);
  assert.match(neither.questions.find((x) => x.key === "iaPvLoadSideRow")!.label, /more than one 705\.12\(B\) subsection/);
  const heading = W({ ...SHAPE23, electricalCalcText: "BUSBAR PER NEC 705.12(B)(3). GROUNDING ELECTRODE" });
  assert.deepEqual(lscRows(heading), ["p2.lsc.B32"], "a bare (B)(3) heading lets the ratings pick the row");
  assert.ok(!heading.questions.some((x) => x.key === "iaPvLoadSideRow"));
});
await check("(sv1) MUST-PASS service voltage is the line-to-line value however the plan orders it: 240/120V, 120/240V, 120/240 1PH -> 240; 120/208 3PH -> 208", () => {
  for (const [raw, want] of [["240/120V", "240"], ["120/240V", "240"], ["120/240 1PH", "240"], ["240V", "240"], ["120/208V 3PH", "208"], ["277/480Y", "480"]] as const) {
    assert.equal(W({ ...SHAPE23, serviceVoltage: raw }).values["p2.serviceVoltage"], want, raw);
  }
  assert.equal(W({ ...SHAPE23, serviceVoltage: "", voltage: "240/120" }).values["p2.serviceVoltage"], "240", "the voltage field too");
});
await check("(sv2) MUST-EXCLUDE a split-phase service is never filed as 120, a current is never a voltage, nothing readable -> blank", () => {
  for (const raw of ["240/120V", "240/120 V 1PH 3W", "120/240V", "120V/240V"]) assert.notEqual(W({ ...SHAPE23, serviceVoltage: raw }).values["p2.serviceVoltage"], "120", raw);
  assert.equal(ws.serviceVoltageOf("200A 240/120V"), 240);
  assert.equal(ws.serviceVoltageOf("200A"), null);
  assert.equal(W({ ...SHAPE23, serviceVoltage: "split phase" }).values["p2.serviceVoltage"], "");
});

await check("(vb1) MUST-EXCLUDE a Voc coefficient outside 0.05-1 %/C (mV/C, x100, a fraction) is unknown: blank + the coefficient question, never the Table fallback, never a 3166 V", () => {
  for (const coeff of ["-136 mV/C", "-136 mV/°C", "-27", "-0.0027"]) {
    const r = W({ ...SHAPE23, moduleVocTempCoeff: coeff });
    assert.equal(r.values["p2.maxSystemVoltage"], "", coeff);
    assert.equal(r.values["p3.A1"], "", coeff); assert.equal(r.values["p3.A2"], "", `${coeff}: a broken read is not 'no coefficient'`);
    assert.equal(r.values["p3.A.calc"], "", coeff);
    const q = r.questions.find((x) => x.key === "moduleVocTempCoeff");
    assert.ok(q, `${coeff} asked`); assert.ok(q!.label.includes(coeff), "the question quotes the reading");
    assert.doesNotMatch(Object.values(r.values).join("|"), /3166/);
  }
});
await check("(vb2) MUST-EXCLUDE a computed max voltage above the micro's max DC input is never filed; the question names both numbers", () => {
  const r = W({ ...SHAPE23, pvMicroMaxDcInputV: "48" }); // 51.2 V > 48 V
  assert.equal(r.values["p2.maxSystemVoltage"], "");
  assert.equal(r.values["p3.A1"], ""); assert.equal(r.values["p3.A.calc"], "");
  const q = r.questions.find((x) => x.key === "iaPvMaxSystemVoltage");
  assert.ok(q); assert.match(q!.label, /51\.2 V DC per micro input, ABOVE the microinverter's 48 V maximum DC input/);
});
await check("(vb3) MUST-EXCLUDE above 600 V on a one-/two-family dwelling is never filed; MUST-PASS the same string elsewhere, and an operator answer, are filed", () => {
  const STR16 = { ...BASE, invMake: "SynthInverter", invModel: "SI-7600", invQty: "1", invOutputW: "32", moduleVoc: "40", siteLowTempC: "-26", modulesPerString: "16", interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40" };
  const r = W(STR16); // 40 x 1.21 x 16 = 774.4 V on an R-3 single-family
  assert.equal(r.values["p2.maxSystemVoltage"], "");
  const q = r.questions.find((x) => x.key === "iaPvMaxSystemVoltage");
  assert.ok(q); assert.match(q!.label, /774\.4 V DC, ABOVE the 600 V maximum/);
  const commercial = W({ ...STR16, dwellingUnits: "", constructionCategory: "B" });
  assert.equal(commercial.values["p2.maxSystemVoltage"], "774.4 V DC", "no 600 V ceiling off a one-/two-family dwelling");
  assert.equal(W({ ...STR16, iaPvMaxSystemVoltage: "580" }).values["p2.maxSystemVoltage"], "580 V DC", "the operator's answer settles the question");
  assert.equal(W(SHAPE23).values["p2.maxSystemVoltage"], "51.2 V DC", "a sane value inside both bounds still files");
});

await check("(q1) an operator's answers to the worksheet questions reach the form (arrays, load-side row, DC-DC max voltage, unit current)", () => {
  const none: Record<string, unknown> = { ...SHAPE23, iaPvArrayCount: "2" }; delete none.azimuth; delete none.tilt;
  assert.equal(W(none).values["p2.arrays"], "2");
  const odd = W({ ...SHAPE23, busRating: "150", iaPvLoadSideRow: "705.12(B)(3)(3)" }).values;
  assert.equal(odd["p2.lsc.B33"], "X"); assert.equal(odd["p2.lsc.B32"], "");
  const askRow = W({ ...SHAPE23, busRating: "150" }).questions.find((q) => q.key === "iaPvLoadSideRow");
  assert.ok(askRow && askRow.options.length === 9, "the row question is multiple choice (answerable through intake)");
  const se = W({ ...BASE, invMake: "SolarEdge", invModel: "SE7600H-US", invQty: "1", invOutputW: "32", iaPvDcDcMaxVoltage: "480" }).values;
  assert.equal(se["p2.maxSystemVoltage"], "480 V DC");
  const noA: Record<string, unknown> = { ...SHAPE23, iaPvUnitOutputA: "1.21" }; delete noA.pvMicroOutputW;
  assert.equal(W(noA).values["p2.maxCircuitCurrent"], "12.1A");
});
await check("(p1) parse: one stated module Voc / Isc / temperature coefficient is read from the datasheet text; two disagreeing tables are left for review", async () => {
  const { supplementStructuralIntake } = await import("../src/structuralIntake");
  const base = { provider: "stub", fields: {}, lowConfidenceFields: [], notes: "" } as never;
  const one = supplementStructuralIntake(base, "ELECTRICAL DATA (STC) OPEN-CIRCUIT VOLTAGE VOC 45.27 V SHORT-CIRCUIT CURRENT ISC 11.10 A TEMPERATURE COEFFICIENT OF VOC -0.27 %/K");
  assert.equal(one.fields.moduleVoc?.value, 45.27);
  assert.equal(one.fields.moduleIsc?.value, 11.1);
  assert.equal(one.fields.moduleVocTempCoeff?.value, -0.27);
  const two = supplementStructuralIntake(base, "PV05 MODULE TABLE VOC 48.96 V ... DATASHEET OPEN-CIRCUIT VOLTAGE VOC 45.27 V");
  assert.equal(two.fields.moduleVoc, undefined, "stale table vs datasheet: a conflict, not a pick");
});

console.log(failures ? `iowaPvWorksheet: ${failures} FAILED, ${passed} passed` : `iowaPvWorksheet: ${passed}/${passed} passed`);
if (failures) process.exit(1);
