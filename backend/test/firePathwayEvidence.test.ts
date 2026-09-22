// A ZONING SETBACK IS NOT A FIREFIGHTER ACCESS PATHWAY.
//
// The fire-pathway evidence test accepted the bare words "setback", "ridge" and "eave", then
// granted HIGH confidence if any dimension appeared anywhere in the document. Every residential
// roof plan labels a ridge and an eave; every site plan carries zoning setbacks; solar plan sets
// are wall-to-wall dimensions. So the topic read present/high for essentially every plan set and
// BOTH fire rules — codeReviewRules' city.fire.pathways-missing and the engine's
// reviewer.plan.fire-path — stayed silent.
//
// Measured before the fix: a plan set with NO fire content produced a byte-identical report to
// the same set carrying a dimensioned IFC 1205.2 pathway. A life-safety review that cannot tell
// those apart is not a review. That is a false CLEAR, the opposite and more dangerous sibling of
// the false blockers fixed alongside it.
//
// The vocabulary is harvested from the operator's own 23-project corpus, not invented: the real
// phrases are "FIRE PATHWAY", "FIRE ACCESS" and '36" FIRE SETBACK'. That last one is why
// proximity matters — "setback" IS fire evidence when it is a fire setback and is not when it is
// a lot line.
// Run: tsx backend/test/firePathwayEvidence.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";
import { evidenceForTopic } from "../src/projectEvidence";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// An ordinary, complete plan set that says NOTHING about firefighter access. Every phrase is
// standard draughting vocabulary: zoning setbacks on the site plan, ridge and eave labels on
// the roof plan, dimensions throughout.
const NO_FIRE = [
  "SHEET PV-1 COVER. 9.6 kW DC ROOFTOP PV, 24 MODULES, 400W EACH.",
  "SHEET PV-2 SITE PLAN. PROPERTY LINE. FRONT SETBACK 20 FT, SIDE SETBACK 5 FT PER ZONING.",
  "SHEET PV-3 ROOF PLAN. ARRAY 32 FT x 11 FT. RIDGE AND EAVE LABELED. ROOF SLOPE 5:12.",
  "SHEET PV-4 SINGLE LINE DIAGRAM. LOAD SIDE BREAKER, BUS 225A, MAIN 175A, PV 40A.",
].join("\n");

const mk = (text: string): ProjectRecord => ({
  id: "fire", clientId: "c", homeownerName: "Fire Probe", projectAddress: "1 Roof Way",
  city: "Salem", state: "OR", zip: "97301", ahj: "City of Salem",
  utility: "Portland General Electric", accountNumber: "1234567890", meterNumber: "987654",
  systemSizeDcKw: 9.6, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Salem", utility: "Portland General Electric",
    mounting: "Roof mount", interco: "Load-side breaker",
    busRating: "225A", mainBreaker: "175A", pvBreaker: "40",
    planSetExtractedText: text,
  },
} as unknown as ProjectRecord);

const fireIds = (text: string): string[] =>
  buildReviewerReport(mk(text)).findings
    .filter((f) => /fire|pathway/i.test(`${f.id} ${f.title}`))
    .map((f) => `${f.severity}:${f.id}`);

console.log("\n1. THE FALSE CLEAR — generic plan-set vocabulary is not fire evidence");
check("a plan set with no fire content has NO fire-pathway evidence", () => {
  const ev = evidenceForTopic(mk(NO_FIRE), "firePathway");
  assert.equal(ev.present, false,
    "zoning setbacks and a labelled ridge were accepted as firefighter access evidence");
});
check("...and it therefore RAISES a fire finding rather than passing quietly", () => {
  assert.ok(fireIds(NO_FIRE).length > 0,
    "a plan set with no fire access pathway sailed through the fire review");
});

// Over-determination was the reason removing one word did not help before: setback, ridge and
// eave each satisfied the old test on their own.
for (const word of ["SETBACK", "RIDGE", "EAVE"]) {
  check(`MUST PASS: "${word.toLowerCase()}" alone does not satisfy the fire test`, () => {
    const only = `SHEET PV-3 ROOF PLAN. ${word} SHOWN. ARRAY 32 FT x 11 FT.`;
    assert.equal(evidenceForTopic(mk(only), "firePathway").present, false,
      `the bare word "${word.toLowerCase()}" still reads as fire evidence`);
  });
}

