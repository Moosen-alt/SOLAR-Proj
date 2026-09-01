// AN INTERCONNECTION IS FILED UNDER THE NAME ON THE BILL.
//
// The permit goes under the property owner; the interconnection goes under whoever holds the
// utility ACCOUNT, and they are routinely different people. Live: Ivy's account reads
// "PROF CHRIS A IVY" where the project says "Christopher Ivy", and Marineau's account is held
// by CRAIG while the plan set names ANN — a joint account. Filing a NEM application under a
// name the utility has no account for is a rejection, or worse a second account opened in the
// wrong person's name.
//
// Operator rule: intake keys off the project, submittal keys off the bill.
//   npx tsx backend/test/billingName.test.ts
import assert from "node:assert/strict";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The resolution as portalRecipes applies it.
const resolve = (portalType: string, projectOwner: string, ubHolder: string) => {
  const holder = String(ubHolder || "").trim();
  const parts = holder.replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, "").split(/\s+/).filter(Boolean);
  const ubFirst = parts[0] || "";
  const ubLast = parts.length > 1 ? parts[parts.length - 1] : "";
  const projParts = projectOwner.trim().split(/\s+/);
  const useUb = /powerclerk|utility|nem|interconnect/i.test(portalType) && holder.length > 0;
  return {
    homeownerName: useUb ? holder : projectOwner,
    homeownerFirstName: useUb && ubFirst ? ubFirst : (projParts[0] || ""),
    homeownerLastName: useUb && ubLast ? ubLast : projParts.slice(1).join(" "),
    projectName: projectOwner,
    ubAccountHolder: holder,
  };
};

check("THE REGRESSION: a joint account files under the ACCOUNT HOLDER, not the plan set", () => {
  const nem = resolve("powerclerk", "Ann Marineau", "Craig Marineau");
  assert.equal(nem.homeownerName, "Craig Marineau");
  assert.equal(nem.homeownerFirstName, "Craig");
});

check("the permit still goes under the property owner", () => {
  const permit = resolve("accela", "Ann Marineau", "Craig Marineau");
  assert.equal(permit.homeownerName, "Ann Marineau");
});

check("a billing title is kept in the account name but not in the first-name box", () => {
  const nem = resolve("powerclerk", "Christopher Ivy", "PROF CHRIS A IVY");
  // The account name should match the bill exactly — the utility matches on it.
  assert.equal(nem.homeownerName, "PROF CHRIS A IVY");
  // ...but "PROF" is not a first name.
  assert.equal(nem.homeownerFirstName, "CHRIS");
  assert.equal(nem.homeownerLastName, "IVY");
});

check("Project Name always follows the PROJECT, on either portal", () => {
  assert.equal(resolve("powerclerk", "Ann Marineau", "Craig Marineau").projectName, "Ann Marineau");
  assert.equal(resolve("accela", "Ann Marineau", "Craig Marineau").projectName, "Ann Marineau");
});

check("no bill on file falls back to the project owner rather than filing blank", () => {
  const nem = resolve("powerclerk", "Christopher Ivy", "");
  assert.equal(nem.homeownerName, "Christopher Ivy");
});

check("the account holder is available by its own name on either portal", () => {
  assert.equal(resolve("accela", "Ann Marineau", "Craig Marineau").ubAccountHolder, "Craig Marineau");
});

if (failures) { console.error(`\n${failures} billing-name check(s) FAILED.`); process.exit(1); }
console.log("\nAll billing-name checks passed.");
process.exit(0);
