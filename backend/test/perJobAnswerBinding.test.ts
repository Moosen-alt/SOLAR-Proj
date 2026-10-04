// A PORTAL QUESTION THE PROJECT RECORD CANNOT ANSWER GETS FROZEN OR LEFT BLANK.
//
// Measured live 2026-09-11: PacifiCorp's recipe replays 14 frozen [select] literals,
// including "Will the System be Customer-Owned or Third-Party Owned?" = "Customer-Owned" —
// project A's FINANCING, pinned into a shared recipe, silently wrong on any third-party-
// owned job (and invisible to the cross-project sweep whenever A and B agree by luck).
// Ameren separately leaves "Community Solar / Behind the Meter" blank because no binding
// exists at all. Migration v17 + the ownershipModel / systemConfiguration /
// disconnectWithin10ft bindings make those answers per-job project data.
//
// What this file protects:
//   - the migration lands the three columns on a fresh DB;
//   - a set column resolves to the PORTAL-WORDED canonical value (replay's select
//     matching normalizes case/whitespace only — a slug like 'behind-the-meter' would
//     miss the option "Behind the Meter" forever);
//   - ownershipModel and disconnectWithin10ft NEVER default — empty resolves "" so
//     replay leaves the control blank and reports it, the safe direction;
//   - systemConfiguration's one default ("Behind the Meter") fires ONLY for a project
//     with a utility account, and an explicit 'community-solar' answer always beats it;
//   - the keys are ALWAYS emitted (even empty) so deadFieldBindings never calls a step
//     bound to them unfillable.
//
// Browser-free. Run: tsx backend/test/perJobAnswerBinding.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "per-job-answer-binding-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail } = await import("../src/repository");
const { resolveRecipeFieldValues, deadFieldBindings, RECIPE_FIELD_DESCRIPTIONS } = await import("../src/portalRecipes");
import type { RecipeStep } from "../../shared/src/types";
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
  homeownerName: "Avery Sample",
  projectAddress: "5060 Synthetic Ave",
  city: "Coos Bay",
  zip: "97420",
  dcKw: 7.2,
};

// Create a project, stamp the per-job answer COLUMNS (and optionally the utility
// account) via SQL — exactly how the intake/operator write path reaches them, and
// deliberately NOT via the in-memory record, so this exercises the resolver's own
// column read (mapProject predates these fields).
const valuesFor = (columns: {
  ownership_model?: string;
  system_configuration?: string;
  disconnect_within_10ft?: string;
  account_number?: string;
}): Record<string, string> => {
  const created = createProject(db, { ...base } as never);
  db.run(
    `UPDATE projects SET ownership_model = ?, system_configuration = ?, disconnect_within_10ft = ?, account_number = ?
     WHERE id = ?`,
    [
      columns.ownership_model ?? "",
      columns.system_configuration ?? "",
      columns.disconnect_within_10ft ?? "",
      columns.account_number ?? "",
      created.project.id,
    ],
  );
  const detail = getProjectDetail(db, created.project.id);
  return resolveRecipeFieldValues(db, detail.project, "utility");
};

// ---------------------------------------------------------------------------
// The migration itself: a fresh scratch DB has the columns and records v17.
// ---------------------------------------------------------------------------
run("migration v17 applied: the three answer columns exist on projects", () => {
  const cols = db.query<{ name: string }>("PRAGMA table_info(projects)").map((c) => c.name);
  for (const col of ["ownership_model", "system_configuration", "disconnect_within_10ft"]) {
    assert.ok(cols.includes(col), `projects.${col} missing`);
  }
  const max = db.query<{ max: number | null }>("SELECT MAX(version) AS max FROM schema_meta")[0];
  assert.ok((max?.max ?? 0) >= 17, `schema_meta MAX(version) is ${max?.max}, expected >= 17`);
});

// ---------------------------------------------------------------------------
// Set column -> canonical PORTAL-WORDED value. The wordings are the ones the live
// recipes recorded (PacifiCorp: "Customer-Owned"/"Third-Party Owned"; Ameren:
// "Behind the Meter"/"Community Solar") — replay's select matching bridges case and
// whitespace but never hyphen-vs-space, so the slug itself must not leak through.
// ---------------------------------------------------------------------------
run("ownership_model column resolves to the portal wording, per option", () => {
  assert.equal(valuesFor({ ownership_model: "third-party-owned" }).ownershipModel, "Third-Party Owned");
  assert.equal(valuesFor({ ownership_model: "customer-owned" }).ownershipModel, "Customer-Owned");
  assert.equal(valuesFor({ ownership_model: "lease" }).ownershipModel, "Lease");
  assert.equal(valuesFor({ ownership_model: "ppa" }).ownershipModel, "PPA");
});

run("system_configuration and disconnect_within_10ft columns resolve to portal wordings", () => {
  const v = valuesFor({ system_configuration: "behind-the-meter", disconnect_within_10ft: "yes" });
  assert.equal(v.systemConfiguration, "Behind the Meter");
  assert.equal(v.disconnectWithin10ft, "Yes");
  assert.equal(valuesFor({ disconnect_within_10ft: "no" }).disconnectWithin10ft, "No");
});

