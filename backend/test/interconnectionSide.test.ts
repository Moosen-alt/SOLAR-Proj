// WHICH SIDE OF THE SERVICE IS THIS, AND WHICH CODE SECTION ANSWERS FOR IT?
//
// The 120% busbar screen is NEC 705.12(B)(3)(2) — a LOAD-side rule. A supply-side (line-side)
// tap is 705.11, and the busbar calculation is not the applicable test there at all. The
// reviewer gate's old guard matched the bare word "breaker", so Harper Fakename's parsed
// interconnection "Supply Breaker" — corroborated by his own plan set, "POINT OF
// INTERCONNECT, SUPPLY BREAKER FEED THRU LUG" — was measured against the load-side rule and
// produced a BLOCKER the cited code does not support.
//
// The danger of fixing it is the opposite error, so these tests pin BOTH directions: a
// genuine load-side overage must still block, and a supply-side design must still be
// reviewed — just against 705.11 — rather than going quietly silent.
// Run: tsx backend/test/interconnectionSide.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// A roof-mount PV job whose ratings BREACH the 120% screen: 200A main + 50A PV on a 200A bus
// is 250A against a 240A allowance. Whether that is a finding depends entirely on which side
// of the service the connection is made — which is the whole point.
const project = (interco: string): ProjectRecord => ({
  id: `interco-${interco.replace(/\W+/g, "-")}`,
  clientId: "client-interco",
  homeownerName: "Interco Test",
  projectAddress: "1 Service Lane",
  city: "Lincoln City",
  state: "OR",
  zip: "97367",
  ahj: "City of Lincoln City",
  utility: "Pacific Power",
  accountNumber: "1234567890",
  meterNumber: "987654",
  systemSizeDcKw: 9,
  systemSizeAcKw: 7.6,
  interconnectionMethod: interco,
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Lincoln City", utility: "Pacific Power",
    mounting: "Roof mount", interco,
    busRating: "200A", mainBreaker: "200A", pvBreaker: "50",
  },
} as unknown as ProjectRecord);

const idsOf = (interco: string): string[] =>
  buildReviewerReport(project(interco)).findings.map((f) => `${f.severity}:${f.id}`);
const has = (interco: string, id: string): boolean => idsOf(interco).some((x) => x.endsWith(`:${id}`));
const severityOf = (interco: string, id: string): string =>
  idsOf(interco).find((x) => x.endsWith(`:${id}`))?.split(":")[0] ?? "(absent)";

console.log("\n1. THE FALSE BLOCKER — a supply-side tap is not judged by the load-side rule");
check("MUST PASS: \"Supply Breaker\" does NOT raise the 120% busbar blocker", () => {
  assert.equal(has("Supply Breaker", "city.elec.load-side-over-120"), false,
    "a supply-side tap was blocked by a load-side rule the cited code does not support");
});

check("...and it is not silently cleared either — 705.11 gets its own callout", () => {
  assert.equal(has("Supply Breaker", "city.elec.supply-side-tap"), true,
    "the supply-side design vanished from the report instead of being reviewed");
  assert.equal(severityOf("Supply Breaker", "city.elec.supply-side-tap"), "callout");
});

// HONESTY NOTE, measured by reverting the fix on 2026-09-22: these four phrasings PASS against
// the OLD code too, so they are not evidence for this fix. The old gate keyed on
// /load.side|breaker|back.?feed|bus/, and none of these four carries one of those tokens — they
// were accidentally safe. "Supply Breaker" was the only phrasing that actually tripped it, which
// is exactly why the live project that surfaced the bug used those words.
// They stay as FORWARD pins: the next person who widens the load-side regex to catch more
// designs will catch these, and should hear about it from a test rather than from an AHJ.
for (const phrasing of ["Supply side tap", "Line-side connection", "Supply-side tap ahead of the main", "Feed-thru lug tap"]) {
  check(`FORWARD PIN (passes pre-fix): "${phrasing}" must stay off the load-side rule`, () => {
    assert.equal(has(phrasing, "city.elec.load-side-over-120"), false, phrasing);
  });
}

console.log("\n2. THE OPPOSITE ERROR — a genuine load-side overage must still block");
for (const phrasing of ["Load-side breaker", "Load side breaker at the main panel", "Backfed breaker"]) {
  check(`MUST EXCLUDE: "${phrasing}" still raises the 120% blocker`, () => {
    assert.equal(has(phrasing, "city.elec.load-side-over-120"), true,
      `a real load-side overage stopped being reported: ${phrasing}`);
  });
}

