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
const { createClient, updateClient, getClient } = await import("../src/clients");
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

// The third argument is the writer's readingMayFinishTrack verdict (D2 final round, 769fc7d) —
// required, never optional. A trusted reading behaves as before; an untrusted one never tells a
// client a track finished, and a correction is still news either way.
const TRUSTED = { trusted: true } as const;
const UNTRUSTED = { trusted: false, reason: "an email's approval (not a portal poll)" } as const;
await run("shouldNotifyClient: only client-relevant outcomes, only on CHANGE", () => {
  assert.equal(shouldNotifyClient("issued", "", TRUSTED), true);
  assert.equal(shouldNotifyClient("issued", null, TRUSTED), true);
  assert.equal(shouldNotifyClient("issued", "reviewed_by_ahj", TRUSTED), true);
  assert.equal(shouldNotifyClient("issued", "issued", TRUSTED), false, "no re-send on every poll");
  assert.equal(shouldNotifyClient("nem_approved", "waiting", TRUSTED), true);
  assert.equal(shouldNotifyClient("correction_flagged", "", TRUSTED), true);
  assert.equal(shouldNotifyClient("waiting", "", TRUSTED), false, "waiting is not client-notify-worthy");
  assert.equal(shouldNotifyClient("needs_human_review", "", TRUSTED), false);
});
await run("MUST-EXCLUDE shouldNotifyClient: an untrusted reading never tells the client a track finished; a correction is still news", () => {
  assert.equal(shouldNotifyClient("issued", "", UNTRUSTED), false, "an email's 'issued' is not told to the client");
  assert.equal(shouldNotifyClient("nem_approved", "waiting", UNTRUSTED), false, "an email's NEM approval is not told to the client");
  assert.equal(shouldNotifyClient("correction_flagged", "", UNTRUSTED), true, "a correction from the AHJ's own email is still news");
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
  const comm = db.get<{ subject?: string; body?: string; direction?: string; channel?: string; delivery_status?: string; delivery_detail?: string; recipient?: string }>(
    "SELECT * FROM communications WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    [project.id],
  );
  assert.ok(comm, "communication row recorded");
  assert.equal(comm!.direction, "outbound");
  assert.equal(comm!.channel, "email");
  // Delivery state moved OUT of the subject and into its own column (migration v25). The
  // prefix is what made "what did we fail to send?" unqueryable and let three real messages sit
  // undelivered for twelve days, so asserting it here would pin the bug in place.
  assert.equal(comm!.delivery_status, "draft", `draft-marked (status: ${comm!.delivery_status})`);
  assert.match(comm!.delivery_detail || "", /not configured/i, "and the reason distinguishes unconfigured SMTP from a failed send");
  assert.doesNotMatch(comm!.subject || "", /^\[/, `the subject must be the subject: ${comm!.subject}`);
  assert.ok((comm!.subject || "").includes("Permit issued"), "subject carries the outcome");
  assert.ok((comm!.body || "").includes("/status?token="), "body carries the status link");
  assert.ok((comm!.body || "").includes("9 Status St"), "body carries the address");
  assert.ok(!(comm!.body || "").match(/account|meter/i), "no sensitive field names in body");
});

await run("THE SHARED INBOX IS THE RECIPIENT — the one field whose whole purpose is this message", async () => {
  // The guide asks for it as REQUIRED: "Shared inbox for Keelix updates — where we send
  // confirmations, status updates and corrections. A shared inbox, not one person's." The column
  // existed (migration v18), the intake template collected it, and the notifier sent to
  // business_email — so every update went to the address the customer was told it would not.
  // Asserted through the audit entry, which records the recipient masked as "u***@domain": the
  // DOMAIN survives masking, so the two addresses are told apart by using different ones.
  const shared = createClient(db, {
    companyName: "Shared Inbox Solar", ccbLicenseNumber: "444444",
    businessEmail: "owner@one-persons-mailbox.test", businessPhone: "5035550100",
  });
  // THROUGH THE NORMAL WRITE PATH, deliberately. The first version of this test set the column
  // with raw SQL, which is how it went unnoticed that `updates_inbox` is readable by the notifier
  // and writable by NOTHING: it is absent from ClientRecord, mapClient and FIELD_COLUMNS, so
  // createClient/updateClient silently drop it and the onboarding script cannot record the very
  // field its own intake template marks REQUIRED. A test that reaches around the API it is
  // testing proves the column exists, not that the feature works.
  updateClient(db, shared.id, { updatesInbox: "permits@shared-team.test" });
  assert.equal(getClient(db, shared.id)?.updatesInbox, "permits@shared-team.test",
    "the shared inbox did not survive a normal write — the API cannot record the address the guide asks every client for");
  const sp = createProject(db, { clientId: shared.id, owner: "Shared Owner", street: "2 Inbox St", city: "Bend", state: "OR", ahj: "Bend", utility: "PGE", dcKw: "5", acKw: "4" });
  await notifyClientOfStatusChange(db, sp.project, { outcome: "issued", statusLabel: "Permit Issued", targetType: "permit" });
  const audit = db.get<{ details?: string }>(
    "SELECT details FROM audit_logs WHERE project_id = ? AND action LIKE 'client.notif%' ORDER BY created_at DESC LIMIT 1",
    [sp.project.id],
  );
  assert.ok(audit, "the notifier recorded an audit entry");
  const details = String(audit!.details || "");
  assert.match(details, /shared-team\.test/, `the update went somewhere other than the shared inbox: ${details}`);
  assert.doesNotMatch(details, /one-persons-mailbox\.test/, `it went to the general business email the guide promises it would not: ${details}`);
});

await run("...and business_email is still the FALLBACK, because a misdirected update beats none", async () => {
  const noShared = createClient(db, {
    companyName: "No Shared Inbox LLC", ccbLicenseNumber: "555555",
    businessEmail: "ops@fallback-only.test", businessPhone: "5035550101",
  });
  const fp = createProject(db, { clientId: noShared.id, owner: "Fallback Owner", street: "3 Fallback St", city: "Bend", state: "OR", ahj: "Bend", utility: "PGE", dcKw: "5", acKw: "4" });
  await notifyClientOfStatusChange(db, fp.project, { outcome: "issued", statusLabel: "Permit Issued", targetType: "permit" });
  const audit = db.get<{ details?: string }>(
    "SELECT details FROM audit_logs WHERE project_id = ? AND action LIKE 'client.notif%' ORDER BY created_at DESC LIMIT 1",
    [fp.project.id],
  );
  assert.match(String(audit?.details || ""), /fallback-only\.test/, "a client with no shared inbox must still be told");
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

// The demo kit's .env said CLIENT_NOTIFICATIONS=off and the check only knew "0"/"false", so the
// kill switch it thought it had was not there.
await run("CLIENT_NOTIFICATIONS=off disables everything too", async () => {
  process.env.CLIENT_NOTIFICATIONS = "off";
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