console.log("\n2. THE DISCRIMINATION TEST — the whole point");
const WITH_FIRE = `${NO_FIRE}\nSHEET PV-3 NOTE: 36 IN WIDE FIRE ACCESS PATHWAY BOTH SLOPES EAVE TO RIDGE PER IFC 1205.2.`;
check("a set WITH a dimensioned pathway is reviewed differently from one without", () => {
  const a = JSON.stringify(buildReviewerReport(mk(NO_FIRE)).findings.map((f) => f.id).sort());
  const b = JSON.stringify(buildReviewerReport(mk(WITH_FIRE)).findings.map((f) => f.id).sort());
  assert.notEqual(a, b, "the gate produces identical output with and without fire pathways");
});
check("MUST EXCLUDE: the compliant set raises NO fire finding", () => {
  assert.deepEqual(fireIds(WITH_FIRE), [],
    "a dimensioned IFC 1205.2 pathway was reported as missing — a false blocker");
});

console.log("\n3. THE REAL CORPUS VOCABULARY IS ACCEPTED");
// Harvested verbatim from live plan sets. A tightened rule that rejects the operator's own
// wording would turn a false clear into a false-blocker wave on day one.
const REAL_PHRASINGS: [string, string][] = [
  ["Basson / Miner / Reavis", 'ROOF PLAN. 36" FIRE SETBACK AT RIDGE AND 18" FIRE SETBACK AT EAVES.'],
  ["Fire setbacks sentence", 'Fire setbacks shown: 36" at ridge and 18" setbacks at edges/eaves, two roof access points.'],
  ["demo set", "SITE PLAN. Array location, fire access pathways and setbacks shown."],
  ["IFC citation", "PATHWAYS PROVIDED PER IFC 1205.2 AND R324.6."],
  ["smoke ventilation", "SMOKE VENTILATION AREA MAINTAINED AT RIDGE."],
];
for (const [label, text] of REAL_PHRASINGS) {
  check(`MUST EXCLUDE: real wording (${label}) is accepted as evidence`, () => {
    assert.equal(evidenceForTopic(mk(`${NO_FIRE}\n${text}`), "firePathway").present, true,
      `the operator's own plan-set wording stopped counting: "${text}"`);
  });
}

console.log("\n4. CONFIDENCE TRACKS THE DIMENSION, AND ONLY A NEARBY ONE");
check('a dimensioned fire callout is HIGH confidence', () => {
  assert.equal(evidenceForTopic(mk(WITH_FIRE), "firePathway").confidence, "high");
});
check("fire language with no dimension beside it is MEDIUM, not high", () => {
  // Present but unverified: the operator is asked to confirm rather than blocked or cleared.
  const vague = `${NO_FIRE}\nFIRE ACCESS PATHWAYS SHOWN ON ROOF PLAN.`;
  const ev = evidenceForTopic(mk(vague), "firePathway");
  assert.equal(ev.present, true);
  assert.equal(ev.confidence, "medium",
    "undimensioned fire language was promoted to high by dimensions elsewhere on the sheet");
});

console.log("\n5. BOTH LAYERS ANSWER ALIKE");
// codeReviewRules and projectEvidence ask the same question about the same project. When they
// disagreed about ground mounts the gate contradicted itself; this pins that they share one
// vocabulary for fire too.
check("the two fire rules never disagree about the same plan set", () => {
  for (const text of [NO_FIRE, WITH_FIRE, `${NO_FIRE}\n36" FIRE SETBACK AT RIDGE.`]) {
    const ids = buildReviewerReport(mk(text)).findings.map((f) => f.id);
    const cityFired = ids.includes("city.fire.pathways-missing");
    const evPresent = evidenceForTopic(mk(text), "firePathway").present;
    assert.equal(cityFired, !evPresent,
      `one layer says evidence present=${evPresent} while the other ${cityFired ? "raises" : "clears"} the missing-pathway finding`);
  }
});

console.log(failures === 0
  ? "\nAll fire-pathway evidence checks passed."
  : `\n${failures} fire-pathway evidence check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
