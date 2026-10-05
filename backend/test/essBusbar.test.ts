// THE 120 % BUSBAR SCREEN ADDS AN AC-COUPLED ESS'S OUTPUT CURRENT (#159).
//
// 705.12(B)(3)(2) sums 125 % of every power source's output circuit current on the busbar. On a
// micro system with an AC-coupled battery, the battery is its own inverter: 20 x 1.21 A micros plus
// a 48 A ESS on a 200 A bus / 200 A main is 1.25 x (24.2 + 48) + 200 = 290.25 A > 240 A, which used
// to pass silently on the micros' 24.2 A alone (230.25 A). These checks pin: the ESS term blocks when
// every number is on the sheets, only warns when the ESS current is the parser's, stays the ONE
// busbar finding, and is NOT added for a DC-coupled ESS, an ESS on another bus, or a string-inverter
// battery whose coupling is not stated. An unknown ESS current is asked for, never guessed.
// Run: tsx backend/test/essBusbar.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext, type EffectiveCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ID = "city.elec.sizing-busbar-120";
const MISSING = "city.elec.sizing-inputs-missing";

// Synthetic micro + battery project. The sheet states the bus, main, PV breaker, the micros'
// current and quantity; `extra` adds sheet lines (the ESS current, its coupling, where it lands).
const MICRO: Record<string, string> = {
  busRating: "200A", mainBreaker: "200A", pvBreaker: "40",
  pvMicroMake: "TestMicro", pvMicroModel: "TM-300", pvMicroQty: "20", pvMicroOutputW: "1.21",
  batteryMake: "TestStore", batteryModel: "TS-13", batteryQty: "1", batteryOutputKw: "11.52",
};
const MICRO_SHEET = [
  "705.12 BUSBAR CALCULATION SHOWN ON SHEET PV-4.",
  "BUS RATING 200 A. MAIN BREAKER 200 A. PV BREAKER 40 A.",
  "MAX CONTINUOUS OUTPUT CURRENT 1.21 A. (20) TESTMICRO TM-300 MICROINVERTERS.",
].join(" ");
const ESS_STATED = "BATTERY MAX CONTINUOUS OUTPUT CURRENT 48 A.";

const mk = (snapshot: Record<string, string>, extra: string[]): ProjectRecord => ({
  id: "ess-busbar", clientId: "c", homeownerName: "Busbar Probe", projectAddress: "1 Test Lane",
  city: "Testville", state: "OR", zip: "97000", ahj: "City of Testville",
  utility: "Test Power", accountNumber: "", meterNumber: "",
  systemSizeDcKw: 8, systemSizeAcKw: 6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Testville", utility: "Test Power",
    mounting: "Roof mount", interco: "Load-side breaker",
    ...snapshot,
    planSetExtractedText: [MICRO_SHEET, ...extra].join(" "),
  },
} as unknown as ProjectRecord);

const NEC2014: EffectiveCodeContext = buildCodeContext("OR", "City of Testville", {
  key: "or|city of testville|unknown", state: "OR", ahj: "City of Testville", confidence: "seeded",
  adoptedCodes: [{ code: "NEC", edition: "2014" }] as JurisdictionCodeProfile["adoptedCodes"],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
});

const findings = (snapshot: Record<string, string>, extra: string[], ctx?: EffectiveCodeContext): ReviewerFinding[] =>
  evaluateDesignCodeFindings(mk(snapshot, extra), null, ctx, [], []);
const busbars = (snapshot: Record<string, string>, extra: string[], ctx?: EffectiveCodeContext): ReviewerFinding[] =>
  findings(snapshot, extra, ctx).filter((f) => f.id === ID);

