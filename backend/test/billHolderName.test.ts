// THE BILL'S ACCOUNT HOLDER IS A PERSON OR BUSINESS, NEVER THE UTILITY'S WEB ADDRESS (#28).
//
// A live PNM bill came back with ubAccountHolder "Pnm.Com" — the utility's website printed on
// the bill, read as the holder (the text parser's top-of-bill name fallback took the "PNM.COM"
// line and title-cased it). The reviewer gate's applicant-vs-holder rule then told the operator
// the interconnection application would be filed in the name of "Pnm.Com", and
// nemApplicantName would have put it on the NEM application.
//
// One predicate (accountHolders.isBillHolderName) now decides whether a bill read is a holder at
// all: a domain, URL, email, phone/number line, the project utility's own name or bill
// boilerplate is NOT. Every reader of ubAccountHolder honours it, and the parser page mirrors it
// (frontend/parser-review.js, loaded here through node:vm). Synthetic names only.
//   npx tsx backend/test/billHolderName.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { REPO } from "./_isolate";
import { isBillHolderName, nemApplicantName } from "../src/accountHolders";
import { evaluateBaselineRules } from "../src/baselineRules";
import { normalizeProject, parserField } from "../src/normalize";
import type { ParserPayload } from "../../shared/src/types";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const src = fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8");
const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(src, sandbox, { filename: "parser-review.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PR = sandbox.window.ParserReview as any;

// [value, utility] pairs. REJECTED: not a holder. ACCEPTED: a real-looking holder.
const REJECTED: Array<[string, string]> = [
  ["Example-Utility.com", ""],
  ["EXAMPLE-UTILITY.COM", "Example Utility"],
  ["Pnm.Com", ""],
  ["www.example-utility.com", ""],
  ["https://example-utility.com/pay", ""],
  ["exampleutility.coop", ""],
  ["billing@example-utility.com", ""],
  ["1-800-555-0100", ""],
  ["(555) 555-0100", ""],
  ["123 Sample St", ""],
  ["Account Summary", ""],
  ["SERVICE ADDRESS", ""],
  ["Amount Due", ""],
  ["Customer Service", ""],
  ["EXAMPLE UTILITY", "Example Utility"],
  ["Example Utility Co", "Example Utility"],
  ["EXAMPLE", "Example Utility"],
  ["", ""],
  ["  ", ""],
];
const ACCEPTED: Array<[string, string]> = [
  ["Jordan Q Sample", "Example Utility"],
  ["JORDAN SAMPLE / TAYLOR SAMPLE", "Example Utility"],
  ["MR CASEY EXAMPLEPERSON", ""],
  ["Sample Family Trust", "Example Utility"],
  ["Japsen Sample", "APS"],
  ["Bill Sample", ""],
  ["SAMPLE, JORDAN", "Example Utility"],
];

for (const [value, utility] of REJECTED) {
  check(`rejects ${JSON.stringify(value)}${utility ? ` (utility ${utility})` : ""}`, () => {
    assert.equal(isBillHolderName(value, utility), false);
    assert.equal(PR.isBillHolderName(value, utility), false, "parser page disagrees with the backend");
  });
}
for (const [value, utility] of ACCEPTED) {
  check(`accepts ${JSON.stringify(value)}${utility ? ` (utility ${utility})` : ""}`, () => {
    assert.equal(isBillHolderName(value, utility), true);
    assert.equal(PR.isBillHolderName(value, utility), true, "parser page disagrees with the backend");
  });
}

// ---------------------------------------------------------------------------
// nemApplicantName never returns a rejected value.
// ---------------------------------------------------------------------------
check("nemApplicantName: a domain holder counts as no holder → the homeowner", () => {
  assert.equal(nemApplicantName("Example-Utility.com", "Jordan Sample"), "Jordan Sample");
});
check("nemApplicantName: the utility's own name counts as no holder", () => {
  assert.equal(nemApplicantName("EXAMPLE UTILITY", "Jordan Sample", "Example Utility"), "Jordan Sample");
});
check("nemApplicantName: a real different holder still wins (ruling 2026-09-28 unchanged)", () => {
  assert.equal(nemApplicantName("TAYLOR EXAMPLE", "Jordan Sample", "Example Utility"), "TAYLOR EXAMPLE");
});
check("nemApplicantName: a rejected holder with no homeowner is empty, never the domain", () => {
  assert.equal(nemApplicantName("Example-Utility.com", ""), "");
});

// ---------------------------------------------------------------------------
// The reviewer gate's applicant-vs-holder rule.
// ---------------------------------------------------------------------------
const rule = (p: Record<string, unknown>) =>
  evaluateBaselineRules(p as unknown as ParserPayload).find((r) => r.ruleId === "xcheck-nem-account-holder");

check("THE REGRESSION: a domain holder never produces the mismatch; it asks to verify", () => {
  const hit = rule({ homeownerName: "Jordan Sample", ubAccountHolder: "Example-Utility.com", utility: "Example Utility", state: "NM" });
  assert.ok(hit, "an unreadable holder should still surface for review");
  assert.match(hit!.message, /account holder not read from the bill — verify/);
  assert.doesNotMatch(hit!.message, /Example-Utility\.com/, "the rejected read must not be presented as the holder");
  assert.doesNotMatch(hit!.message, /names Jordan Sample, but/);
  assert.equal(hit!.severity, "warning");
  assert.equal(hit!.fieldName, "ubAccountHolder");
});
check("the utility's own name as holder asks to verify too", () => {
  const hit = rule({ homeownerName: "Jordan Sample", ubAccountHolder: "EXAMPLE UTILITY", utility: "Example Utility" });
  assert.ok(hit);
  assert.match(hit!.message, /not read from the bill — verify/);
});
check("a genuinely different person still fires the mismatch as before", () => {
  const hit = rule({ homeownerName: "Jordan Sample", ubAccountHolder: "TAYLOR EXAMPLE", utility: "Example Utility" });
  assert.ok(hit);
  assert.match(hit!.message, /names Jordan Sample, but the utility bill's account holder is TAYLOR EXAMPLE/);
});
check("the same person stays silent", () => {
  assert.equal(rule({ homeownerName: "Jordan Sample", ubAccountHolder: "JORDAN SAMPLE", utility: "Example Utility" }), undefined);
});
check("no holder on file stays silent", () => {
  assert.equal(rule({ homeownerName: "Jordan Sample", utility: "Example Utility" }), undefined);
});

// ---------------------------------------------------------------------------
// homeownerName never falls back to a rejected bill read.
// ---------------------------------------------------------------------------
check("normalizeProject: a domain holder does not become the homeowner", () => {
  const p = normalizeProject("p1", { ubAccountHolder: "Example-Utility.com", utility: "Example Utility" } as ParserPayload);
  assert.equal(p.homeownerName, "");
});
check("normalizeProject: the utility's name as holder does not become the homeowner", () => {
  const p = normalizeProject("p1", { ubAccountHolder: "EXAMPLE UTILITY", utility: "Example Utility" } as ParserPayload);
  assert.equal(p.homeownerName, "");
});
check("normalizeProject: a real holder still fills an empty homeowner", () => {
  const p = normalizeProject("p1", { ubAccountHolder: "Jordan Sample", utility: "Example Utility" } as ParserPayload);
  assert.equal(p.homeownerName, "Jordan Sample");
});
check("parserField('homeownerName') skips a rejected holder", () => {
  assert.equal(parserField({ ubAccountHolder: "Example-Utility.com" } as ParserPayload, "homeownerName"), "");
  assert.equal(parserField({ ubAccountHolder: "Jordan Sample" } as ParserPayload, "homeownerName"), "Jordan Sample");
});

// ---------------------------------------------------------------------------
// Parser page: the vision bill reading of a domain never becomes the owner of record.
// ---------------------------------------------------------------------------
check("parser page: a bill 'owner' reading that is a domain never resolves the owner", () => {
  const f = (value: string, source: string, excerpt: string, confidence: number) => ({ value, confidence, evidence: { source, sheet: "", excerpt } });
  const out = PR.resolveReviewItems({
    attached: ["plan_set", "utility_bill"],
    planText: "JORDAN SAMPLE RESIDENCE  100 EXAMPLE RD",
    passes: [
      { kind: "vision", label: "photos", docsGiven: ["utility_bill"], response: { fields: { owner: f("Example-Utility.com", "utility_bill", "Example-Utility.com", 0.9) }, lowConfidenceFields: [], notes: "" } },
      { kind: "text", label: "text", docsGiven: ["plan_set"], response: { fields: { owner: f("Jordan Sample", "plan_set", "JORDAN SAMPLE RESIDENCE", 0.45) }, lowConfidenceFields: ["owner"], notes: "" } },
    ],
  });
  const text = JSON.stringify(out);
  const resolvedOwner = (out.resolved || []).find((r: { field: string }) => r.field === "owner");
  assert.ok(!resolvedOwner || !/Example-Utility/i.test(String(resolvedOwner.value)), `a domain was resolved as the owner: ${text}`);
  assert.ok(!(out.conflicts || []).some((c: { field: string; text: string }) => c.field === "owner" && /Example-Utility/i.test(c.text)), `a domain was offered as an owner reading: ${text}`);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall bill-holder checks passed");
