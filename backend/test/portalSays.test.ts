// "PORTAL SAYS" — THE AHJ'S OWN WORDS BESIDE OUR READING, AND AN OPEN FILING READ DAILY.
//
// Operator 2026-09-28, a Marion County building permit on Oregon ePermitting: the card said
// "Waiting" while the record read "Ready to Issue" — "Can we just pull exactly what the AHJ says …
// then we can just see what is needed directly without confusion". The reading was 14 hours old
// (portal then: "App Submitted") and the next was a week out. So:
//   1. every portal reading carries the record's own status field verbatim (portalStatedStatus);
//   2. the permit card shows it for the filing's NEWEST reading only (dashboard portalSaysFor);
//   3. an open filing is re-read daily (effectiveCheckDays), a finished one keeps its cadence.
//
//   npx tsx backend/test/portalSays.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-says-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const PM = await import("../src/permitMonitor");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Fictional record pages in the live shapes.
const ACCELA_READY = "Permit/Application 555-26-009999-STR: Residential Structural Record Status: Ready to Issue Expiration Date: 03/27/2027 Create a New Collection Work Location 1 EXAMPLE RD";
const ACCELA_WIDGET = "Record BLD26-09990: Building Record Status: Received Add to Existing Collection --Select-- Create a New Collection Work Location 1 EXAMPLE AVE";
const ACCELA_PUNCT = "Record 187-26-000902-STR: Residential Structural Record Status: Corr. Required Expiration Date: 03/16/2027";

// 1. The record's own words.
await check("portalStatedStatus: the Accela status field verbatim ('Ready to Issue')", () => {
  assert.equal(PM.portalStatedStatus(ACCELA_READY), "Ready to Issue");
});
await check("portalStatedStatus: a not-yet-issued record (collection widget, no Expiration Date) -> 'Received'", () => {
  assert.equal(PM.portalStatedStatus(ACCELA_WIDGET), "Received");
});
await check("portalStatedStatus: punctuation kept ('Corr. Required')", () => {
  assert.equal(PM.portalStatedStatus(ACCELA_PUNCT), "Corr. Required");
});
await check("portalStatedStatus: prose with no labelled status field -> ''", () => {
  assert.equal(PM.portalStatedStatus("Thank you. Your application has been received and will be reviewed."), "");
});

// 3. The cadence.
await check("effectiveCheckDays: an open filing is read daily whatever the stored cadence", () => {
  for (const o of ["waiting", "ready_for_issue", "correction_flagged", "needs_human_review", "reviewed_by_ahj", null]) {
    assert.equal(PM.effectiveCheckDays(7, o), 1, String(o));
  }
});
await check("effectiveCheckDays: a finished filing keeps its own cadence", () => {
  assert.equal(PM.effectiveCheckDays(7, "issued"), 7);
  assert.equal(PM.effectiveCheckDays(3, "nem_approved"), 3);
});

// Through the real write path: a target, a portal reading, the detail the dashboard reads.
const db = await openDatabase();
const pid = R.createProject(db, {
  owner: "Portal Says Owner", state: "OR", dcKw: "8.6", acKw: "5.8", permitPath: "prescriptive",
  street: "1 Example Rd", city: "Jefferson", zip: "97352", ahj: "Marion County", utility: "Pacific Power",
} as never).project.id;
let detail = R.createPermitCheckTarget(db, pid, { jurisdiction: "Marion County", applicationNumber: "555-26-009999-STR", permitType: "building", targetType: "permit" } as never);
const targetId = detail.permitCheckTargets.find((t) => t.applicationNumber === "555-26-009999-STR")!.id;
const before = Date.now();
await R.recordPermitStatusCheck(db, pid, { targetId, source: "manual", rawStatusText: ACCELA_READY });
detail = R.getProjectDetail(db, pid);
const reading = detail.permitStatusChecks.find((c) => c.targetId === targetId)!;
const target = detail.permitCheckTargets.find((t) => t.id === targetId)!;
await check("a portal reading carries the record's own words", () => {
  assert.equal(reading.portalStatedStatus, "Ready to Issue");
  assert.equal(reading.outcome, "ready_for_issue");
});
await check("the open filing is next read within a day, and the card says so", () => {
  assert.equal(target.checkFrequencyDays, 1);
  const next = Date.parse(String(target.nextCheckAt));
  assert.ok(next - before <= 26 * 3600 * 1000, `next check ${target.nextCheckAt} is more than a day out`);
});

// 2. The card: the dashboard's pure helper, lifted from frontend/dashboard.js.
const dashboard = fs.readFileSync(path.join(import.meta.dirname, "../../frontend/dashboard.js"), "utf8");
const start = dashboard.indexOf("function portalSaysFor(");
assert.ok(start >= 0, "portalSaysFor not found in dashboard.js");
const end = dashboard.indexOf("\n}\n", start);
const sandbox: Record<string, unknown> = {};
vm.runInNewContext(`${dashboard.slice(start, end + 2)}\nthis.portalSaysFor = portalSaysFor;`, sandbox);
const portalSaysFor = sandbox.portalSaysFor as (t: { id: string }, c: Array<Record<string, unknown>>) => { text: string; at: string } | null;
await check("card: the filing's newest reading's words are shown", () => {
  const said = portalSaysFor({ id: "t1" }, [
    { targetId: "t1", createdAt: "2026-09-28T06:03:27Z", portalStatedStatus: "App Submitted" },
    { targetId: "t1", createdAt: "2026-09-28T19:53:54Z", portalStatedStatus: "Ready to Issue" },
    { targetId: "t2", createdAt: "2026-09-29T00:00:00Z", portalStatedStatus: "Issued" },
  ]);
  // Field by field: the helper runs in its own vm realm, so its object has another prototype.
  assert.equal(said?.text, "Ready to Issue");
  assert.equal(said?.at, "2026-09-28T19:53:54Z");
});
await check("card MUST-EXCLUDE: an older reading's words never stand in for a newer reading that states none", () => {
  const said = portalSaysFor({ id: "t1" }, [
    { targetId: "t1", createdAt: "2026-09-28T06:03:27Z", portalStatedStatus: "App Submitted" },
    { targetId: "t1", createdAt: "2026-09-28T19:53:54Z", portalStatedStatus: "" },
  ]);
  assert.equal(said, null);
});
await check("card: an email reading states no portal words", async () => {
  await R.recordPermitStatusCheck(db, pid, { targetId, source: "email", rawStatusText: "Record Status: Issued" } as never);
  const d = R.getProjectDetail(db, pid);
  const email = d.permitStatusChecks.find((c) => c.source === "email");
  assert.ok(email, "email reading not recorded");
  assert.equal(email!.portalStatedStatus, "");
});

if (failures) { console.error(`\n${failures} portal-says check(s) FAILED.`); process.exit(1); }
console.log("\nAll portal-says checks passed.");
process.exit(0);
