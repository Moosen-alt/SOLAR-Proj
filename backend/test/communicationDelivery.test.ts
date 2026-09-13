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
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

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

await check("THE HEADLINE: an undelivered message says so in a COLUMN, not in its subject text", () => {
  assert.ok(row, "the notifier recorded nothing at all");
  assert.equal(row.delivery_status, "draft", `delivery_status was ${JSON.stringify(row.delivery_status)}`);
});

await check("UNCONFIGURED is distinguished from FAILED — they need opposite fixes", () => {
  // "set SMTP_HOST" and "the mail server rejected us" were the same string before. One is a
  // deployment step that has never been done; the other is an incident.
  assert.match(String(row.delivery_detail), /not configured/i,
    `the reason must say which of the two this is: ${JSON.stringify(row.delivery_detail)}`);
});

await check("the recipient is recorded, so you can see WHO was not told", () => {
  assert.equal(row.recipient, "permits@undelivered.test",
    "without this, an undelivered row cannot be re-sent or chased without re-deriving the address");
});

await check("the SUBJECT is clean — the prefix is gone, because state is not prose", () => {
  assert.doesNotMatch(String(row.subject), /^\[/,
    `delivery state is still being smuggled into the subject: ${JSON.stringify(row.subject)}`);
  assert.match(String(row.subject), /^Correction requested — /,
    `the subject must be what we would actually send: ${JSON.stringify(row.subject)}`);
});

await check("MUST COUNT: the question 'what did we fail to send?' is now one call", () => {
  const undelivered = undeliveredCommunications(db);
  assert.equal(undelivered.length, 1, JSON.stringify(undelivered));
  assert.equal(undelivered[0].projectId, project.id);
  assert.equal(undelivered[0].recipient, "permits@undelivered.test");
  assert.match(undelivered[0].subject, /Correction requested/);
});

await check("MUST EXCLUDE: an operator's own note is not an undelivered email", () => {
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
// The body shape as it really sits on the live database — note the status link, frozen as
// literal text with the localhost base it was drafted under. Setting PUBLIC_BASE_URL later does
// not rewrite stored prose, which is the whole point of the re-send check below.
const LEGACY_BODY = [
  "Hi TML INTERNATIONAL LLC,",
  "",
  "Update on your solar project at 773 Kentuck Way:",
  "",
  "City of Coos Bay has issued the permit.",
  "",
  "Live status page (no login needed): http://localhost:4173/status?token=frozen-at-draft-time",
  "",
  "— Solar Submission Autopilot (automated update; reply to reach the team)",
].join("\n");
for (const [rid, subject] of legacy) {
  db.run(
    `INSERT INTO communications (id, project_id, direction, channel, subject, body, logged_by, occurred_at, created_at, org_id)
     VALUES (?, ?, 'outbound', 'email', ?, ?, 'client-notifier (automated)', ?, ?, 'org-default')`,
    [rid, project.id, subject, LEGACY_BODY, "2026-09-01T20:30:16.175Z", "2026-09-01T20:30:16.175Z"],
  );
}
db.run("UPDATE communications SET delivery_status = '', delivery_detail = '', recipient = '' WHERE id LIKE 'legacy-%'");

db.run("DELETE FROM schema_meta WHERE version >= 25");
const db2 = await openDatabase();

await check("BACKFILL: the stranded draft becomes queryable, and keeps its wording", () => {
  const r = db2.get<Record<string, unknown>>("SELECT * FROM communications WHERE id = 'legacy-draft'")!;
  assert.equal(r.delivery_status, "draft", "the real undelivered rows must be findable after this migration");
  assert.equal(r.subject, "Permit issued — 773 Kentuck Way", `the prefix was not stripped: ${JSON.stringify(r.subject)}`);
});

await check("BACKFILL: a delivered row is marked sent, not lumped in with the failures", () => {
  const r = db2.get<Record<string, unknown>>("SELECT * FROM communications WHERE id = 'legacy-sent'")!;
  assert.equal(r.delivery_status, "sent");
  assert.equal(r.subject, "Permit issued — 1780 Ocean Blvd");
});

await check("MUST NOT INVENT: a row that never carried a prefix is left UNKNOWN, not guessed 'sent'", () => {
  // Guessing here would be the same class of error as the bug: a confident claim about delivery
  // that nothing checked. An unknown row is excluded from the undelivered count rather than
  // silently counted either way.
  const r = db2.get<Record<string, unknown>>("SELECT * FROM communications WHERE id = 'legacy-bare'")!;
  assert.equal(r.delivery_status, "", `a status was invented for a row that never had one: ${JSON.stringify(r.delivery_status)}`);
  assert.ok(!undeliveredCommunications(db2).some((c) => c.id === "legacy-bare"),
    "an unknown-delivery row must not be reported as a known failure");
});

await check("...and the backfilled draft IS in the count, which is the whole point", () => {
  const ids = undeliveredCommunications(db2).map((c) => c.id);
  assert.ok(ids.includes("legacy-draft"), `the stranded message is still invisible: ${JSON.stringify(ids)}`);
});

await check("v25 is recorded, so this is a migration and not a startup chore", () => {
  assert.equal(db2.get<{ name: string }>("SELECT name FROM schema_meta WHERE version = 25")?.name,
    "communications_delivery_state");
});

// ── re-sending the backlog ───────────────────────────────────────────────────────────────
//
// THE LINK IS FROZEN INTO THE PROSE. Every stranded message was drafted while PUBLIC_BASE_URL
// was unset, so its body literally contains "http://localhost:4173/status?token=...". Setting
// the env var later does not rewrite stored text. Re-sending the backlog would therefore deliver
// a dead link to a real client and then mark the row `sent` — the exact failure
// scripts/undelivered.ts refuses to risk, arriving through a different door. All three rows on
// the live database were in this state.
await check("MUST REWRITE: a re-sent message does not carry the localhost link it was drafted with", async () => {
  const stale = db2.get<Record<string, unknown>>("SELECT * FROM communications WHERE id = 'legacy-draft'")!;
  assert.match(String(stale.body), /localhost/, "fixture is wrong — the body should start out with a dead link");

  process.env.PUBLIC_BASE_URL = "https://track.example.test";
  const { resendCommunication } = await import("../src/clientNotifier");
  // No SMTP configured, so the send throws and the row goes to `failed` — which is fine here:
  // what is under test is the BODY that would have gone out, and it is persisted either way.
  await resendCommunication(db2, {
    id: "legacy-draft", projectId: project.id, recipient: "ops@undelivered.test",
    subject: String(stale.subject), body: String(stale.body),
  });
  const after = db2.get<Record<string, unknown>>("SELECT body FROM communications WHERE id = 'legacy-draft'")!;
  delete process.env.PUBLIC_BASE_URL;
  assert.doesNotMatch(String(after.body), /localhost/,
    `a client would have received a dead link: ${String(after.body)}`);
  assert.match(String(after.body), /https:\/\/track\.example\.test\/status\?token=/,
    `the rebuilt link is missing: ${String(after.body)}`);
});

db2.close();
try { db.close(); } catch { /* already closed by the replay */ }
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\ncommunicationDelivery: all checks passed."
  : `\ncommunicationDelivery: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
