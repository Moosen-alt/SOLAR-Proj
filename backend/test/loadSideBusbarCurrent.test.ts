// THE 120 % BUSBAR SCREEN MEASURES 125 % OF THE INVERTER OUTPUT CURRENT, NOT THE BREAKER (#153).
//
// city.elec.load-side-over-120 used to test main + PV BREAKER rating against 1.2 x bus. Since the
// 2017 NEC, 705.12(B)(3)(2) reads "125 percent of the power source output circuit current", and
// the breaker is always at least 1.25 x that current (rounded up to a standard size), so the
// breaker test blocked compliant designs. The worked case: 200 A bus, 200 A main, 50 A breaker,
// 32 A inverter: 250 A > 240 A on the breaker, but 1.25 x 32 + 200 = 240 A on the current, which
// passes. These checks pin the current reading, the breaker fallback when the current is unknown
// (said in the message), the pre-2017 edition keeping the breaker reading, and that a genuine
// violation still blocks.
// Run: tsx backend/test/loadSideBusbarCurrent.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext, type EffectiveCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { buildReviewerReport } from "../src/reviewerEngine";
import { MEASURED_FINDING_IDS } from "../src/reviewerVision";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ID = "city.elec.load-side-over-120";

// Synthetic project: a load-side breaker on a 200 A bus with a 200 A main and a 50 A PV breaker.
const mk = (over: Record<string, string>): ProjectRecord => ({
  id: "busbar-current", clientId: "c", homeownerName: "Busbar Probe", projectAddress: "1 Test Lane",
  city: "Testville", state: "OR", zip: "97000", ahj: "City of Testville",
  utility: "Test Power", accountNumber: "", meterNumber: "",
  systemSizeDcKw: 9, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Testville", utility: "Test Power",
    mounting: "Roof mount", interco: "Load-side breaker",
    busRating: "200A", mainBreaker: "200A", pvBreaker: "50",
    invMake: "TestInverter", invModel: "TI-7600", invQty: "1",
    planSetExtractedText: "705.12 BUSBAR CALCULATION SHOWN ON SHEET PV-4. 36\" FIRE ACCESS PATHWAY.",
    ...over,
  },
} as unknown as ProjectRecord);

const ctxOf = (adoptedCodes: JurisdictionCodeProfile["adoptedCodes"]): EffectiveCodeContext =>
  buildCodeContext("OR", "City of Testville", {
    key: "or|city of testville|unknown", state: "OR", ahj: "City of Testville", confidence: "seeded", adoptedCodes,
    amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  });
const NEC2014 = ctxOf([{ code: "NEC", edition: "2014" }]);
const NEC2023 = ctxOf([{ code: "NEC", edition: "2023" }]);

const busbar = (over: Record<string, string>, ctx?: EffectiveCodeContext): ReviewerFinding | undefined =>
  evaluateDesignCodeFindings(mk(over), null, ctx, [], []).find((f) => f.id === ID);

console.log("\n1. THE ISSUE'S CASE: 200 A bus / 200 A main / 50 A breaker / 32 A inverter passes");
check("no context: 1.25 x 32 + 200 = 240 A <= 240 A, no busbar blocker", () => {
  assert.equal(busbar({ invOutputW: "32" }), undefined);
});
check("2023 NEC adopted: same answer", () => {
  assert.equal(busbar({ invOutputW: "32" }, NEC2023), undefined);
});
check("through the engine: no busbar or load-side blocker at all", () => {
  const blockers = buildReviewerReport(mk({ invOutputW: "32" })).findings
    .filter((f) => f.severity === "blocker" && /busbar|load-side|120/i.test(`${f.id} ${f.title}`));
  assert.deepEqual(blockers.map((f) => f.id), []);
});

console.log("\n2. A GENUINE VIOLATION STILL BLOCKS, ON THE CURRENT");
check("string inverter 48 A: 1.25 x 48 + 200 = 260 A > 240 A blocks with the arithmetic", () => {
  const f = busbar({ invOutputW: "48", pvBreaker: "60" });
  assert.equal(f?.severity, "blocker");
  assert.match(f!.message, /1\.25 x 48 A = 60 A \+ 200A main = 260 A/);
  assert.match(f!.message, /705\.12\(B\)\(3\)\(2\)/);
});
check("micro system 30 x 1.21 A = 36.3 A: 1.25 x 36.3 + 200 = 245.38 A > 240 A blocks", () => {
  const f = busbar({ invMake: "", invModel: "", pvMicroMake: "TestMicro", pvMicroModel: "TM-300", pvMicroQty: "30", pvMicroOutputW: "1.21" });
  assert.equal(f?.severity, "blocker");
  assert.match(f!.message, /30 x 1\.21 A = 36\.3 A/);
});
check("a violation with no PV breaker captured still blocks on the current", () => {
  assert.equal(busbar({ invOutputW: "48", pvBreaker: "" })?.severity, "blocker");
});

console.log("\n3. CURRENT UNKNOWN: FALL BACK TO THE BREAKER, AND SAY SO");
check("no inverter current: 200 + 50 = 250 A > 240 A blocks on the breaker, message names the fallback", () => {
  const f = busbar({});
  assert.equal(f?.severity, "blocker");
  assert.match(f!.message, /200A main \+ 50A PV on a 200A bus/);
  assert.match(f!.message, /inverter output current is not captured/);
});
check("an implausible per-unit 'current' (a watt rating, 7600) is not used: breaker fallback", () => {
  const f = busbar({ invOutputW: "7600" });
  assert.equal(f?.severity, "blocker");
  assert.match(f!.message, /not captured/);
});

console.log("\n4. PRE-2017 NEC KEEPS THE BREAKER READING");
check("2014 NEC adopted: the 32 A inverter does not rescue the 50 A breaker, blocks and names the edition", () => {
  const f = busbar({ invOutputW: "32" }, NEC2014);
  assert.equal(f?.severity, "blocker");
  assert.match(f!.message, /200A main \+ 50A PV/);
  assert.match(f!.message, /2014 edition/);
});

console.log("\n5. STILL A MEASURED FINDING");
check(`${ID} stays in MEASURED_FINDING_IDS (vision may not relax it)`, () => {
  assert.ok(MEASURED_FINDING_IDS.has(ID));
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