check("...and the load-side blocker really is a blocker, not softened", () => {
  assert.equal(severityOf("Load-side breaker", "city.elec.load-side-over-120"), "blocker");
});

console.log("\n3. AMBIGUITY IS REPORTED, NOT GUESSED");
check("an interconnection naming BOTH sides is flagged ambiguous rather than picking one", () => {
  const both = "Load-side breaker or supply-side tap";
  assert.equal(has(both, "city.elec.interconnection-ambiguous"), true,
    "the gate silently chose a side when the design named two");
  assert.equal(has(both, "city.elec.load-side-over-120"), false,
    "an ambiguous design was blocked by one of the two possible rules");
});

console.log("\n4. A COMPLIANT LOAD-SIDE DESIGN IS NOT DISTURBED");
check("MUST EXCLUDE: 175A main + 40A PV on a 200A bus raises no 120% finding", () => {
  const ok = project("Load-side breaker");
  (ok.parserSnapshot as Record<string, unknown>).mainBreaker = "175A";
  (ok.parserSnapshot as Record<string, unknown>).pvBreaker = "40";
  const ids = buildReviewerReport(ok).findings.map((f) => f.id);
  assert.ok(!ids.includes("city.elec.load-side-over-120"),
    "215A on a 240A allowance was reported as exceeding it");
});

console.log("\n5. A GROUND ARRAY HAS NO ROOF — and the roof rules must know it");
// Fire access pathways, roof framing and racking attachment/flashing are ROOF rules. The
// mount test read interconnectionMethod and the plan-text blob but never the parser's own
// `mounting` field, so a ground mount collected roof blockers unless the giveaway words
// happened to appear in text that, on a fresh upload, has not been extracted yet.
const roofBlockers = (mounting: string): string[] => {
  const p = project("Load-side breaker");
  (p.parserSnapshot as Record<string, unknown>).mounting = mounting;
  (p.parserSnapshot as Record<string, unknown>).mainBreaker = "175A";
  (p.parserSnapshot as Record<string, unknown>).pvBreaker = "40";
  return buildReviewerReport(p).findings
    .filter((f) => f.severity === "blocker" && /fire\.pathway|struct\.framing|attachment/.test(f.id))
    .map((f) => f.id);
};

const ROOF_BLOCKER_COUNT = roofBlockers("Roof mount").length;

for (const mounting of ["Ground mount", "Pole mount", "ground-mounted array"]) {
  check(`MUST PASS: "${mounting}" raises no ROOF blockers`, () => {
    assert.deepEqual(roofBlockers(mounting), [],
      `a ground array was asked for roof pathways/framing/flashing: ${roofBlockers(mounting).join(", ")}`);
  });
}

// The count itself is not the contract — a new roof rule may legitimately raise it — so the
// baseline is measured from an actual roof mount and the other cases are compared to IT.
// What must never happen is the roof rules going quiet on a roof.
check("MUST EXCLUDE: a ROOF mount is still fully reviewed", () => {
  assert.ok(ROOF_BLOCKER_COUNT > 0,
    "the roof rules stopped firing on an actual roof — the mount test is now over-exempting");
});

check("MUST EXCLUDE: unknown mounting stays conservative and keeps the roof rules", () => {
  assert.equal(roofBlockers("").length, ROOF_BLOCKER_COUNT,
    "silence about mounting was read as 'no roof' — an unknown must not buy an exemption");
});

check("MUST EXCLUDE: a non-mount word in the field does not exempt the roof", () => {
  assert.equal(roofBlockers("Flush mount, composition shingle").length, ROOF_BLOCKER_COUNT,
    "the word 'mount' alone was enough to skip the roof rules");
});

