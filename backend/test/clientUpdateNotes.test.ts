// THE SAME EVENT MUST NOT HAVE TWO DIFFERENT WORDINGS.
//
// The email wording lived inside clientNotifier. Adding a note to the client portal would have
// made a second copy of the same sentences, and two copies of client-facing prose drift — the
// client then reads one thing in their inbox and a different thing on the page, for the same
// event, on the same day. clientUpdates.ts is the single source; the notifier and the portal
// note both render it.
//
// WHAT MAKES IT READ LIKE A PM: every update answers "does this need anything from me", because
// a status label never does. "Correction requested" reads as an emergency; "we're reading it
// now, nothing for you to do yet" is the identical fact and a completely different Tuesday.
//
//   MUST MATCH   — the note on the page and the email body carry the same sentences.
//   MUST ANSWER  — every update says whether anything is needed from the client, including the
//                  times the answer is "nothing", and names the authority rather than "the AHJ".
//   MUST EXCLUDE — correction TEXT never appears; an internal note (pm_note, blocker) NEVER
//                  reaches the portal; a non-notifiable outcome writes no note at all.
//
//   npx tsx backend/test/clientUpdateNotes.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-update-notes-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, addProjectNote } = await import("../src/repository");
const { notifyClientOfStatusChange } = await import("../src/clientNotifier");
const { clientUpdateFor, clientUpdateNoteBody } = await import("../src/clientUpdates");
const { ensureClientPortalToken, clientPortalPayload } = await import("../src/clientPortal");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

const client = createClient(db, { companyName: "Voice Solar", ccbLicenseNumber: "121212", businessEmail: "ops@voice.test" });
const { project } = createProject(db, {
  clientId: client.id, owner: "Note Owner", street: "3 Note St", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
});
const token = ensureClientPortalToken(db, client.id);

// ── the voice ────────────────────────────────────────────────────────────────────────────
await check("THE POINT: every update says whether anything is needed from the client", () => {
  for (const outcome of ["issued", "ready_for_issue", "nem_approved", "correction_flagged"]) {
    const u = clientUpdateFor(db, project, outcome, { targetType: "permit" })!;
    assert.ok(u, `no wording for ${outcome}`);
    assert.ok(u.action.trim().length > 0, `${outcome} has no action line — that is the line that makes it a note`);
    assert.match(u.action, /nothing|you|your/i, `${outcome}'s action line does not address the reader: ${u.action}`);
  }
});

await check("a correction says it is routine and asks for nothing yet — not an emergency", () => {
  // The single most useful sentence we send. A correction notice with no instruction reads as a
  // disaster to somebody who has a crew booked.
  const u = clientUpdateFor(db, project, "correction_flagged", { targetType: "permit" })!;
  assert.match(u.meaning, /not a rejection|routine/i, u.meaning);
  assert.match(u.action, /nothing for you to do yet/i, u.action);
});

await check("it names the actual authority, not 'the jurisdiction'", () => {
  const u = clientUpdateFor(db, project, "issued", { targetType: "permit", permitNumber: "194-26-001471-ELEC" })!;
  assert.match(u.headline, /City of Coos Bay/, u.headline);
  assert.match(u.headline, /194-26-001471-ELEC/, "the reference is what lets them look it up themselves");
});

