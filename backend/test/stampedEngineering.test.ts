// A REVIEW-BLOCK REFERENCE IS NOT A STAMP.
//
// Portland issued a correction on Bren Trask's rooftop PV (26-033226-000-00-RS):
//
//   "Roof is overspanned. In the prescriptive span tables, 2x4 rafters can span roughly half
//    the distance that is shown in the drawings... Unsupported intermediate brace or collar
//    tie do not alter span length of rafter. Please provide engineering calculations to show
//    that roof structure is adequate to support proposed system."
//
// Everything needed to see that coming was already on file: permitPath was "engineered", the
// plan set named a Vector Structural Engineering review block, the framing sheets showed 2x4
// rafters at 24" o.c. — and no sealed calculation was ever attached. The package leaned on
// engineering it did not contain.
//
// Worse, that same reference SILENCED the check that would have caught the overspan. The old
// suppression tested the design TEXT for the word "engineer", so a plan set that merely
// mentioned engineering muted the rafter-span warning. A mention suppressed the rule; the
// document it referred to was never required.
//
// Both halves are pinned here: a stamp is a DOCUMENT, and `structural` (the framing sheet out
// of the plan set) is not that document.
//
// Browser-free. Run: tsx backend/test/stampedEngineering.test.ts
import assert from "node:assert/strict";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import type { ProjectRecord } from "../../shared/src/types";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Trask's real shape, reduced to what the rules read.
const TRASK_SNAPSHOT: Record<string, unknown> = {
  permitPath: "engineered",
  framingType: "rafter",
  roofRafterSpacing: 24,
  // roofRafterSpan deliberately ABSENT — the fact Portland bounced on.
  snow: 45,
  deadLoad: 1.35,
  wind: "C",
  windSpeed: 96,
  stampRecommendation:
    "Vector Structural Engineering review block with signature/seal area shown (VSE Project U4703-1659-261) referencing a separate structural letter",
  structuralCalcText:
    'Roof sections (PV 1.2) show 2x4 rafters @ 24" o.c. with 2x6 ridge beam at 25.0 and 18.0 degree slopes',
  planSetExtractedText:
    "PV 1.1 roof plan, PV 1.2 roof sections, attachment detail with flashing and standoff, single line diagram, racking rail layout",
};

const project = (snapshot: Record<string, unknown>): ProjectRecord => ({
  id: "test",
  state: "OR",
  ahj: "City of Portland",
  utility: "Portland General Electric",
  homeownerName: "Bren Trask",
  projectAddress: "1 Test St",
  parserSnapshot: snapshot,
} as unknown as ProjectRecord);

const ids = (docTypes: string[], snapshot = TRASK_SNAPSHOT): string[] =>
  evaluateDesignCodeFindings(project(snapshot), null, undefined, docTypes).map((f) => f.id);

const findingIn = (docTypes: string[], id: string, snapshot = TRASK_SNAPSHOT) =>
  evaluateDesignCodeFindings(project(snapshot), null, undefined, docTypes).find((f) => f.id === id);

// ---------------------------------------------------------------------------
// The live case: engineered design, no stamp attached.
// ---------------------------------------------------------------------------
const TRASK_DOCS = ["plan_set", "sld", "site_plan", "structural", "module_spec", "inverter_spec", "labels"];

check("THE REGRESSION: an engineered design with no stamped calculation is flagged", () => {
  assert.ok(ids(TRASK_DOCS).includes("city.struct.stamped-engineering-missing"));
});

check("...as a BLOCKER, because the design declares the engineered path and depends on it", () => {
  assert.equal(findingIn(TRASK_DOCS, "city.struct.stamped-engineering-missing")?.severity, "blocker");
});

check("...and it tells the design team a review block is not the stamp", () => {
  const f = findingIn(TRASK_DOCS, "city.struct.stamped-engineering-missing");
  assert.match(String(f?.designTeamAction), /review-block reference .* is not the stamp/i);
});

check("THE SUPPRESSION BUG: the span warning is no longer silenced by a MENTION of engineering", () => {
  // Trask's plan set names an engineering review block and has spacing but no span. Under
  // the old text-based suppression this rule stayed silent — and Portland raised exactly it.
  assert.ok(ids(TRASK_DOCS).includes("city.struct.span-table-incomplete"));
});

check("`structural` is the framing sheet, not the stamp — it must not suppress either rule", () => {
  assert.ok(TRASK_DOCS.includes("structural"));
  const out = ids(TRASK_DOCS);
  assert.ok(out.includes("city.struct.stamped-engineering-missing"));
  assert.ok(out.includes("city.struct.span-table-incomplete"));
});

// ---------------------------------------------------------------------------
// With the stamp actually attached, both go quiet.
// ---------------------------------------------------------------------------
for (const stamp of ["structural_letter", "stamped_plans", "engineering_letter"]) {
  check(`with ${stamp} attached, neither structural finding fires`, () => {
    const out = ids([...TRASK_DOCS, stamp]);
    assert.ok(!out.includes("city.struct.stamped-engineering-missing"), "the stamp IS attached");
    assert.ok(!out.includes("city.struct.span-table-incomplete"), "engineering supersedes the prescriptive span screen");
  });
}

// ---------------------------------------------------------------------------
// No false alarm on a package that never claimed engineering.
// ---------------------------------------------------------------------------
const PRESCRIPTIVE: Record<string, unknown> = {
  permitPath: "prescriptive",
  framingType: "rafter",
  roofRafterSpacing: 24,
  roofRafterSpan: 11.5,
  snow: 25,
  deadLoad: 3.0,
  wind: "B",
  planSetExtractedText: "PV roof plan, attachment detail with flashing and standoff, single line diagram, racking rail layout",
};

check("a prescriptive package with full span evidence raises neither finding", () => {
  const out = ids(["plan_set", "sld", "site_plan", "structural", "module_spec", "inverter_spec", "labels"], PRESCRIPTIVE);
  assert.ok(!out.includes("city.struct.stamped-engineering-missing"), "nothing claimed engineering");
  assert.ok(!out.includes("city.struct.span-table-incomplete"), "spacing AND span are both present");
});

check("a prescriptive package that MENTIONS an engineer still owes the stamp — but only as a warning", () => {
  const mentions = { ...PRESCRIPTIVE, stampRecommendation: "sealed by a licensed P.E. if required" };
  const f = findingIn(["plan_set", "sld"], "city.struct.stamped-engineering-missing", mentions);
  assert.ok(f, "a package invoking a P.E. without attaching one should still be called out");
  assert.equal(f?.severity, "warning", "it did not declare the engineered path, so it is not a blocker");
});

if (failures) { console.error(`\n${failures} stamped-engineering check(s) FAILED.`); process.exit(1); }
console.log("\nAll stamped-engineering checks passed.");
process.exit(0);
