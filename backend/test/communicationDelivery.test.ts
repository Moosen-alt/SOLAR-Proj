// A MESSAGE THAT WAS NEVER SENT LOOKED EXACTLY LIKE ONE THAT WAS.
//
// Found on the live database on 2026-09-13. Three real client emails, written by the bot when it
// saw the portals move, sitting undelivered since 2026-09-01:
//
//   [draft — SMTP not configured or send failed] Permit issued — 773 Kentuck…
//   [draft — SMTP not configured or send failed] Correction requested — 773 …
//   [draft — SMTP not configured or send failed] Permit issued — 1780 Ocean …
//
// Twelve days, one of them a CORRECTION REQUEST, nobody told. The detection worked, the wording
// worked, the status link worked. Delivery was off and there was no number anywhere that said so.
//
// The reason it stayed invisible is in the subject line above: delivery state was a STRING PREFIX
// on `subject`. `communications` had no status column, so "what did we fail to send?" was not a
// query anyone could write — the rows had to be read one at a time. And the one prefix covers two
// different situations, "SMTP is not configured" and "the send threw", which need opposite fixes.
//
//   MUST RECORD   — status, reason and recipient as COLUMNS; a clean subject; unconfigured SMTP
//                   distinguished from a failed send.
//   MUST BACKFILL — the three rows above are real and must become queryable, prefix stripped,
//                   without inventing a status for rows that never had one.
//   MUST COUNT    — undeliveredCommunications() answers the question in one call, and counts only
//                   things that were meant to leave the building.
//
//   npx tsx backend/test/communicationDelivery.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comm-delivery-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.SMTP_HOST;        // force the draft path — no network in tests
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient, updateClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { notifyClientOfStatusChange } = await import("../src/clientNotifier");
const { undeliveredCommunications } = await import("../src/crm");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const client = createClient(db, {
  companyName: "Undelivered Solar", ccbLicenseNumber: "777777",
  businessEmail: "ops@undelivered.test", businessPhone: "5035550199",
});
updateClient(db, client.id, { updatesInbox: "permits@undelivered.test" });
const { project } = createProject(db, {
  clientId: client.id, owner: "Silent Owner", street: "9 Quiet Ln", city: "Bend",
  state: "OR", ahj: "Bend", utility: "PGE", dcKw: "5", acKw: "4",
});

await notifyClientOfStatusChange(db, project, {
  outcome: "correction_flagged", statusLabel: "Correction Requested", targetType: "permit",
});

const row = db.get<Record<string, unknown>>(
  "SELECT * FROM communications WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [project.id],
)!;

check("THE HEADLINE: an undelivered message says so in a COLUMN, not in its subject text", () => {
  assert.ok(row, "the notifier recorded nothing at all");
  assert.equal(row.delivery_status, "draft", `delivery_status was ${JSON.stringify(row.delivery_status)}`);
});

check("UNCONFIGURED is distinguished from FAILED — they need opposite fixes", () => {
  // "set SMTP_HOST" and "the mail server rejected us" were the same string before. One is a
  // deployment step that has never been done; the other is an incident.
  assert.match(String(row.delivery_detail), /not configured/i,
    `the reason must say which of the two this is: ${JSON.stringify(row.delivery_detail)}`);
});

check("the recipient is recorded, so you can see WHO was not told", () => {
  assert.equal(row.recipient, "permits@undelivered.test",
    "without this, an undelivered row cannot be re-sent or chased without re-deriving the address");
});

