// TWO PLACES THE REPORT SAID MORE THAN THE ENGINE KNEW.
//
// 1. DEDUPE RANKED SPECIFICITY ABOVE SEVERITY. Two subsystems check some topics independently,
//    and the collapse kept the more specific finding — correct for the account case it was
//    written for, wrong in general, because a WARNING then evicts a BLOCKER on the same topic.
//    A missing critical field surfaces as "verify this" and the package stages.
//
// 2. A LOW-CONFIDENCE VISION VERDICT RENDERED AS A GREEN TICK. applyVerdict only relaxes a
//    finding at high or medium confidence — the engine explicitly refuses to trust low — yet
//    the report drew "✓ Vision-verified on the plan sheet" for it, in the ok/green style. The
//    confidence word was printed beside it, but a green tick reads as a conclusion and a
//    qualifier next to it does not undo that.
// Run: tsx backend/test/reportHonesty.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord, ReviewerFinding, ReviewerReport } from "../../shared/src/types";
import { buildReviewerReport, renderReviewerReportHtml, findingOutranks } from "../src/reviewerEngine";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const mk = (over: Record<string, unknown> = {}): ProjectRecord => ({
  id: "rh", clientId: "c", homeownerName: "Report Honesty", projectAddress: "1 Report Rd",
  city: "Coos Bay", state: "OR", zip: "97420", ahj: "City of Coos Bay",
  utility: "Pacific Power", accountNumber: "1234567890", meterNumber: "987654",
  systemSizeDcKw: 9, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    mounting: "Roof mount", interco: "Load-side breaker",
    busRating: "200A", mainBreaker: "200A", pvBreaker: "50",
    planSetExtractedText: '36" FIRE ACCESS PATHWAY. ATTACHMENT DETAIL: LAG SCREW. 2x6 RAFTERS @ 24 O.C.',
    ...over,
  },
} as unknown as ProjectRecord);

console.log("\n1. DEDUPE MUST NOT LET A WARNING EVICT A BLOCKER");
// HONEST SCOPE: this one is LATENT with today's rules, not a live bug. Measured across the
// account and meter pairs, the generic and specific sides always agree on severity — the
// generic finding fires only when the field is empty, and the specific one is a blocker then
// too. So there is no natural asymmetric pair to drive through buildReviewerReport, and a test
// routed through it would pass against the OLD code and prove nothing. The ordering rule is
// therefore pinned directly, as forward protection for the next pair someone adds.
const F = (severity: string, id: string): ReviewerFinding =>
  ({ id, severity, title: id, category: "electrical" } as unknown as ReviewerFinding);

check("MUST PASS: a blocker beats a MORE SPECIFIC warning", () => {
  assert.equal(findingOutranks(F("blocker", "reviewer.core.account"), F("warning", "reviewer.utility.pge-account")), true,
    "a warning kept its place over a blocker because it was the more specific finding");
});
check("MUST PASS: a specific warning does NOT displace a generic blocker", () => {
  assert.equal(findingOutranks(F("warning", "reviewer.utility.pge-account"), F("blocker", "reviewer.core.account")), false,
    "specificity outranked severity — a missing critical field would surface as 'verify this'");
});
check("MUST EXCLUDE: at EQUAL severity the specific finding still wins", () => {
  // The behaviour the original rule was written for, which must survive: the generic wording
  // was evicting the utility-specific finding that names the utility and the evidence needed.
  assert.equal(findingOutranks(F("blocker", "reviewer.utility.pge-account"), F("blocker", "reviewer.core.account")), true,
    "the specific finding stopped winning the tie — reports go back to generic wording");
  assert.equal(findingOutranks(F("blocker", "reviewer.core.account"), F("blocker", "reviewer.utility.pge-account")), false,
    "the generic finding evicted the specific one at equal severity");
});
check("MUST EXCLUDE: a callout never displaces a warning", () => {
  assert.equal(findingOutranks(F("callout", "reviewer.utility.pge-account"), F("warning", "reviewer.core.account")), false,
    "a callout displaced a warning");
});

console.log("\n2. THE VISION BANNER MUST MATCH WHAT THE ENGINE ACTED ON");
const withVerdict = (confidence: string, present = true): string => {
  const report = buildReviewerReport(mk());
  const target = report.findings.find((f) => f.severity === "blocker") ?? report.findings[0];
  assert.ok(target, "no finding to annotate");
  const annotated: ReviewerReport = {
    ...report,
    findings: report.findings.map((f) => (f === target
      ? { ...f, visionVerification: { checked: true, present, confidence, page: 7, observed: "Saw a calc block.", note: "" } } as ReviewerFinding
      : f)),
  };
  return renderReviewerReportHtml(mk(), annotated);
};

check("MUST PASS: a LOW-confidence verdict does not render the green verified tick", () => {
  const html = withVerdict("low");
  assert.ok(!/✓ Vision-verified/.test(html),
    "a verdict the engine refused to act on was drawn as '✓ Vision-verified'");
  assert.ok(/could not confirm|not treated as verified/.test(html),
    "the low-confidence verdict is not described as unconfirmed anywhere");
});
check("...and it is not styled as the ok/green state", () => {
  const html = withVerdict("low");
  assert.ok(!/vision-verdict ok/.test(html),
    "a low-confidence verdict kept the green 'ok' styling");
});
for (const confidence of ["high", "medium"]) {
  check(`MUST EXCLUDE: a ${confidence}-confidence verdict still renders as verified`, () => {
    const html = withVerdict(confidence);
    assert.ok(/✓ Vision-verified/.test(html),
      `a ${confidence}-confidence verdict stopped being reported as verified`);
    assert.ok(/vision-verdict ok/.test(html), "lost the ok styling");
  });
}
check("MUST EXCLUDE: an absent verdict still reads as could-not-confirm", () => {
  const html = withVerdict("high", false);
  assert.ok(/could not confirm/.test(html), "a not-present verdict lost its warning wording");
  assert.ok(!/vision-verdict ok/.test(html), "a not-present verdict was styled green");
});

console.log(failures === 0
  ? "\nAll report-honesty checks passed."
  : `\n${failures} report-honesty check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
