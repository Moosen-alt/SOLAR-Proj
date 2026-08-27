// Client notifier: change-detection gate, token idempotence, and the no-SMTP
// draft path (communication row recorded, nothing sent, never throws).
// Browser-free. Run: tsx backend/test/clientNotify.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-notify-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0"; // deterministic tests — no background autopilot
process.env.SEED_TEST_INSTALLER = "false";
delete process.env.SMTP_HOST; // force the draft path — no network in tests
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { shouldNotifyClient, ensureStatusShareToken, statusShareUrl, notifyClientOfStatusChange } = await import("../src/clientNotifier");

const db = await openDatabase();

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

await run("shouldNotifyClient: only client-relevant outcomes, only on CHANGE", () => {
  assert.equal(shouldNotifyClient("issued", ""), true);
  assert.equal(shouldNotifyClient("issued", null), true);
  assert.equal(shouldNotifyClient("issued", "reviewed_by_ahj"), true);
  assert.equal(shouldNotifyClient("issued", "issued"), false, "no re-send on every poll");
  assert.equal(shouldNotifyClient("nem_approved", "waiting"), true);
  assert.equal(shouldNotifyClient("correction_flagged", ""), true);
  assert.equal(shouldNotifyClient("waiting", ""), false, "waiting is not client-notify-worthy");
  assert.equal(shouldNotifyClient("needs_human_review", ""), false);
});

const client = createClient(db, { companyName: "Notify Solar LLC", ccbLicenseNumber: "222222", businessEmail: "installer@notify.test", businessPhone: "555" });
const detail = createProject(db, {
  clientId: client.id, owner: "Notify Test", street: "9 Status St", city: "Portland", state: "OR",
  ahj: "Portland", utility: "PGE", dcKw: "7", acKw: "5",
});
const project = detail.project;

await run("ensureStatusShareToken is idempotent and URL-safe", () => {
  const t1 = ensureStatusShareToken(db, project.id);
  const t2 = ensureStatusShareToken(db, project.id);
  assert.equal(t1, t2, "same token on repeat calls");
  assert.ok(/^[A-Za-z0-9_-]{20,}$/.test(t1), `token shape: ${t1}`);
  assert.ok(statusShareUrl(t1).includes(`/status?token=${t1}`));
});

await run("no SMTP → update recorded as a DRAFT communication with the status link", async () => {
  await notifyClientOfStatusChange(db, project, { outcome: "issued", statusLabel: "Permit Issued", targetType: "permit" });
  const comm = db.get<{ subject?: string; body?: string; direction?: string; channel?: string }>(
    "SELECT * FROM communications WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    [project.id],
  );
  assert.ok(comm, "communication row recorded");
  assert.equal(comm!.direction, "outbound");
  assert.equal(comm!.channel, "email");
  assert.ok((comm!.subject || "").includes("[draft"), `draft-marked (subject: ${comm!.subject})`);
  assert.ok((comm!.subject || "").includes("Permit issued"), "subject carries the outcome");
  assert.ok((comm!.body || "").includes("/status?token="), "body carries the status link");
  assert.ok((comm!.body || "").includes("9 Status St"), "body carries the address");
  assert.ok(!(comm!.body || "").match(/account|meter/i), "no sensitive field names in body");
});

await run("no client email → silently skips (no row, no throw)", async () => {
  const bare = createClient(db, { companyName: "No Email LLC", ccbLicenseNumber: "333333", businessEmail: "", businessPhone: "" });
  const d2 = createProject(db, { clientId: bare.id, owner: "No Email", street: "1 X St", city: "Bend", state: "OR", ahj: "Bend", utility: "PGE", dcKw: "5", acKw: "4" });
  const before = db.get<{ n: number }>("SELECT COUNT(*) n FROM communications WHERE project_id = ?", [d2.project.id])!.n;
  await notifyClientOfStatusChange(db, d2.project, { outcome: "issued", statusLabel: "Issued", targetType: "permit" });
  const after = db.get<{ n: number }>("SELECT COUNT(*) n FROM communications WHERE project_id = ?", [d2.project.id])!.n;
  assert.equal(after, before, "nothing recorded without a recipient");
});

await run("CLIENT_NOTIFICATIONS=0 disables everything", async () => {
  process.env.CLIENT_NOTIFICATIONS = "0";
  try {
    const before = db.get<{ n: number }>("SELECT COUNT(*) n FROM communications WHERE project_id = ?", [project.id])!.n;
    await notifyClientOfStatusChange(db, project, { outcome: "nem_approved", statusLabel: "Approved", targetType: "nem" });
    const after = db.get<{ n: number }>("SELECT COUNT(*) n FROM communications WHERE project_id = ?", [project.id])!.n;
    assert.equal(after, before);
  } finally {
    delete process.env.CLIENT_NOTIFICATIONS;
  }
});

// Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} client-notify test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll client-notify tests passed.");
process.exit(0);
