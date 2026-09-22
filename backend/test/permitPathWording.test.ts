// "NON-PRESCRIPTIVE" CONTAINS "PRESCRIPTIVE".
//
// codeReviewRules decided the structural path with a bare substring test,
// /prescriptive/i.test(permitPath), so an explicitly engineered project matched and the gate
// inverted. Measured before the fix, permitPath "Non-prescriptive":
//   - raised the PRESCRIPTIVE screens (span table, loads) at blocker severity, and
//   - did NOT raise city.struct.stamped-engineering-missing at all,
// while "Engineered" was handled correctly. The second half is the dangerous one: the project
// most certainly needing a PE stamp was the one never asked for it.
//
// This is the operator's own vocabulary, not a hypothetical. Their standing ruling is that a PV
// installation on a TPO roof in Oregon is automatically NON-prescriptive — and those are
// exactly the jobs that had to get stamps.
//
// Three separate expressions in this file once answered the same question three ways
// (/prescriptive/i, /engineer/i, and a third for severity). They now all read
// permitPath.pathWordingScope, which tests the non-/engineered wording BEFORE the prescriptive
// substring. These tests pin that they cannot drift apart again.
// Run: tsx backend/test/permitPathWording.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";
import { pathWordingScope } from "../src/permitPath";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const mk = (permitPath: string): ProjectRecord => ({
  id: `pp-${permitPath.replace(/\W+/g, "-") || "blank"}`,
  clientId: "c", homeownerName: "Path Wording", projectAddress: "1 TPO Way",
  city: "Coos Bay", state: "OR", zip: "97420", ahj: "City of Coos Bay",
  utility: "Pacific Power", accountNumber: "1234567890", meterNumber: "987654",
  systemSizeDcKw: 9, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    mounting: "Roof mount", interco: "Load-side breaker", permitPath,
    busRating: "225A", mainBreaker: "175A", pvBreaker: "40",
    roofMaterial: "TPO membrane",
    planSetExtractedText: '36" FIRE ACCESS PATHWAY. RAFTER 2x6 @ 24 O.C. ATTACHMENT DETAIL FLASHED. RAPID SHUTDOWN PER 690.12. 705.12 BUSBAR CALC.',
  },
} as unknown as ProjectRecord);

const report = (permitPath: string): Map<string, string> => {
  const m = new Map<string, string>();
  for (const f of buildReviewerReport(mk(permitPath)).findings) m.set(f.id, f.severity);
  return m;
};

console.log("\n1. THE CLASSIFIER READS THE NEGATION BEFORE THE SUBSTRING");
for (const [value, expected] of [
  ["Prescriptive", "prescriptive"],
  ["Non-prescriptive", "engineered"],
  ["non prescriptive", "engineered"],
  ["NON-PRESCRIPTIVE (TPO roof)", "engineered"],
  ["Engineered", "engineered"],
  ["", ""],
] as const) {
  check(`"${value || "(empty)"}" classifies as ${expected || "(none)"}`, () => {
    assert.equal(pathWordingScope(value), expected);
  });
}

console.log("\n2. THE STAMP IS DEMANDED OF A NON-PRESCRIPTIVE PROJECT");
check("MUST PASS: 'Non-prescriptive' raises the stamped-engineering blocker", () => {
  assert.equal(report("Non-prescriptive").get("city.struct.stamped-engineering-missing"), "blocker",
    "the project the operator marked non-prescriptive was never asked for its stamp");
});
check("...and 'Non-prescriptive' is treated IDENTICALLY to 'Engineered'", () => {
  const a = [...report("Non-prescriptive").entries()].sort();
  const b = [...report("Engineered").entries()].sort();
  assert.deepEqual(a, b,
    "two spellings of the same path produce different reports — the wording is deciding the code");
});

console.log("\n3. THE PRESCRIPTIVE PATH IS NOT DISTURBED");
const presc = report("Prescriptive");
check("MUST EXCLUDE: a prescriptive project still gets the prescriptive screens as blockers", () => {
  assert.equal(presc.get("city.struct.span-table-incomplete"), "blocker");
  assert.equal(presc.get("city.struct.loads-missing"), "blocker");
});
check("MUST EXCLUDE: a prescriptive project is NOT asked for stamped engineering", () => {
  assert.equal(presc.has("city.struct.stamped-engineering-missing"), false,
    "a prescriptive project was told it needs a PE stamp");
});

console.log("\n4. AN ENGINEERED PROJECT IS NOT SCREENED AS PRESCRIPTIVE");
check("the prescriptive screens drop to warnings on the engineered path", () => {
  const eng = report("Non-prescriptive");
  assert.equal(eng.get("city.struct.span-table-incomplete"), "warning",
    "prescriptive worksheet data was demanded as a blocker from an engineered design");
  assert.equal(eng.get("city.struct.loads-missing"), "warning");
});

console.log("\n5. A PLAN-TEXT MENTION IS STILL ONLY A WARNING");
// The severity split the comment describes: depending on the engineered path is a blocker;
// a passing reference to engineering inside an otherwise prescriptive package is a warning.
check("MUST EXCLUDE: 'sealed by' in the text alone does not become a blocker", () => {
  const p = mk("Prescriptive");
  (p.parserSnapshot as Record<string, unknown>).planSetExtractedText =
    '36" FIRE ACCESS PATHWAY. STRUCTURAL LETTER SEALED BY OTHERS ON FILE.';
  const f = buildReviewerReport(p).findings.find((x) => x.id === "city.struct.stamped-engineering-missing");
  assert.ok(f, "a package referencing a sealed letter raised nothing at all");
  assert.equal(f!.severity, "warning",
    "a passing reference to engineering was escalated to a blocker on a prescriptive job");
});

console.log(failures === 0
  ? "\nAll permit-path wording checks passed."
  : `\n${failures} permit-path wording check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
