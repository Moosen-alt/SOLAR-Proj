// ONE QUESTION, ONE PREDICATE: "does the package show an SLD?"
//
// city.plan.sld-missing (codeReviewRules) kept its own word list — SLD / single line / 3-line /
// three line — without "one-line". The Oregon golden fixture's only SLD wording is "one-line
// diagram", so the reviewer raised the "Electrical one-line not reviewable" BLOCKER while
// evidenceForTopic('sld') reported the same SLD present at HIGH confidence. The rule now reads
// projectEvidence.packageShowsSld, so the two cannot disagree; this file pins that they agree on
// every wording, both ways.
//
// Synthetic fixtures. Run: npx tsx backend/test/sldOnePredicate.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { evidenceForTopic, packageShowsSld } from "../src/projectEvidence";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const mk = (snapshot: Record<string, unknown>): ProjectRecord => ({
  id: "sld-one-predicate", state: "OR", ahj: "City of Testport", utility: "Test Power",
  interconnectionMethod: "Load-side breaker",
  parserSnapshot: { state: "OR", ahj: "City of Testport", mounting: "Roof mount", ...snapshot },
} as unknown as ProjectRecord);
const ruleFires = (p: ProjectRecord): boolean => evaluateDesignCodeFindings(p, null).some((f) => f.id === "city.plan.sld-missing");

const SHOWS = [
  { splitPagesText: "one-line diagram rapid shutdown site plan roof plan" }, // the golden fixture's wording
  { planSetExtractedText: "E-1  ONE LINE DIAGRAM  (N) 60A AC DISCONNECT" },
  { planSetExtractedText: "E 1.1  3-LINE DIAGRAM  PV MODULE RATING @ STC" },
  { planSetExtractedText: "SINGLE-LINE DIAGRAM" },
  { electricalCalcText: "See SLD on sheet E-2." },
  { planSetExtractedText: "THREE LINE DIAGRAM" },
];
const DOES_NOT = [
  { planSetExtractedText: "ROOF PLAN  WIND ZONE LINE (TYP.)  ARRAY LAYOUT" },
  { planSetExtractedText: "ACME SOLAR  PHONE LINE 555-0100  SITE PLAN" },
  { planSetExtractedText: "SITE PLAN  ROOF PLAN  ELECTRICAL PLAN  EQUIPMENT SCHEDULE" },
  {},
];

check("MUST PASS: 'one-line diagram' (the golden fixture) is an SLD to BOTH the rule and the evidence", () => {
  const p = mk(SHOWS[0]);
  assert.equal(evidenceForTopic(p, "sld").present, true);
  assert.equal(ruleFires(p), false, "sld-missing fired on a package whose evidence shows the SLD");
});
check("MUST PASS: every SLD wording clears the rule, and the evidence agrees", () => {
  for (const s of SHOWS) {
    const p = mk(s);
    assert.equal(packageShowsSld(p), true, JSON.stringify(s));
    assert.equal(ruleFires(p), false, JSON.stringify(s));
  }
});
check("MUST EXCLUDE: no SLD wording -> the rule fires AND the evidence says absent ('ZONE LINE' / 'PHONE LINE' are not one-line)", () => {
  for (const s of DOES_NOT) {
    const p = mk(s);
    assert.equal(evidenceForTopic(p, "sld").present, false, JSON.stringify(s));
    assert.equal(ruleFires(p), true, JSON.stringify(s));
  }
});
check("AGREEMENT: rule fires exactly when the evidence topic says the SLD is absent, on every fixture", () => {
  for (const s of [...SHOWS, ...DOES_NOT]) {
    const p = mk(s);
    assert.equal(ruleFires(p), !evidenceForTopic(p, "sld").present, JSON.stringify(s));
  }
});

if (failures) { console.error(`\n${failures} SLD predicate check(s) FAILED`); process.exit(1); }
console.log("\nall SLD predicate checks passed");
