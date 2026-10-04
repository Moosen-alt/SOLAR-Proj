// THE 120 % BUSBAR SCREEN MEASURES 125 % OF THE INVERTER OUTPUT CURRENT, NOT THE BREAKER (#153).
//
// The legacy city.elec.load-side-over-120 tested main + PV BREAKER rating against 1.2 x bus. Since
// the 2017 NEC, 705.12(B)(3)(2) reads "125 percent of the power source output circuit current",
// and the breaker is always at least 1.25 x that current (rounded up to a standard size), so the
// breaker test blocked compliant designs. The worked case: 200 A bus, 200 A main, 50 A breaker,
// 32 A inverter: 250 A > 240 A on the breaker, but 1.25 x 32 + 200 = 240 A on the current, which
// passes. That rule is retired; city.elec.sizing-busbar-120 (electricalSizing.ts) is the ONE busbar
// rule. These checks pin the current reading, the breaker fallback when the current is unknown or
// implausible (said in the message), the pre-2017 edition keeping the breaker reading, that a
// genuine violation still blocks, that a parser-only violation only warns, and that the legacy id
// is gone.
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

const ID = "city.elec.sizing-busbar-120";
const LEGACY = "city.elec.load-side-over-120";

// Synthetic project: a load-side breaker on a 200 A bus with a 200 A main and a 50 A PV breaker.
// The plan set's own sheet states every value the snapshot carries, so a violation is a BLOCKER
// (#152's provenance rule); `parserOnly` drops the statements so the same numbers only warn.
const SHEET_LABELS: Record<string, string> = {
  busRating: "BUS RATING", mainBreaker: "MAIN BREAKER", pvBreaker: "PV BREAKER",
  invOutputW: "MAX CONTINUOUS OUTPUT CURRENT", pvMicroOutputW: "MAX CONTINUOUS OUTPUT CURRENT",
};
const sheetFor = (fields: Record<string, string>): string => [
  "705.12 BUSBAR CALCULATION SHOWN ON SHEET PV-4. 36\" FIRE ACCESS PATHWAY.",
  ...Object.entries(SHEET_LABELS).filter(([k]) => fields[k]).map(([k, label]) => `${label} ${parseFloat(fields[k])} A.`),
  fields.pvMicroQty && fields.pvMicroModel ? `(${fields.pvMicroQty}) TESTMICRO ${fields.pvMicroModel} MICROINVERTERS.` : "",
].join(" ");

const BASE: Record<string, string> = {
  busRating: "200A", mainBreaker: "200A", pvBreaker: "50",
  invMake: "TestInverter", invModel: "TI-7600", invQty: "1",
};
const mk = (over: Record<string, string>, parserOnly = false): ProjectRecord => ({
  id: "busbar-current", clientId: "c", homeownerName: "Busbar Probe", projectAddress: "1 Test Lane",
  city: "Testville", state: "OR", zip: "97000", ahj: "City of Testville",
  utility: "Test Power", accountNumber: "", meterNumber: "",
  systemSizeDcKw: 9, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Testville", utility: "Test Power",
    mounting: "Roof mount", interco: "Load-side breaker",
    ...BASE,
    ...over,
    planSetExtractedText: parserOnly ? sheetFor({}) : sheetFor({ ...BASE, ...over }),
  },
} as unknown as ProjectRecord);

const ctxOf = (adoptedCodes: JurisdictionCodeProfile["adoptedCodes"]): EffectiveCodeContext =>
  buildCodeContext("OR", "City of Testville", {
    key: "or|city of testville|unknown", state: "OR", ahj: "City of Testville", confidence: "seeded", adoptedCodes,
    amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  });
const NEC2014 = ctxOf([{ code: "NEC", edition: "2014" }]);
const NEC2023 = ctxOf([{ code: "NEC", edition: "2023" }]);

const findings = (over: Record<string, string>, ctx?: EffectiveCodeContext, parserOnly = false): ReviewerFinding[] =>
  evaluateDesignCodeFindings(mk(over, parserOnly), null, ctx, [], []);
