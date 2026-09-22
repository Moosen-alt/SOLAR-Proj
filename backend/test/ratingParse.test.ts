// A FIELD WITH TWO NUMBERS IN IT IS NOT A NUMBER.
//
// codeReviewRules.num() used to delete every non-digit and parseFloat the remainder, so a
// rating carrying a note became the CONCATENATION of its numbers. The live book holds a real
// one: pvBreaker "50A (fuses in 60A AC disconnect at line-side tap)" read as 5060 amps.
//
// It failed in BOTH directions, which is what made it dangerous rather than merely untidy:
//   - busRating "200A (Note 3)" -> 2003, so a genuine 200A main + 60A PV on a 200A bus (260A
//     against a 240A allowance) sits far under 120% of 2003 and the blocker goes SILENT;
//   - mainBreaker "175A (2 of 2)" -> 17522, so a COMPLIANT design is blocked and the operator
//     is shown "17522A main".
//
// A silent false clear on an NEC 705.12 busbar violation is the worst outcome this gate can
// produce, so these tests pin the reading itself through the public behaviour of the gate.
// Run: tsx backend/test/ratingParse.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const mk = (over: Record<string, string>): ProjectRecord => ({
  id: "rating", clientId: "c", homeownerName: "Rating Probe", projectAddress: "1 Bus Bar Way",
  city: "Coos Bay", state: "OR", zip: "97420", ahj: "City of Coos Bay",
  utility: "Pacific Power", accountNumber: "1234567890", meterNumber: "987654",
  systemSizeDcKw: 9, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    mounting: "Roof mount", interco: "Load-side breaker",
    // The violation under test: 200 + 60 = 260A against a 240A (120% of 200A) allowance.
    busRating: "200A", mainBreaker: "200A", pvBreaker: "60",
    planSetExtractedText: "705.12 BUSBAR CALCULATION SHOWN ON SHEET PV-4. 36\" FIRE ACCESS PATHWAY.",
    ...over,
  },
} as unknown as ProjectRecord);

const idsOf = (over: Record<string, string>): string[] =>
  buildReviewerReport(mk(over)).findings.map((f) => f.id);
const blocks = (over: Record<string, string>): boolean =>
  idsOf(over).includes("city.elec.load-side-over-120");

console.log("\n1. THE SILENT FALSE CLEAR — a real violation must not vanish behind a note");
check("baseline: the clean violation blocks (proves the fixture really is a violation)", () => {
  assert.equal(blocks({}), true, "the control case does not block — the fixture is wrong, not the code");
});

for (const busRating of ["200A (Note 3)", "200A, 120/240V", "200 AMP MSP, 42 SPACE", "200A MSP (existing)"]) {
  check(`MUST PASS: busRating "${busRating}" still blocks`, () => {
    assert.equal(blocks({ busRating }), true,
      `a 260A load on a 240A allowance went silent because the bus field carried a note`);
  });
}

check("...and the message quotes the REAL rating, not a concatenation", () => {
  const f = buildReviewerReport(mk({ busRating: "200A (Note 3)" })).findings
    .find((x) => x.id === "city.elec.load-side-over-120");
  assert.ok(f, "no blocker to inspect");
  assert.ok(/200A bus/.test(f!.message), `operator was shown a fabricated bus rating: ${f!.message}`);
  assert.ok(!/2003/.test(f!.message), `the concatenated number 2003 reached the operator: ${f!.message}`);
});

console.log("\n2. THE OPPOSITE ERROR — a compliant design must not be blocked by a note");
// 175A main + 40A PV on a 200A bus is 215A against 240A: compliant.
const compliant = { busRating: "200A", mainBreaker: "175A", pvBreaker: "40" };
check("baseline: the clean compliant design raises nothing", () => {
  assert.equal(blocks(compliant), false, "the compliant control blocks — fixture error");
});
for (const mainBreaker of ["175A (2 of 2)", "175A MAIN, 200A BUS RATED", "175 AMP (existing main)"]) {
  check(`MUST EXCLUDE: mainBreaker "${mainBreaker}" does not manufacture a violation`, () => {
    assert.equal(blocks({ ...compliant, mainBreaker }), false,
      "a compliant design was blocked because its main-breaker field carried a note");
  });
}

console.log("\n3. GENUINELY AMBIGUOUS STAYS UNKNOWN — and says so out loud");
// Two amp values and no way to tell which is the PV breaker. Guessing is how 5060 happened.
// The honest answer routes to the existing "ratings not readable" finding rather than
// calculating confidently on a number nobody wrote down.
check("two competing amp values produce the calc-missing finding, not a calculation", () => {
  const ids = idsOf({ pvBreaker: "50A (fuses in 60A AC disconnect at line-side tap)" });
  assert.ok(ids.includes("city.elec.load-side-calc-missing"),
    "an unreadable rating passed silently instead of asking for the calculation");
  assert.ok(!ids.includes("city.elec.load-side-over-120"),
    "the gate computed a verdict from a rating it could not read");
});

console.log("\n4. UNITS DISAMBIGUATE WHERE A HUMAN COULD");
// A reader has no trouble with "200A, 120/240V": one current, one voltage. Volts are
// deliberately excluded from the unit list so a stated service voltage cannot re-ambiguate
// every electrical field.
check("a current beside a voltage still reads as the current", () => {
  assert.equal(blocks({ busRating: "200A, 120/240V" }), true);
});
check("MUST EXCLUDE: a structural value with a zone note still reads", () => {
  // "25 psf (Zone 2)" must not become 252 psf, and must not become unreadable either.
  const ids = idsOf({ snow: "25 psf (Zone 2)", groundSnowLoad: "25 psf (Zone 2)" });
  assert.ok(Array.isArray(ids), "report did not build");
});

console.log("\n5. THE EVERYDAY CASE IS UNTOUCHED");
for (const [field, value] of [["busRating", "225"], ["mainBreaker", "175"], ["pvBreaker", "40A"]] as const) {
  check(`a plain "${value}" in ${field} reads exactly as before`, () => {
    assert.equal(blocks({ ...compliant, [field]: value } as Record<string, string>), false);
  });
}

console.log(failures === 0
  ? "\nAll rating-parse checks passed."
  : `\n${failures} rating-parse check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
