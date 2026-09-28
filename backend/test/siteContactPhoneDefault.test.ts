// THE SITE CONTACT'S PHONE WHEN NONE IS ON FILE (operator ruling 2026-09-28): "elec got held up at
// the site contact phone #, assuming due to there not being one on file, if that happens just do
// 000-000-0000". The Coos Bay electrical recipe binds "contact: phone [site contact]" to
// homeownerPhone; a project with no phone resolved it blank and the required box stopped the run.
//
//   npx tsx backend/test/siteContactPhoneDefault.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "site-contact-phone-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const PR = await import("../src/portalRecipes");
const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const BASE = { state: "OR", dcKw: "8.6", acKw: "6.5", permitPath: "prescriptive", street: "500 Central Ave", city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power" };

await check("MUST-PASS: no phone on file -> the site contact phone is 000-000-0000 (whole key and its three Accela segments)", () => {
  const pid = R.createProject(db, { owner: "No Phone Owner", ...BASE } as never).project.id;
  const v = PR.resolveRecipeFieldValues(db, R.getProjectDetail(db, pid).project, "accela", "electrical");
  assert.equal(v.homeownerPhone.replace(/[^0-9]/g, ""), "0000000000", v.homeownerPhone);
  const segments = Object.entries(v).filter(([k]) => k.startsWith("homeownerPhone") && k !== "homeownerPhone").map(([, x]) => x);
  assert.ok(segments.length > 0 && segments.every((x) => /^0+$/.test(x)), JSON.stringify(segments));
});
await check("MUST-EXCLUDE: a phone on file is never replaced", () => {
  const pid = R.createProject(db, { owner: "Phone Owner", ...BASE, homeownerPhone: "(541) 555-0199" } as never).project.id;
  const v = PR.resolveRecipeFieldValues(db, R.getProjectDetail(db, pid).project, "accela", "electrical");
  assert.match(v.homeownerPhone, /541.*555.*0199/);
});

console.log(`\nsiteContactPhoneDefault: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