// ---------------------------------------------------------------------------
// NO GUESSING: financing and site facts resolve "" when unanswered, so replay
// leaves the control blank and REPORTS it instead of filing project A's answer.
// ---------------------------------------------------------------------------
run("empty ownershipModel resolves \"\" — financing is never guessed", () => {
  const v = valuesFor({ account_number: "123456789" });
  assert.equal(v.ownershipModel, "");
});

run("empty disconnectWithin10ft resolves \"\" — a site fact is never guessed", () => {
  const v = valuesFor({ account_number: "123456789" });
  assert.equal(v.disconnectWithin10ft, "");
});

// ---------------------------------------------------------------------------
// The ONE default, and its guard — kill-tested from both directions.
// ---------------------------------------------------------------------------
run("empty systemConfiguration on a project WITH a utility account defaults to Behind the Meter", () => {
  // Every residential NEM filing in this fleet is behind-the-meter; the account is the
  // evidence there is a meter for the system to sit behind.
  const v = valuesFor({ account_number: "123456789" });
  assert.equal(v.systemConfiguration, "Behind the Meter");
});

run("KILL-TEST the guard: no utility account, no default — resolves \"\"", () => {
  // If someone makes the default unconditional, this catches it: a project with no
  // account on file must give the portal nothing rather than a guess.
  const v = valuesFor({});
  assert.equal(v.systemConfiguration, "");
});

run("KILL-TEST the override: an explicit answer always beats the default", () => {
  // If someone reorders the `|| default`, the guarded default would stomp a recorded
  // community-solar answer — the exact silent-wrong-answer class this build kills.
  const v = valuesFor({ system_configuration: "community-solar", account_number: "123456789" });
  assert.equal(v.systemConfiguration, "Community Solar");
});

// ---------------------------------------------------------------------------
// The keys exist even when empty, so the post-learn binder can offer them and
// deadFieldBindings never calls a step bound to them unfillable.
// ---------------------------------------------------------------------------
run("all three keys are ALWAYS present in the resolved map, and never dead bindings", () => {
  const v = valuesFor({});
  for (const k of ["ownershipModel", "systemConfiguration", "disconnectWithin10ft"]) {
    assert.ok(k in v, `${k} missing from resolveRecipeFieldValues output`);
  }
  const steps: RecipeStep[] = [
    { action: "select", selector: { label: "Will the System be Customer-Owned or Third-Party Owned?" }, field: "ownershipModel" },
    { action: "select", selector: { label: "Community Solar / Behind the Meter" }, field: "systemConfiguration" },
    { action: "select", selector: { label: "Is the AC disconnect within 10 feet of the meter?" }, field: "disconnectWithin10ft" },
  ] as never;
  assert.deepEqual(deadFieldBindings(steps, v), [], "a step bound to a per-job answer key read as unfillable");
});

// ---------------------------------------------------------------------------
// The in-memory record field wins once repository maps it (forward-compatibility
// with the mapProject update this build does not own).
// ---------------------------------------------------------------------------
run("a record-level answer overrides the column read", () => {
  const created = createProject(db, { ...base } as never);
  const detail = getProjectDetail(db, created.project.id);
  const project = { ...detail.project, ownershipModel: "ppa" };
  assert.equal(resolveRecipeFieldValues(db, project, "utility").ownershipModel, "PPA");
});

// ---------------------------------------------------------------------------
// THE PARCEL HAS ITS OWN KEY (portal-run-close 7): the learner's ACA work-location pass binds
// the parcel search to parcelNumber. The key is in the recipe dictionary (so it is bindable on
// every learn and the binder can offer it), resolves from the parser snapshot when the project
// has one, and a recipe bound to it is flagged dead for a project WITHOUT a parcel.
// ---------------------------------------------------------------------------
run("parcelNumber: in the recipe dictionary, resolved from the snapshot, flagged dead only when the project has none", () => {
  assert.ok(typeof RECIPE_FIELD_DESCRIPTIONS.parcelNumber === "string" && /parcel/i.test(RECIPE_FIELD_DESCRIPTIONS.parcelNumber), "parcelNumber missing from RECIPE_FIELD_DESCRIPTIONS");
  // The parcel lives in the parser snapshot (structuralIntake / the plan-set parser write it);
  // the resolver reads it off the project record.
  const created = createProject(db, { ...base } as never);
  const project = getProjectDetail(db, created.project.id).project;
  const fieldsWith = resolveRecipeFieldValues(db, { ...project, parserSnapshot: { parcelNumber: "10-10-10-10-101" } }, "ahj");
  const fieldsWithout = resolveRecipeFieldValues(db, { ...project, parserSnapshot: {} }, "ahj");
  assert.equal(fieldsWith.parcelNumber, "10-10-10-10-101", "the snapshot's parcel resolves");
  const parcelStep: RecipeStep = { action: "fill", selector: { css: "input[id*='ParcelNo' i]" }, field: "parcelNumber", note: "work location: parcel number (no dashes)" };
  assert.deepEqual(deadFieldBindings([parcelStep], fieldsWith), [], "bound and resolvable for a project with a parcel");
  assert.equal(deadFieldBindings([parcelStep], fieldsWithout).length, 1, "flagged for a project without a parcel");
});

if (failures) { console.error(`\n${failures} per-job-answer-binding check(s) FAILED.`); process.exit(1); }
console.log("\nAll per-job-answer-binding checks passed.");
process.exit(0);
