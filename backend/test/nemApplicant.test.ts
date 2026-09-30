// WHO THE NEM APPLICATION NAMES ON A JOINT ACCOUNT (operator ruling 2026-09-28).
//
// "Durwood is good seeing as they're listed. If they're not listed then primary name on the bill
// will apply for the NEM." The plan-set owner is the interconnection applicant when the bill lists
// them among its holders; otherwise the bill's primary (first-listed) holder; no bill holder on
// file → the homeowner, as before. A single holder is taken exactly as the bill prints it.
//
//   npx tsx backend/test/nemApplicant.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nem-applicant-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const AH = await import("../src/accountHolders");
const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const PR = await import("../src/portalRecipes");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const JOINT = "Robin L Sample / Durwood W Sample";

await check("billHoldersOf: every holder, in printed order; a given-name-only part takes the shared surname", () => {
  assert.deepEqual(AH.billHoldersOf(JOINT), ["Robin L Sample", "Durwood W Sample"]);
  assert.deepEqual(AH.billHoldersOf("JOHN & JANE SMITH"), ["JOHN SMITH", "JANE SMITH"]);
  assert.deepEqual(AH.billHoldersOf("SMITH, JOHN"), ["SMITH, JOHN"]);
  assert.deepEqual(AH.billHoldersOf(""), []);
});
await check("MUST-PASS: the plan-set owner listed on a joint bill is the applicant, as the bill prints them", () => {
  assert.equal(AH.nemApplicantName(JOINT, "Durwood Sample"), "Durwood W Sample");
  assert.equal(AH.nemApplicantName("JOHN & JANE SMITH", "Jane Smith"), "JANE SMITH");
});
await check("MUST-PASS: an owner NOT listed -> the bill's primary holder", () => {
  assert.equal(AH.nemApplicantName(JOINT, "Casey Sample"), "Robin L Sample");
  assert.equal(AH.nemApplicantName("JOHN & JANE SMITH", "Bob Smith"), "JOHN SMITH");
});
await check("MUST-EXCLUDE: a middle initial never stands in for a given name ('Lance Sample' is not 'Robin L Sample')", () => {
  assert.equal(AH.nemApplicantName("Durwood W Sample / Robin L Sample", "Lance Sample"), "Durwood W Sample");
});
await check("a single holder is taken exactly as printed; no bill holder -> the homeowner", () => {
  assert.equal(AH.nemApplicantName("PROF CHRIS A SAMPLE", "Christopher Sample"), "PROF CHRIS A SAMPLE");
  assert.equal(AH.nemApplicantName("", "Durwood Sample"), "Durwood Sample");
});

// Through the real write path: what the NEM portal fill types.
const db = await openDatabase();
const base = { state: "OR", dcKw: "8.6", acKw: "6.5", permitPath: "prescriptive", street: "1 Example Rd", city: "Newberg", zip: "97132", ahj: "Yamhill County", utility: "Portland General Electric" };
const valuesFor = (owner: string, ubAccountHolder: string) => {
  const pid = R.createProject(db, { owner, ...base, ...(ubAccountHolder ? { ubAccountHolder } : {}) } as never).project.id;
  return PR.resolveRecipeFieldValues(db, R.getProjectDetail(db, pid).project, "powerclerk", "nem");
};
await check("fill: joint bill listing the owner -> the owner's first/last on the NEM customer block", () => {
  const v = valuesFor("Durwood Sample", JOINT);
  assert.equal(v.ubAccountHolder, "Durwood W Sample");
  assert.equal(v.ubAccountHolderFirstName, "Durwood");
  assert.equal(v.ubAccountHolderLastName, "Sample");
});
await check("fill: joint bill NOT listing the owner -> the primary holder", () => {
  const v = valuesFor("Casey Sample", JOINT);
  assert.equal(v.ubAccountHolder, "Robin L Sample");
  assert.equal(v.ubAccountHolderFirstName, "Robin");
});
await check("fill: no bill holder -> the homeowner (unchanged)", () => {
  assert.equal(valuesFor("Durwood Sample", "").ubAccountHolder, "Durwood Sample");
});

if (failures) { console.error(`\n${failures} NEM-applicant check(s) FAILED.`); process.exit(1); }
console.log("\nAll NEM-applicant checks passed.");
process.exit(0);
