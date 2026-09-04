// AN EXCLUSION LIST THAT REJECTS THE TARGET IS WORSE THAN NO EXCLUSION LIST.
//
// PROGRAM_EXCLUDE decides which programme options the chooser will not pick — a rebate is
// not an interconnection, and picking one files the wrong thing entirely. It was written
// as bare substrings with no word boundaries, and so refused the likeliest name the RIGHT
// programme can have:
//
//   "Renewable Energy Interconnection"  matched `renew`  -> EXCLUDED
//   "Renewable Energy Systems"          matched `renew`  -> EXCLUDED
//   "Backflow Prevention"               matched `back`   -> EXCLUDED
//   "Enclosed Structure Permit"         matched `close`  -> EXCLUDED
//
// On any portal calling its programme "Renewable Energy …" — which is what a great many
// utilities call precisely the thing being filed — no option was eligible, chooseProgram
// returned nothing, and the learn could not enter the application at all. It fails in the
// direction that looks like a portal problem, which is the expensive direction.
//
// So both halves are pinned here: the list must not reject a real solar programme, and it
// must still reject the lifecycle transactions it exists to reject. Browser-free.
//   npx tsx portal-bot/src/adapters/programExclude.test.ts
import assert from "node:assert/strict";
import { PROGRAM_EXCLUDE, chooseProgram } from "./applicationProgram";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

check("THE REGRESSION: 'Renewable' is not 'Renew'", () => {
  for (const name of [
    "Renewable Energy Interconnection",
    "Renewable Energy Systems",
    "Solar Photovoltaic - Renewable",
    "Renewable Generation Application",
  ]) {
    assert.equal(PROGRAM_EXCLUDE.test(name), false, `wrongly excluded: ${name}`);
  }
});

check("...and a lifecycle RENEWAL is still refused", () => {
  for (const name of ["Renew an existing permit", "Permit Renewal", "Renewals"]) {
    assert.equal(PROGRAM_EXCLUDE.test(name), true, `wrongly allowed: ${name}`);
  }
});

check("'Backflow' is not 'Back', 'Enclosed' is not 'Close'", () => {
  assert.equal(PROGRAM_EXCLUDE.test("Backflow Prevention"), false);
  assert.equal(PROGRAM_EXCLUDE.test("Enclosed Structure Permit"), false);
  assert.equal(PROGRAM_EXCLUDE.test("Closed Loop Geothermal"), false, "an adjective, not the close-out action");
});

check("...while the navigation and close-out controls stay refused", () => {
  for (const name of ["Back", "Close Out Permit", "Closing", "Help", "Helpdesk"]) {
    assert.equal(PROGRAM_EXCLUDE.test(name), true, `wrongly allowed: ${name}`);
  }
});

check("the programmes this list exists for are still refused", () => {
  for (const name of [
    "Distributed Generation Rebates", "Rebate Application", "Incentive Program",
    "Amend an application", "Withdraw application", "Cancel request",
    "Enrollment", "Enrol now",
  ]) {
    assert.equal(PROGRAM_EXCLUDE.test(name), true, `wrongly allowed: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// End to end through the chooser, which is what actually decides.
// ---------------------------------------------------------------------------
const group = (labels: string[]) => [{
  area: 1000,
  options: labels.map((label, i) => ({ key: `k${i}`, label, radio: true })),
}];

check("A REAL DRAWER: 'Renewable Energy Interconnection' is now CHOSEN, not skipped", () => {
  const pick = chooseProgram(group(["Renewable Energy Interconnection", "Renewable Energy Rebates"]));
  assert.equal(pick?.label, "Renewable Energy Interconnection");
});

check("...and the rebate beside it is still never chosen", () => {
  // Only the rebate on offer: refusing outright is correct — filing a rebate instead of an
  // interconnection is the wrong-permit-type mistake in another costume.
  assert.equal(chooseProgram(group(["Renewable Energy Rebates", "Close Out"])), undefined);
});

check("ComEd's real pair still resolves the way it did", () => {
  const pick = chooseProgram(group(["Distributed Generation", "Distributed Generation Rebates"]));
  assert.equal(pick?.label, "Distributed Generation");
});

if (failures) { console.error(`\n${failures} program-exclude check(s) FAILED.`); process.exit(1); }
console.log("\nAll program-exclude checks passed.");
process.exit(0);