console.log("\n1. THE ISSUE'S CASE: 20 x 1.21 A micros + 48 A AC-coupled ESS, 200 A bus / 200 A main");
check("baseline without a battery: 1.25 x 24.2 + 200 = 230.25 A <= 240 A passes", () => {
  const { batteryMake: _m, batteryModel: _b, batteryQty: _q, batteryOutputKw: _k, ...noBattery } = MICRO;
  assert.equal(busbars(noBattery, []).length, 0);
});
check("every number on the sheets: (24.2 + 48) x 1.25 + 200 = 290.25 A > 240 A BLOCKS", () => {
  const all = busbars(MICRO, [ESS_STATED]);
  assert.equal(all.length, 1, "exactly one busbar finding");
  const f = all[0];
  assert.equal(f.severity, "blocker");
  assert.match(f.message, /AC-coupled ESS output current 48 A/);
  assert.match(f.message, /= 72\.2 A; 1\.25 x 72\.2 A = 90\.25 A/);
  assert.match(f.message, /= 290\.25 A, above 120 % of the 200 A busbar/);
  assert.match(f.message, /705\.12\(B\)\(3\)\(2\)/);
  assert.ok(f.evidenceNeeded?.some((e) => /ESS/.test(e)), "the ESS current is named in the evidence");
});
check("the ESS stated as AC-coupled on the sheets: same blocker", () => {
  const f = busbars(MICRO, [ESS_STATED, "AC-COUPLED ENERGY STORAGE SYSTEM."])[0];
  assert.equal(f?.severity, "blocker");
});
check("an operator answer for the ESS current is used (iaPvEssOutputA wins over kW)", () => {
  const f = busbars({ ...MICRO, iaPvEssOutputA: "48A", batteryOutputKw: "5" }, [ESS_STATED])[0];
  assert.equal(f?.severity, "blocker");
  assert.match(f.message, /290\.25 A/);
});
check("the battery's kW stated on the sheets is document-stated too (11.52 kW / 240 V = 48 A)", () => {
  const f = busbars(MICRO, ["BATTERY: TESTSTORE TS-13, 11.52 KW CONTINUOUS."])[0];
  assert.equal(f?.severity, "blocker");
});

console.log("\n2. PROVENANCE: a parser-only ESS current warns, never blocks");
check("ESS current not stated on the sheets -> warning, marked (parser)", () => {
  const all = busbars(MICRO, []);
  assert.equal(all.length, 1);
  assert.equal(all[0].severity, "warning");
  assert.match(all[0].message, /48 A \(parser\)/);
  assert.match(all[0].message, /essOutputA/);
});

console.log("\n3. NOT ADDED: DC-coupled, another bus, string inverter with no stated coupling");
check("DC-coupled ESS: the inverter's current already carries it -> passes", () => {
  assert.equal(busbars(MICRO, [ESS_STATED, "DC-COUPLED BATTERY."]).length, 0);
});
check("ESS on the supply side -> not on this busbar -> passes", () => {
  assert.equal(busbars(MICRO, [ESS_STATED, "BATTERY INTERCONNECTED ON THE SUPPLY SIDE OF THE MAIN DISCONNECT."]).length, 0);
});
check("ESS in a separate panel -> passes", () => {
  assert.equal(busbars(MICRO, [ESS_STATED, "ENERGY STORAGE SYSTEM LANDS ON A SEPARATE PANEL."]).length, 0);
});
check("string inverter + battery, coupling not stated -> not added", () => {
  const string = {
    busRating: "200A", mainBreaker: "200A", pvBreaker: "40", invMake: "TestInverter", invModel: "TI-6000", invQty: "1", invOutputW: "25",
    batteryMake: "TestStore", batteryModel: "TS-13", batteryQty: "1", batteryOutputKw: "11.52",
  };
  // 1.25 x 25 + 200 = 231.25 A passes; adding 48 A would be 291.25 A.
  assert.equal(busbars(string, [ESS_STATED, "MAX CONTINUOUS OUTPUT CURRENT 25 A."]).length, 0);
  const f = busbars(string, [ESS_STATED, "MAX CONTINUOUS OUTPUT CURRENT 25 A.", "AC-COUPLED BATTERY."])[0];
  assert.equal(f?.severity, "blocker", "stated AC-coupled on a string system adds it");
  assert.match(f.message, /291\.25 A/);
});

console.log("\n4. UNKNOWN ESS CURRENT: asked for, never guessed");
check("two batteries, no answer -> no busbar finding, the inputs callout names the ESS current", () => {
  const all = findings({ ...MICRO, batteryQty: "2" }, []);
  assert.equal(all.filter((f) => f.id === ID).length, 0);
  const missing = all.find((f) => f.id === MISSING);
  assert.ok(missing && /AC-coupled ESS/.test(missing.message), `inputs-missing names the ESS: ${missing?.message}`);
});

console.log("\n5. PRE-2017 NEC: the breaker reading is that edition's test, unchanged");
check("2014 NEC: 40 A breaker + 200 A = 240 A passes, no ESS term", () => {
  assert.equal(busbars(MICRO, [ESS_STATED], NEC2014).length, 0);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
