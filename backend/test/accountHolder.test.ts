// THE APPLICANT MUST BE ON THE UTILITY ACCOUNT.
//
// David Simmons' PacifiCorp interconnection (APP-111681) was filed on 2026-09-02 and
// suspended the next morning:
//
//   "David Simmons is not listed on the account. They will need to be added to the account
//    as a co-customer or have the electric service put into their name; and/or to have the
//    primary electric account holders name added to the application."
//
// Ten business days to fix, or the interconnection request may be withdrawn.
//
// Both facts were already in the payload when QC ran: homeownerName "David Simmons" and
// ubAccountHolder "STEPHANIE SIMMONS", parsed off the bill we had on file. Nothing compared
// them, and the project reached status=submitted.
//
// The check has to be GENEROUS about spelling and PRECISE about people: a warning that
// fires on "Bob" vs "Robert" trains operators to click past the one warning that matters.
// So the bulk of this test is the false-alarm side.
//   npx tsx backend/test/accountHolder.test.ts
import assert from "node:assert/strict";
import { baselineRuleDefinitions, evaluateBaselineRules, namesAgree } from "../src/baselineRules";
import type { ParserPayload } from "../../shared/src/types";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const agree = (a: string, b: string): boolean => namesAgree(a, b);

// ---------------------------------------------------------------------------
// The live case
// ---------------------------------------------------------------------------
check("THE REGRESSION: David Simmons vs STEPHANIE SIMMONS is flagged", () => {
  assert.equal(agree("David Simmons", "STEPHANIE SIMMONS"), false);
});

check("...and the rule fires on the real payload, naming both parties and the fix", () => {
  const payload = {
    homeownerName: "David Simmons",
    ubAccountHolder: "STEPHANIE SIMMONS",
    state: "OR",
    ahj: "City of Coos Bay",
    utility: "Pacific Power",
    dcKw: 7.2,
  } as unknown as ParserPayload;
  const hit = evaluateBaselineRules(payload).find((r) => r.ruleId === "xcheck-nem-account-holder");
  assert.ok(hit, "no account-holder finding was produced");
  assert.match(hit!.message, /David Simmons/);
  assert.match(hit!.message, /STEPHANIE SIMMONS/);
  assert.match(hit!.message, /co-customer|in their name|account holder/i);
  assert.equal(hit!.fieldName, "ubAccountHolder");
});

check("the rule is registered so it shows up as a known rule, not an anonymous string", () => {
  const def = baselineRuleDefinitions.find((d) => d.id === "xcheck-nem-account-holder");
  assert.ok(def, "rule definition missing from baselineRuleDefinitions");
  assert.equal(def!.ruleType, "qc");
});

check("it never hard-blocks — a co-customer may legitimately be added before filing", () => {
  const payload = { homeownerName: "David Simmons", ubAccountHolder: "STEPHANIE SIMMONS" } as unknown as ParserPayload;
  const hit = evaluateBaselineRules(payload).find((r) => r.ruleId === "xcheck-nem-account-holder");
  assert.equal(hit!.severity, "warning");
  assert.equal(hit!.qcStatus, "warning");
});

// ---------------------------------------------------------------------------
// The false-alarm side: same person, written differently. These must stay SILENT.
// ---------------------------------------------------------------------------
const sameperson: Array<[string, string]> = [
  ["David Simmons", "DAVID SIMMONS"],
  ["David Simmons", "Simmons, David"],
  ["David Simmons", "DAVID W SIMMONS"],
  ["David W. Simmons", "David Simmons"],
  ["David Simmons", "D SIMMONS"],
  ["D. Simmons", "David Simmons"],
  ["David Simmons", "MR DAVID SIMMONS"],
  ["David Simmons Jr", "David Simmons"],
  ["David Simmons", "DAVID SIMMONS JR."],
  // Joint accounts: the applicant IS on the account, alongside a spouse.
  ["David Simmons", "DAVID & STEPHANIE SIMMONS"],
  ["Stephanie Simmons", "DAVID & STEPHANIE SIMMONS"],
  ["David Simmons", "STEPHANIE AND DAVID SIMMONS"],
];
for (const [applicant, holder] of sameperson) {
  check(`no false alarm: "${applicant}" vs "${holder}"`, () => {
    assert.equal(agree(applicant, holder), true);
  });
}

// ---------------------------------------------------------------------------
// Genuine disagreements of PERSON. These must fire.
// ---------------------------------------------------------------------------
const different: Array<[string, string]> = [
  ["David Simmons", "STEPHANIE SIMMONS"],   // spouse — the live case
  ["David Simmons", "ROBERT JOHNSON"],      // unrelated party
  ["David Simmons", "COOS BAY RENTALS LLC"], // landlord / entity holds the service
];
for (const [applicant, holder] of different) {
  check(`flagged: "${applicant}" vs "${holder}"`, () => {
    assert.equal(agree(applicant, holder), false);
  });
}

// ---------------------------------------------------------------------------
// Silence when there is nothing to compare — a missing bill is a different problem.
// ---------------------------------------------------------------------------
check("says nothing when the bill's account holder was never parsed", () => {
  const payload = { homeownerName: "David Simmons", ubAccountHolder: "" } as unknown as ParserPayload;
  assert.equal(evaluateBaselineRules(payload).some((r) => r.ruleId === "xcheck-nem-account-holder"), false);
});

check("says nothing when the application has no applicant name", () => {
  const payload = { homeownerName: "", ubAccountHolder: "STEPHANIE SIMMONS" } as unknown as ParserPayload;
  assert.equal(evaluateBaselineRules(payload).some((r) => r.ruleId === "xcheck-nem-account-holder"), false);
});

if (failures) { console.error(`\n${failures} account-holder check(s) FAILED.`); process.exit(1); }
console.log("\nAll account-holder checks passed.");
process.exit(0);