await check("it does not imply the whole job is done when the other track is still open", () => {
  // "Installation can be scheduled" next to an un-approved interconnection is how a client ends
  // up with panels on a roof they cannot switch on.
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, target_type, active, latest_outcome, created_at, updated_at)
     VALUES ('t-nem', ?, 'nem', 1, 'waiting', ?, ?)`,
    [project.id, new Date().toISOString(), new Date().toISOString()],
  );
  const u = clientUpdateFor(db, project, "issued", { targetType: "permit" })!;
  assert.match(u.action, /Pacific Power/, `it should name what is still outstanding: ${u.action}`);
  assert.match(u.action, /still in review/i, u.action);
});

await check("...and stops saying so once the other track is through", () => {
  db.run("UPDATE permit_check_targets SET latest_outcome = 'nem_approved' WHERE id = 't-nem'");
  const u = clientUpdateFor(db, project, "issued", { targetType: "permit" })!;
  assert.doesNotMatch(u.action, /still in review/i, `it is still reporting an outstanding track that closed: ${u.action}`);
});

await check("A PERMIT IS NOT PERMISSION TO ENERGISE: no 'schedule the install' while NEM is open", () => {
  // The operator caught this reading the real email: the action line named the outstanding
  // Pacific Power interconnection while the line above it said the installation could be
  // scheduled. Both in one paragraph, contradicting each other.
  db.run("UPDATE permit_check_targets SET latest_outcome = 'waiting' WHERE id = 't-nem'");
  const open = clientUpdateFor(db, project, "issued", { targetType: "permit" })!;
  assert.doesNotMatch(open.meaning, /installation can be scheduled/i,
    `claimed the install can be scheduled with the interconnection still open: ${open.meaning}`);
  assert.match(open.action, /still in review/i, "and it must still say what is outstanding");

  // With BOTH tracks through, the claim is true and should be made.
  db.run("UPDATE permit_check_targets SET latest_outcome = 'nem_approved' WHERE id = 't-nem'");
  const done = clientUpdateFor(db, project, "issued", { targetType: "permit" })!;
  assert.match(done.meaning, /installation can be scheduled/i,
    `the claim was dropped even with everything cleared: ${done.meaning}`);
});

await check("MUST EXCLUDE: an outcome a client is not told about produces no wording at all", () => {
  for (const internal of ["qc_failed", "waiting", "needs_human_review", "blocked", ""]) {
    assert.equal(clientUpdateFor(db, project, internal, { targetType: "permit" }), null,
      `internal state "${internal}" produced client-facing text`);
  }
});

// ── one voice across both channels ───────────────────────────────────────────────────────
await check("THE HEADLINE: the portal note and the email carry the SAME sentences", async () => {
  await notifyClientOfStatusChange(db, project, {
    outcome: "correction_flagged", statusLabel: "Correction Requested", targetType: "permit",
  });
  const comm = db.get<{ body?: string }>(
    "SELECT body FROM communications WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [project.id],
  );
  const note = db.get<{ body?: string; note_type?: string }>(
    "SELECT body, note_type FROM project_notes WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [project.id],
  );
  assert.ok(note, "no client note was written for a notifiable status change");
  assert.equal(note!.note_type, "client_update", `wrong note type: ${note!.note_type}`);
  const u = clientUpdateFor(db, project, "correction_flagged", { targetType: "permit" })!;
  assert.equal(note!.body, clientUpdateNoteBody(u), "the note is not rendered from the shared wording");
  for (const sentence of [u.headline, u.meaning, u.action]) {
    assert.ok(String(comm?.body || "").includes(sentence),
      `the email is missing a sentence the note shows:\n  ${sentence}\n  email: ${String(comm?.body || "").slice(0, 300)}`);
  }
});

await check("the note reaches the client's portal", () => {
  const p = clientPortalPayload(db, token)!.projects.find((x) => x.id === project.id)!;
  assert.ok(Array.isArray(p.updates), "the portal payload carries no updates array");
  assert.equal(p.updates.length, 1, JSON.stringify(p.updates));
  assert.match(p.updates[0].body, /sent the application back/i, p.updates[0].body);
  assert.ok(p.updates[0].at, "an update with no date is not a note");
});

// ── through the REAL trigger, not the helper ─────────────────────────────────────────────
//
// Every check above calls notifyClientOfStatusChange directly, which is why none of them caught
// this: the ONE production trigger, recordPermitStatusCheck, passed only outcome/statusLabel/
// targetType. permitNumber and applicationNumber are optional on the signature, so omitting them
// typechecked in silence and the live note read "has issued the permit." with nothing the client
// could quote back to the AHJ — while a hand-written demo produced the reference perfectly.
//
// Testing through the trigger is the difference between "the wording function can render a
// reference" and "the client actually receives one".
await check("THE REFERENCE SURVIVES THE REAL TRIGGER, not just the helper", async () => {
  const { createProject: mkProject } = await import("../src/repository");
  const { recordPermitStatusCheck } = await import("../src/repository");
  const { project: p2 } = mkProject(db, {
    clientId: client.id, owner: "Trigger Owner", street: "7 Trigger St", city: "Coos Bay",
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
  });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, active, latest_outcome, permit_number, application_number, created_at, updated_at)
     VALUES ('t-trig', ?, 'permit', 'electrical', 1, 'waiting', '194-26-001471-ELEC', 'APP-99', ?, ?)`,
    [p2.id, now, now],
  );
  await recordPermitStatusCheck(db, p2.id, {
    targetId: "t-trig", source: "manual", rawStatusText: "Permit issued",
  });
  // The notify call is fire-and-forget `void`, so let the microtask queue drain.
  await new Promise((r) => setTimeout(r, 60));
  const note = db.get<{ body?: string }>(
    "SELECT body FROM project_notes WHERE project_id = ? AND note_type = 'client_update' ORDER BY created_at DESC LIMIT 1",
    [p2.id],
  );
  assert.ok(note, "the real trigger wrote no client note at all");
  assert.match(String(note!.body), /194-26-001471-ELEC/,
    `the jurisdiction's own reference never reached the client: ${note!.body}`);
  // WHICH permit, not just "the permit". A project files a structural AND an electrical permit;
  // "has issued the permit" with two outstanding leaves the client guessing which crew to book.
  assert.match(String(note!.body), /issued the electrical permit/,
    `the note does not say which of the two permits landed: ${note!.body}`);
});