const busbar = (over: Record<string, string>, ctx?: EffectiveCodeContext, parserOnly = false): ReviewerFinding | undefined =>
  findings(over, ctx, parserOnly).find((f) => f.id === ID);

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
  assert.match(f!.message, /1\.25 x 48 A = 60 A \+ 200 A main = 260 A/);
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
  assert.match(f!.message, /PV breaker 50 A \+ 200 A main = 250 A, above 120 % of the 200 A busbar/);
  assert.match(f!.message, /inverter output current is not stated; 125 percent of that current is the 2017\+ NEC test and may pass/);
  assert.ok(f!.evidenceNeeded.includes("Inverter maximum continuous output current and quantity"), "fallback does not ask for the current");
});
check("an implausible per-unit 'current' (a watt rating, 7600) is not used: breaker fallback", () => {
  const f = busbar({ invOutputW: "7600" });
  assert.equal(f?.severity, "blocker");
  assert.match(f!.message, /PV breaker 50 A/);
  assert.match(f!.message, /not stated/);
});
check("current-based message asks for the inverter output current, not the breaker rating", () => {
  const f = busbar({ invOutputW: "48", pvBreaker: "60" });
  assert.ok(f!.evidenceNeeded.includes("Inverter maximum continuous output current and quantity"));
  assert.ok(!f!.evidenceNeeded.some((e) => /breaker \/ OCPD/i.test(e)), JSON.stringify(f!.evidenceNeeded));
});

console.log("\n4. PRE-2017 NEC KEEPS THE BREAKER READING");
check("2014 NEC adopted: the 32 A inverter does not rescue the 50 A breaker, blocks and names the edition", () => {
  const f = busbar({ invOutputW: "32" }, NEC2014);
  assert.equal(f?.severity, "blocker");
  assert.match(f!.message, /PV breaker 50 A \+ 200 A main = 250 A/);
  assert.match(f!.message, /adopted NEC is the 2014 edition/);
});
check("2014 NEC adopted and a compliant breaker (40 A): passes on the breaker reading", () => {
  assert.equal(busbar({ invOutputW: "32", pvBreaker: "40" }, NEC2014), undefined);
});
check("2014 NEC adopted: message and citation use that edition's section, 705.12(D)(2)(3)(b)", () => {
  const f = busbar({ invOutputW: "32" }, NEC2014)!;
  assert.match(f.message, /^705\.12\(D\)\(2\)\(3\)\(b\): /);
  assert.ok(!/705\.12\(B\)/.test(JSON.stringify(f)), JSON.stringify(f));
  assert.deepEqual(f.codeReferences.map((r) => r.section), ["705.12(D)(2)(3)(b)"]);
});
check("no context: the citation stays 705.12(B)(3)(2)", () => {
  const f = busbar({ invOutputW: "48", pvBreaker: "60" })!;
  assert.match(f.message, /^705\.12\(B\)\(3\)\(2\): /);
  assert.deepEqual(f.codeReferences.map((r) => r.section), ["705.12(B)(3)(2)"]);
});

console.log("\n5. PROVENANCE: A PARSER-ONLY VIOLATION WARNS, IT NEVER BLOCKS (#152)");
check("the 48 A violation with nothing stated on the sheets is a WARNING", () => {
  const f = busbar({ invOutputW: "48", pvBreaker: "60" }, undefined, true);
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /\(parser\)/);
});
check("the breaker fallback with nothing stated on the sheets is a WARNING", () => {
  assert.equal(busbar({}, undefined, true)?.severity, "warning");
});

console.log("\n6. ONE BUSBAR RULE");
check(`${ID} stays in MEASURED_FINDING_IDS (vision may not relax it)`, () => {
  assert.ok(MEASURED_FINDING_IDS.has(ID));
});
check(`the legacy ${LEGACY} is retired: never produced, not in the measured set`, () => {
  for (const over of [{}, { invOutputW: "48", pvBreaker: "60" }, { invOutputW: "32" }]) {
    assert.ok(!findings(over).some((f) => f.id === LEGACY));
    assert.ok(!findings(over, NEC2014).some((f) => f.id === LEGACY));
  }
  assert.ok(!MEASURED_FINDING_IDS.has(LEGACY));
});
check("through the engine: exactly one busbar finding for a violation", () => {
  const ids = buildReviewerReport(mk({ invOutputW: "48", pvBreaker: "60" })).findings.map((f) => f.id)
    .filter((id) => id === ID || id === LEGACY);
  assert.deepEqual(ids, [ID]);
});
check("through the engine: the busbar finding keeps the SLD crop slot the legacy finding carried", () => {
  const p = mk({ invOutputW: "48", pvBreaker: "60" });
  p.parserSnapshot!.planSetExtractedText += " SHEET PV-3 ONE-LINE DIAGRAM.";
  const f = buildReviewerReport(p).findings.find((x) => x.id === ID)!;
  const slot = f.evidenceFound?.find((e) => e.kind === "screenshot_placeholder");
  assert.ok(slot, JSON.stringify(f.evidenceFound));
  assert.match(slot!.screenshotPath, /evidence-image\?topic=sld/);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