check("the SUBJECT is clean — the prefix is gone, because state is not prose", () => {
  assert.doesNotMatch(String(row.subject), /^\[/,
    `delivery state is still being smuggled into the subject: ${JSON.stringify(row.subject)}`);
  assert.match(String(row.subject), /^Correction requested — /,
    `the subject must be what we would actually send: ${JSON.stringify(row.subject)}`);
});

check("MUST COUNT: the question 'what did we fail to send?' is now one call", () => {
  const undelivered = undeliveredCommunications(db);
  assert.equal(undelivered.length, 1, JSON.stringify(undelivered));
  assert.equal(undelivered[0].projectId, project.id);
  assert.equal(undelivered[0].recipient, "permits@undelivered.test");
  assert.match(undelivered[0].subject, /Correction requested/);
});

check("MUST EXCLUDE: an operator's own note is not an undelivered email", () => {
  // communications also holds notes, calls and inbound mail. Counting those as delivery failures
  // makes the number useless, which is the same as not having it.
  db.run(
    `INSERT INTO communications (id, project_id, direction, channel, subject, body, logged_by, occurred_at, created_at, org_id)
     VALUES ('note-1', ?, 'outbound', 'note', 'Rang the plans examiner', 'Left a message', 'ops', ?, ?, 'org-default')`,
    [project.id, new Date().toISOString(), new Date().toISOString()],
  );
  db.run(
    `INSERT INTO communications (id, project_id, direction, channel, subject, body, logged_by, occurred_at, created_at, org_id)
     VALUES ('in-1', ?, 'inbound', 'email', 'AHJ replied', 'See attached', 'email-poller', ?, ?, 'org-default')`,
    [project.id, new Date().toISOString(), new Date().toISOString()],
  );
  assert.equal(undeliveredCommunications(db).length, 1,
    "a note or an inbound message was counted as something we failed to send");
});

// ── the three real rows ──────────────────────────────────────────────────────────────────
//
// Shaped exactly as they sit in the live database: the prefix in the subject, nothing else.
const legacy = [
  ["legacy-draft", "[draft — SMTP not configured or send failed] Permit issued — 773 Kentuck Way"],
  ["legacy-sent", "[sent] Permit issued — 1780 Ocean Blvd"],
  ["legacy-bare", "Permit issued — a row from before either prefix existed"],
];
for (const [rid, subject] of legacy) {
  db.run(
    `INSERT INTO communications (id, project_id, direction, channel, subject, body, logged_by, occurred_at, created_at, org_id)
     VALUES (?, ?, 'outbound', 'email', ?, 'body', 'client-notifier (automated)', ?, ?, 'org-default')`,
    [rid, project.id, subject, "2026-09-01T20:30:16.175Z", "2026-09-01T20:30:16.175Z"],
  );
}
db.run("UPDATE communications SET delivery_status = '', delivery_detail = '', recipient = '' WHERE id LIKE 'legacy-%'");

db.run("DELETE FROM schema_meta WHERE version >= 25");
const db2 = await openDatabase();

check("BACKFILL: the stranded draft becomes queryable, and keeps its wording", () => {
  const r = db2.get<Record<string, unknown>>("SELECT * FROM communications WHERE id = 'legacy-draft'")!;
  assert.equal(r.delivery_status, "draft", "the real undelivered rows must be findable after this migration");
  assert.equal(r.subject, "Permit issued — 773 Kentuck Way", `the prefix was not stripped: ${JSON.stringify(r.subject)}`);
});

check("BACKFILL: a delivered row is marked sent, not lumped in with the failures", () => {
  const r = db2.get<Record<string, unknown>>("SELECT * FROM communications WHERE id = 'legacy-sent'")!;
  assert.equal(r.delivery_status, "sent");
  assert.equal(r.subject, "Permit issued — 1780 Ocean Blvd");
});

check("MUST NOT INVENT: a row that never carried a prefix is left UNKNOWN, not guessed 'sent'", () => {
  // Guessing here would be the same class of error as the bug: a confident claim about delivery
  // that nothing checked. An unknown row is excluded from the undelivered count rather than
  // silently counted either way.
  const r = db2.get<Record<string, unknown>>("SELECT * FROM communications WHERE id = 'legacy-bare'")!;
  assert.equal(r.delivery_status, "", `a status was invented for a row that never had one: ${JSON.stringify(r.delivery_status)}`);
  assert.ok(!undeliveredCommunications(db2).some((c) => c.id === "legacy-bare"),
    "an unknown-delivery row must not be reported as a known failure");
});

check("...and the backfilled draft IS in the count, which is the whole point", () => {
  const ids = undeliveredCommunications(db2).map((c) => c.id);
  assert.ok(ids.includes("legacy-draft"), `the stranded message is still invisible: ${JSON.stringify(ids)}`);
});

check("v25 is recorded, so this is a migration and not a startup chore", () => {
  assert.equal(db2.get<{ name: string }>("SELECT name FROM schema_meta WHERE version = 25")?.name,
    "communications_delivery_state");
});

db2.close();
try { db.close(); } catch { /* already closed by the replay */ }
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\ncommunicationDelivery: all checks passed."
  : `\ncommunicationDelivery: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
