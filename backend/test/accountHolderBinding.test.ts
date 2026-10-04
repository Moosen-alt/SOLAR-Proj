// THE CUSTOMER ON AN INTERCONNECTION APPLICATION IS THE ACCOUNT HOLDER, NOT THE HOMEOWNER.
//
// PacifiCorp's Customer Generation wizard asks for both, on consecutive pages: page 3
// "Customer Information" (whoever holds the electric account) and page 4 "Property Owner
// Information" (whoever owns the house). Usually the same person, which is exactly why the
// distinction rots quietly — the PacifiCorp recipe was learned on a project where they
// matched, so its Customer block was bound to homeownerFirstName/LastName.
//
// APP-111681 is the case that separated them: the house is Finley Mockdata', the account is
// Stephanie Mockdata'. The application filed as Finley, and PacifiCorp suspended it the next
// morning with a ten-business-day withdrawal clock.
//
// The recipe now binds the customer block to ubAccountHolder*, which is only safe because
// those keys can no longer come back empty. That fallback is the thing this test protects:
// without it, ubAccountHolder* is populated only when a bill happened to parse, so a blank
// would hit a REQUIRED name field and fail the submission outright — and the next person to
// notice would "fix" it by binding the customer block back to homeowner*, reintroducing the
// bug.
//
// Browser-free. Run: tsx backend/test/accountHolderBinding.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-holder-binding-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { resolveRecipeFieldValues } = await import("../src/portalRecipes");
const { getProjectDetail } = await import("../src/repository");
const db = await openDatabase();

let failures = 0;
const run = (label: string, fn: () => void | Promise<void>): void => {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error("sync only");
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

const base = {
  state: "OR",
  ahj: "City of Coos Bay",
  utility: "Pacific Power",
  projectAddress: "5060 Synthetic Ave",
  city: "Coos Bay",
  zip: "97420",
  dcKw: 7.2,
};

const valuesFor = (payload: Record<string, unknown>): Record<string, string> => {
  const created = createProject(db, payload as never);
  const detail = getProjectDetail(db, created.project.id);
  return resolveRecipeFieldValues(db, detail.project as never) as unknown as Record<string, string>;
};

// ---------------------------------------------------------------------------
// The live case: the bill names someone other than the homeowner.
// ---------------------------------------------------------------------------
const split = valuesFor({
  ...base,
  homeownerName: "Finley Mockdata",
  homeownerEmail: "finley.mockdata@example.com",
  ubAccountHolder: "STEPHANIE MOCKDATA",
});

run("THE REGRESSION: the customer keys carry the ACCOUNT HOLDER", () => {
  assert.equal(split.ubAccountHolder, "STEPHANIE MOCKDATA");
  assert.equal(split.ubAccountHolderFirstName, "STEPHANIE");
  assert.equal(split.ubAccountHolderLastName, "MOCKDATA");
});

run("...while the homeowner keys still carry the PROPERTY OWNER", () => {
  assert.equal(split.homeownerName, "Finley Mockdata");
  assert.equal(split.homeownerFirstName, "Finley");
  assert.equal(split.homeownerLastName, "Mockdata");
});

run("the two roles never collapse into one another", () => {
  // If these ever match on this fixture, one block is being filled with the other's person —
  // which is either the filing that got suspended, or PROF CHRIS A IVY landing in the
  // property-owner block, depending on which way it collapsed.
  assert.notEqual(split.ubAccountHolderFirstName, split.homeownerFirstName);
});

// ---------------------------------------------------------------------------
// The ordinary case: no bill parsed. The customer keys must still be usable.
// ---------------------------------------------------------------------------
const noBill = valuesFor({
  ...base,
  homeownerName: "Avery Sample",
  homeownerEmail: "ww@example.com",
  homeownerPhone: "(541) 555-0100",
});

run("THE FALLBACK: with no bill parsed the customer keys fall back to the homeowner", () => {
  assert.equal(noBill.ubAccountHolder, "Avery Sample");
  assert.equal(noBill.ubAccountHolderFirstName, "Avery");
  assert.equal(noBill.ubAccountHolderLastName, "Sample");
});

run("...so a REQUIRED customer-name field is never filled blank", () => {
  for (const k of ["ubAccountHolder", "ubAccountHolderFirstName", "ubAccountHolderLastName", "ubAccountHolderEmail"]) {
    assert.ok(String(noBill[k] || "").trim().length > 0, `${k} resolved empty — the submission would fail`);
  }
});

run("...and the fallback is INDISTINGUISHABLE from the old behaviour when they agree", () => {
  assert.equal(noBill.ubAccountHolderFirstName, noBill.homeownerFirstName);
  assert.equal(noBill.ubAccountHolderLastName, noBill.homeownerLastName);
});

// ---------------------------------------------------------------------------
// A billing name carrying a title must not put "PROF" in the first-name box.
// ---------------------------------------------------------------------------
const titled = valuesFor({
  ...base,
  homeownerName: "Chris Ivy",
  ubAccountHolder: "PROF CHRIS A IVY",
});

run("a title on the bill is dropped before splitting, but kept in the full account name", () => {
  assert.equal(titled.ubAccountHolder, "PROF CHRIS A IVY", "the account-name field should match the bill exactly");
  assert.equal(titled.ubAccountHolderFirstName, "CHRIS");
  assert.equal(titled.ubAccountHolderLastName, "IVY");
});

if (failures) { console.error(`\n${failures} account-holder-binding check(s) FAILED.`); process.exit(1); }
console.log("\nAll account-holder-binding checks passed.");
process.exit(0);
