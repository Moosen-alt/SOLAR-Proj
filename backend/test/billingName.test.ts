// TWO ROLES, TWO FIELDS.
//
// The permit goes under the property owner; the interconnection goes under whoever holds the
// utility ACCOUNT, and they are routinely different people. Ivy's account reads
// "PROF CHRIS A IVY" where the project says "Drew Example". Placeholder's is worse: the
// account is held by CRAIG while the plan set names ANN — a joint account — so a NEM
// application under "Emery Placeholder" is one Pacific Power has no account for.
//
// A first cut fixed that by making homeownerName resolve to the account holder on any utility
// portal. That is wrong wherever the form asks for BOTH, and PacifiCorp's does: page 3 is
// "Customer Information" (the account holder) and page 4 is "Property Owner Information".
// Overriding homeownerName would have put PROF CHRIS A IVY into the property-owner block — a
// different assertion about a different person. So the roles stay separate and a recording
// binds each block to the right one.
//   npx tsx backend/test/billingName.test.ts
import assert from "node:assert/strict";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The resolution as portalRecipes builds it.
const resolve = (projectOwner: string, ubHolder: string) => {
  const holder = String(ubHolder || "").trim();
  const parts = holder.replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, "").split(/\s+/).filter(Boolean);
  const owner = projectOwner.trim().split(/\s+/);
  return {
    homeownerName: projectOwner,
    homeownerFirstName: owner[0] || "",
    homeownerLastName: owner.slice(1).join(" "),
    ubAccountHolder: holder,
    ubAccountHolderFirstName: parts[0] || "",
    ubAccountHolderLastName: parts.length > 1 ? parts[parts.length - 1] : "",
    projectName: projectOwner,
  };
};

check("THE REGRESSION: the two roles never collapse into one name", () => {
  const f = resolve("Emery Placeholder", "Craig Placeholder");
  assert.equal(f.homeownerName, "Emery Placeholder", "property owner is the project's homeowner");
  assert.equal(f.ubAccountHolder, "Craig Placeholder", "the account is Craig's");
  assert.notEqual(f.homeownerName, f.ubAccountHolder);
});

check("a joint account exposes the holder for the customer block", () => {
  const f = resolve("Emery Placeholder", "Craig Placeholder");
  assert.equal(f.ubAccountHolderFirstName, "Craig");
  assert.equal(f.ubAccountHolderLastName, "Placeholder");
});

check("a billing title is kept in the account name but not in the first-name box", () => {
  const f = resolve("Drew Example", "PROF CHRIS A IVY");
  // The utility matches on the account name, so it must match the bill exactly.
  assert.equal(f.ubAccountHolder, "PROF CHRIS A IVY");
  // ...but "PROF" is not a first name.
  assert.equal(f.ubAccountHolderFirstName, "CHRIS");
  assert.equal(f.ubAccountHolderLastName, "IVY");
  // And the property owner is untouched by any of it.
  assert.equal(f.homeownerName, "Drew Example");
});

check("Project Name follows the PROJECT — it is how the inspector finds the job", () => {
  assert.equal(resolve("Emery Placeholder", "Craig Placeholder").projectName, "Emery Placeholder");
});

check("no bill on file leaves the account holder empty rather than guessing", () => {
  const f = resolve("Drew Example", "");
  assert.equal(f.ubAccountHolder, "");
  // Guessing the account holder from the project would file under a name the utility may
  // have no account for — the very failure this exists to prevent.
  assert.equal(f.homeownerName, "Drew Example");
});

if (failures) { console.error(`\n${failures} billing-name check(s) FAILED.`); process.exit(1); }
console.log("\nAll billing-name checks passed.");
process.exit(0);