console.log("\n6. THE MISSING DOOR — an unrecognised method must not skip the screen in silence");
// The chain was if / else-if / else-if with NO final else, so a value matching none of the
// three vocabularies fell off the end and emitted nothing at all. The 120% arithmetic exists
// in exactly one place and nothing downstream repeats it — QC checks the rating FIELDS ARE
// PRESENT, never that the math passes — so an unrecognised wording skipped the only NEC 705.12
// calculation in the product. The trigger is the parser prompt's OWN first example value, and
// a live project (Blake Fixture) carries it verbatim.
const UNCLASSIFIED = ["Net Metering", "Net metered PV", "MSP interconnection", "Utility interconnection", "Grid-tied"];
for (const phrasing of UNCLASSIFIED) {
  check(`MUST PASS: "${phrasing}" is reported, not skipped`, () => {
    assert.equal(has(phrasing, "city.elec.interconnection-unclassified"), true,
      `the interconnection screen did not run at all for "${phrasing}" — silence reads as approval`);
  });
}
check("...and the unknown is NOT forced into the load-side rule", () => {
  // Routing unknowns into the 705.12 branch would demand a busbar calc from what may well be
  // a supply-side tap — trading a silent hole for a false demand.
  assert.equal(has("Net Metering", "city.elec.load-side-over-120"), false,
    "an unclassified method was judged by the load-side screen");
  assert.equal(severityOf("Net Metering", "city.elec.interconnection-unclassified"), "warning");
});
check("MUST EXCLUDE: a CLASSIFIABLE method never raises the unclassified finding", () => {
  for (const known of ["Load-side breaker", "Supply Breaker", "Line-side tap"]) {
    assert.equal(has(known, "city.elec.interconnection-unclassified"), false,
      `"${known}" was reported as unclassifiable when the gate does classify it`);
  }
});

console.log("\n7. A FINDING MUST CITE THE SECTION IT IS ABOUT");
// Both supply-side findings shipped citing 705.12 — the load-side section whose
// inapplicability is the entire content of the supply-side callout. The card therefore
// rendered a basis that contradicted its own message.
const citationsFor = (interco: string, id: string): string => {
  const f = buildReviewerReport(project(interco)).findings.find((x) => x.id === id);
  return (f?.codeReferences ?? []).map((c) => c.section).join(", ");
};
check("the supply-side callout cites 705.11, not the load-side section", () => {
  const cited = citationsFor("Supply Breaker", "city.elec.supply-side-tap");
  assert.ok(/705\.11/.test(cited), `supply-side callout cites "${cited}"`);
  assert.ok(!/705\.12/.test(cited),
    `the finding whose point is that 705.12 does not govern cites 705.12 as its basis: "${cited}"`);
});
check("the ambiguous finding cites BOTH, because that is what it is about", () => {
  const cited = citationsFor("Load-side breaker or supply-side tap", "city.elec.interconnection-ambiguous");
  assert.ok(/705\.11/.test(cited) && /705\.12/.test(cited),
    `a finding that says "705.11 versus 705.12" cites only "${cited}"`);
});
check("MUST EXCLUDE: the load-side blocker still cites 705.12", () => {
  assert.ok(/705\.12/.test(citationsFor("Load-side breaker", "city.elec.load-side-over-120")),
    "the load-side blocker lost its own code reference");
});

console.log("\n8. THE TAP-DETAIL BLOCKER FOLLOWS THE CLASSIFIER");
// This rule had its own narrower vocabulary (/line.side|supply.side|tap/), so the phrasings
// the classifier learned were called supply-side by one rule and not by this one — and never
// had to show a tap detail at all.
for (const phrasing of ["Supply Breaker", "Supply-side tap ahead of the main", "Feed-thru lug tap"]) {
  check(`MUST PASS: "${phrasing}" owes a tap detail when none is shown`, () => {
    assert.equal(has(phrasing, "city.elec.supply-side-detail-missing"), true,
      `a design the gate calls supply-side was never asked for its tap detail`);
  });
}
check("MUST EXCLUDE: a real tap detail satisfies it", () => {
  const p = project("Supply Breaker");
  (p.parserSnapshot as Record<string, unknown>).planSetExtractedText =
    "SUPPLY-SIDE TAP DETAIL: TAP POINT AT LINE TERMINALS, SERVICE CONDUCTOR 4/0 CU, FUSED DISCONNECT 60A PER NEC 705.11.";
  const ids = buildReviewerReport(p).findings.map((f) => f.id);
  assert.ok(!ids.includes("city.elec.supply-side-detail-missing"),
    "a package showing tap point, conductor sizing and a fused disconnect was still asked for the detail");
});
check("MUST EXCLUDE: a load-side design is not asked for a tap detail", () => {
  assert.equal(has("Load-side breaker", "city.elec.supply-side-detail-missing"), false,
    "a load-side connection was asked for a supply-side tap detail");
});

console.log(failures === 0
  ? "\nAll interconnection-side checks passed."
  : `\n${failures} interconnection-side check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
