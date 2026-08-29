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

const { dateFieldForLiteral, convertLiteralsToBoundFields, disambiguateByLabel, labelRulesOutAllCandidates } = await import("../src/portalRecipes");

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

run("a tie is broken by PRECISION, not left unresolved", () => {
  // "Installation Voltage" matches both on "voltage", but serviceVoltage also carries
  // "service", which the label never says — so plain voltage is the better read.
  assert.equal(disambiguateByLabel("Installation Voltage", ["serviceVoltage", "voltage"]), "voltage");
  // When the label DOES say service, the richer match wins on count before precision.
  assert.equal(disambiguateByLabel("Service Voltage", ["serviceVoltage", "voltage"]), "serviceVoltage");
});

// -- COINCIDENTAL COLLISIONS ------------------------------------------------------------
// PacifiCorp asks four separate questions whose answer is "No" — switchgear, parallel
// blocking scheme, serving more than one customer, a marketing opt-in. "No" is also this
// project's hasBattery and exportLimiting. Binding any of them would be actively wrong: a
// later project with a battery would flip its answer about a switchgear. But REPORTING them
// as ambiguous is a hard blocker in the trust gate, and it kept the PacifiCorp recipe out
// of trust over questions that have nothing to do with the fields they collided with.

run("a substantive label that names none of the candidates marks a portal constant", () => {
  for (const label of [
    "Will the net metering facility interconnect to a switchgear?",
    "Will the net metering facility include a parallel blocking scheme?",
    "Will the output of this generation system serve more than one customer?",
  ]) {
    assert.equal(labelRulesOutAllCandidates(label, ["hasBattery", "exportLimiting"]), true, label);
  }
});

run("a THIN label concludes nothing and still blocks", () => {
  // Absence of evidence is not evidence — without a real label we cannot tell a portal
  // constant from project data, so the ambiguity guard must stand.
  assert.equal(labelRulesOutAllCandidates("", ["hasBattery", "exportLimiting"]), false);
  assert.equal(labelRulesOutAllCandidates("Please select", ["hasBattery", "exportLimiting"]), false);
  // And a substantive label that DOES name a candidate is not a constant — it binds.
  assert.equal(labelRulesOutAllCandidates("Do you propose to limit the export capacity?", ["hasBattery", "exportLimiting"]), false);
});

run("a coincidental collision keeps its literal without blocking the recipe", () => {
  const steps: RecipeStep[] = [
    { action: "select", phase: "fill", selector: { label: "Will the net metering facility interconnect to a switchgear?" }, value: "No", note: "" },
  ];
  const result = convertLiteralsToBoundFields(steps, { hasBattery: "No", exportLimiting: "No" });
  assert.equal(result.ambiguous.length, 0, "still blocking on a question that is not about either field");
  assert.equal(result.steps[0].value, "No", "the portal's own answer must survive");
  assert.equal(result.steps[0].field, undefined, "and must NOT be bound to unrelated project data");
  assert.equal(result.portalConstants.length, 1, "the collision should still be reported for awareness");
});

// -- WHOLE DEGREES ----------------------------------------------------------------------
// Flagged live on the PacifiCorp form: the plan set carries a fractional azimuth ("180.5")
// and it was being typed into a field that wants whole degrees. Verified end to end below
// against the real project, because the rounding sits inside resolveRecipeFieldValues and
// several aliases (array1Azimuth, azimuth) reach a portal by different routes.

// Resolved OUTSIDE the sync runner — an async body inside it would escape the try/catch
// and report a phantom "ok".
const { openDatabase: openLiveDb } = await import("../src/db");
const liveDb = await openLiveDb();
const { resolveRecipeFieldValues } = await import("../src/portalRecipes");
const degreeFields = resolveRecipeFieldValues(liveDb, {
  homeownerName: "Test Owner", projectAddress: "1 Test St", city: "", state: "OR", zip: "",
  ahj: "", utility: "Pacific Power", accountNumber: "", meterNumber: "",
  parserSnapshot: { azimuth: "180.5", tilt: "22.4", pvArrays: [{ quantity: "14", azimuth: "180.5", tilt: "22.4" }] },
} as never, "powerclerk");
try { liveDb.close(); } catch { /* best effort */ }

run("a fractional plan-set orientation reaches the portal as whole degrees", () => {
  for (const key of ["array1Azimuth", "azimuth"]) {
    assert.equal(degreeFields[key], "181", `${key} reached the portal as ${JSON.stringify(degreeFields[key])}`);
  }
  for (const key of ["array1Tilt", "tilt"]) {
    assert.equal(degreeFields[key], "22", `${key} reached the portal as ${JSON.stringify(degreeFields[key])}`);
  }
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* leave to OS */ }

if (failures) {
  console.error(`\n${failures} recipe literal-binding test(s) failed.`);
  process.exit(1);
}
console.log("\nAll recipe literal-binding tests passed.");
process.exit(0);
