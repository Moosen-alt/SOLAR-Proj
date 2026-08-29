// A RECORDED DATE MUST NOT AGE INTO THE APPLICATION.
// A portal date field has no project value to bind to, so the learn-time planner computes
// one (llm.ts tells it to use todayDate plus a few weeks). convertLiteralsToBoundFields
// binds literals by VALUE EQUALITY against project data and deliberately skips todayDate
// as volatile — so the computed date matched nothing and froze into the recipe.
//
// Found live: the trusted 60-step PGE recipe carried "08/08/2026" as its Estimated
// Commissioning Date. Correct the day it was learned; a PAST date three weeks later. Every
// future project replaying that recipe would have filed a stale — and for a portal that
// validates it, rejected — commissioning date on a live interconnection application.
//
// Pins: date literals rebind by the CONTROL'S LABEL (value equality structurally cannot
// reach them), the format the portal demonstrated is preserved, a future-dated label gets
// a future date, and non-date literals are left alone.
// Browser-free. Run: tsx backend/test/recipeDateBinding.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-date-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { dateFieldForLiteral, convertLiteralsToBoundFields, disambiguateByLabel } = await import("../src/portalRecipes");

let failures = 0;
const run = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
};

run("a commissioning date binds to a field recomputed at replay, not a frozen literal", () => {
  assert.equal(dateFieldForLiteral("Estimated Commissioning Date", "08/08/2026"), "estimatedCommissioningDate");
  // PacifiCorp words the same concept differently.
  assert.equal(dateFieldForLiteral("Planned date of operation", "09/17/2026"), "estimatedCommissioningDate");
});

run("the recorded literal's FORMAT is preserved (it proves what the portal accepted)", () => {
  assert.equal(dateFieldForLiteral("Estimated Commissioning Date", "2026-08-08"), "estimatedCommissioningDateIso");
  assert.equal(dateFieldForLiteral("Signature Date", "08/08/2026"), "todayDateUs");
  assert.equal(dateFieldForLiteral("Signature Date", "2026-08-08"), "todayDate");
});

run("a signature/application date is today, not a future estimate", () => {
  assert.equal(dateFieldForLiteral("Application Date", "08/08/2026"), "todayDateUs");
});

run("only DATE-labelled controls holding DATE-shaped values are touched", () => {
  // A date-shaped value on a control that is not a date (an account number that happens
  // to look like one, a free-text note) must keep its recorded literal.
  assert.equal(dateFieldForLiteral("Account Number", "08/08/2026"), null);
  // A date label whose value is not a date.
  assert.equal(dateFieldForLiteral("Estimated Commissioning Date", "Residential"), null);
  // The constants a residential PV application always sends stay frozen, correctly.
  for (const v of ["Residential", "a. Solar", "Photovoltaic", "Static Inverter"]) {
    assert.equal(dateFieldForLiteral("Type", v), null, `${v} must stay a literal`);
  }
});

run("the binder swaps the literal out entirely — it can never replay verbatim", () => {
  const steps: RecipeStep[] = [
    { action: "fill", phase: "fill", selector: { label: "Estimated Commissioning Date" }, value: "08/08/2026", note: "Estimated Commissioning Date" },
    { action: "select", phase: "fill", selector: { label: "Energy Source" }, value: "a. Solar", note: "Energy Source" },
  ];
  const result = convertLiteralsToBoundFields(steps, { homeownerName: "Wynema Test", todayDate: "2026-08-29" });
  const dateStep = result.steps[0];
  assert.equal(dateStep.field, "estimatedCommissioningDate", "date step did not rebind");
  assert.equal(dateStep.value, undefined, "the stale literal survived — it would replay verbatim");
  assert.ok(result.bound.some((b) => b.field === "estimatedCommissioningDate"), "the rebinding was not reported");
  // The genuine constant is untouched.
  assert.equal(result.steps[1].value, "a. Solar");
  assert.equal(result.steps[1].field, undefined);
});

run("a sensitive step is never rebound by the date rule either", () => {
  const steps: RecipeStep[] = [
    { action: "fill", phase: "fill", selector: { label: "Date of Birth" }, value: "08/08/1970", sensitive: true, note: "DOB" },
  ];
  const result = convertLiteralsToBoundFields(steps, {});
  assert.equal(result.steps[0].field, undefined, "a sensitive field must not be rebound");
});

// -- AMBIGUOUS LITERALS ----------------------------------------------------------------
// A Yes/No portal question is worth as much as a date here: "No" is equally the value of
// hasBattery and of exportLimiting, so the binder refused both and reported an ambiguity —
// which the trust gate treats as a HARD BLOCKER. That alone kept the live PGE recipe out
// of trust. The control was labelled "Energy Storage", which says which field it is.

run("the control's label settles a literal that matches two fields", () => {
  assert.equal(disambiguateByLabel("Energy Storage", ["hasBattery", "exportLimiting"]), "hasBattery");
  assert.equal(disambiguateByLabel("Do you propose to limit the export capacity?", ["hasBattery", "exportLimiting"]), "exportLimiting");
});

run("a label that settles nothing still blocks, as before", () => {
  // No token of either candidate appears — guessing here would bind the wrong data.
  assert.equal(disambiguateByLabel("Please answer", ["hasBattery", "exportLimiting"]), null);
  assert.equal(disambiguateByLabel("", ["hasBattery", "exportLimiting"]), null);
});

run("a tie between two equally-matching candidates is left ambiguous", () => {
  // Both name the homeowner; the label cannot choose, so it must not.
  assert.equal(disambiguateByLabel("Homeowner", ["homeownerFirstName", "homeownerLastName"]), null);
});

run("an ambiguous Yes/No binds instead of blocking the recipe", () => {
  const steps: RecipeStep[] = [
    { action: "select", phase: "fill", selector: { label: "Energy Storage" }, value: "No", note: "Energy Storage" },
  ];
  const result = convertLiteralsToBoundFields(steps, { hasBattery: "No", exportLimiting: "No" });
  assert.equal(result.ambiguous.length, 0, "still reported ambiguous — the recipe cannot be trusted");
  assert.equal(result.steps[0].field, "hasBattery");
  assert.equal(result.steps[0].value, undefined, "the literal must not survive");
});

run("a truly ambiguous literal is STILL reported (the guard is intact)", () => {
  const steps: RecipeStep[] = [
    { action: "select", phase: "fill", selector: { label: "Please answer" }, value: "No", note: "" },
  ];
  const result = convertLiteralsToBoundFields(steps, { hasBattery: "No", exportLimiting: "No" });
  assert.equal(result.ambiguous.length, 1, "an unresolvable ambiguity must still block promotion");
  assert.equal(result.steps[0].field, undefined);
  assert.equal(result.steps[0].value, "No");
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* leave to OS */ }

if (failures) {
  console.error(`\n${failures} recipe literal-binding test(s) failed.`);
  process.exit(1);
}
console.log("\nAll recipe literal-binding tests passed.");
process.exit(0);