await check("MUST NOT GUESS the trade: an unknown discipline says 'the permit'", () => {
  // Naming the wrong trade is worse than naming none — it tells somebody to schedule the wrong
  // crew. A blank permit_type must stay general.
  const u = clientUpdateFor(db, project, "issued", { targetType: "permit", permitType: "" })!;
  assert.match(u.headline, /has issued the permit/, u.headline);
  assert.doesNotMatch(u.headline, /electrical|building/i,
    `a trade was asserted with no discipline on file: ${u.headline}`);
});

await check("THE PAGE DOES NOT DIE WITH THE EMAIL: no address still writes the note", async () => {
  // notifyClientOfStatusChange returns silently when the client has neither an updates inbox nor
  // a business email — the trap INTAKE_CHECKLIST.md documents. The note write originally sat
  // BELOW that return, so a blank address took the portal down with the mail, which is exactly
  // the "both channels go dark together" the ordering is supposed to prevent. The page needs no
  // mail server, no base URL and no correct address; it must not inherit their failures.
  const noAddress = createClient(db, { companyName: "No Address Solar", ccbLicenseNumber: "343434" });
  const { project: p3 } = createProject(db, {
    clientId: noAddress.id, owner: "Unreachable Owner", street: "8 Silent Row", city: "Coos Bay",
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
  });
  db.run("UPDATE clients SET business_email = '', updates_inbox = '' WHERE id = ?", [noAddress.id]);
  await notifyClientOfStatusChange(db, p3, { outcome: "issued", statusLabel: "Permit Issued", targetType: "permit" });

  const note = db.get<{ body?: string }>(
    "SELECT body FROM project_notes WHERE project_id = ? AND note_type = 'client_update' LIMIT 1", [p3.id],
  );
  assert.ok(note, "no address meant no note — the portal went dark with the mail");
  const comm = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM communications WHERE project_id = ?", [p3.id])!;
  assert.equal(Number(comm.n), 0, "there is no address, so there should be no email row either");
});

// ── the leak that would matter most ──────────────────────────────────────────────────────
await check("MUST EXCLUDE: an INTERNAL note never reaches the portal", () => {
  // project_notes holds pm_note, blocker, handoff and system_note alongside client_update. Those
  // are where an operator writes "client is chasing this, don't tell them about the fee yet".
  // Surfacing the table instead of the one type would publish the lot.
  addProjectNote(db, project.id, {
    noteType: "pm_note", body: "INTERNAL: client is chasing, do not mention the re-inspection fee yet", createdBy: "ops",
  });
  addProjectNote(db, project.id, {
    noteType: "blocker", body: "INTERNAL: examiner is on holiday until the 20th", createdBy: "ops",
  });
  const blob = JSON.stringify(clientPortalPayload(db, token));
  assert.ok(!blob.includes("INTERNAL"), "an internal note reached the client portal");
  assert.ok(!blob.includes("re-inspection fee"), "an internal note reached the client portal");
  assert.ok(!blob.includes("on holiday"), "an internal note reached the client portal");
  const p = clientPortalPayload(db, token)!.projects.find((x) => x.id === project.id)!;
  assert.equal(p.updates.length, 1, "the internal notes were counted as client updates");
});

await check("MUST EXCLUDE: no note is written for a status the client is not told about", () => {
  const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_notes WHERE project_id = ? AND note_type = 'client_update'", [project.id])!.n;
  return notifyClientOfStatusChange(db, project, { outcome: "waiting", statusLabel: "In review", targetType: "permit" })
    .then(() => {
      const after = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_notes WHERE project_id = ? AND note_type = 'client_update'", [project.id])!.n;
      assert.equal(after, before, "an internal status change wrote a client-facing note");
    });
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nclientUpdateNotes: all checks passed."
  : `\nclientUpdateNotes: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
