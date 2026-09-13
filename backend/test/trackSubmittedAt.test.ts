// "WHEN WAS THIS ACTUALLY FILED?" IS THE QUESTION A TRACKER EXISTS TO ANSWER.
//
// The client portal showed each track's application number and when WE last checked it, but never
// when the filing itself went in. "Last checked Sep 13" tells a client what our scheduler did, not
// what happened to their permit — and the date they actually need is the one the review clock
// runs from.
//
// FULLY SUBMITTED IS A NARROW WORD HERE, and it is the whole safety property. Automation never
// presses final submit (CLAUDE.md rule 1): a staged application sits at `awaiting_human_submit`
// with its fields filled and nothing filed. On the live database, 11739 SE Reedway St and four
// others are in exactly that state. A page that showed a date for those would tell a client their
// permit is with the city when it is sitting in our review window, and the review clock they think
// is running is not.
//
//   MUST SHOW    — the date of the real filing, from a submission whose status is `submitted`,
//                  and the tracking number the jurisdiction issued.
//   MUST NOT     — show a date for a staged-but-unfiled track, no matter how complete it is.
//   MUST NOT     — drift later on re-submission. Duplicate submission rows exist for one filing
//                  (the live database has two or three per application); the EARLIEST submitted_at
//                  is when it went in.
//   MUST NOT     — read another project's submission. Application numbers are unique within a
//                  jurisdiction, not globally — the same trap as migration v28.
//
//   npx tsx backend/test/trackSubmittedAt.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "track-submitted-at-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { ensureClientPortalToken, clientPortalPayload } = await import("../src/clientPortal");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const client = createClient(db, { companyName: "Filed Solar", ccbLicenseNumber: "717171" });
const { project } = createProject(db, {
  clientId: client.id, owner: "Filed Owner", street: "1 Filed St", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
});
const other = createClient(db, { companyName: "Other Filed Solar", ccbLicenseNumber: "727272" });
const { project: elsewhere } = createProject(db, {
  clientId: other.id, owner: "Other Owner", street: "2 Elsewhere Rd", city: "Salem",
  state: "OR", ahj: "City of Salem", utility: "PGE", dcKw: "8", acKw: "6.4",
});
const token = ensureClientPortalToken(db, client.id);
const now = new Date().toISOString();

const target = (id: string, app: string, permitType: string, projectId = project.id) => db.run(
  `INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, active, latest_outcome, application_number, permit_number, created_at, updated_at)
   VALUES (?, ?, ?, ?, 1, 'waiting', ?, '', ?, ?)`,
  [id, projectId, permitType === "nem" ? "nem" : "permit", permitType, app, now, now],
);
const submission = (id: string, app: string, permitType: string, status: string, submittedAt: string | null, conf = "", projectId = project.id) => db.run(
  `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, application_number, confirmation_number, submitted_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, projectId, permitType === "nem" ? "interconnection" : "permit", permitType, status, app, conf, submittedAt, now],
);

// FILED — and recorded twice, the way the live database records one filing.
target("t-ele", "194-26-001471-ELEC", "electrical");
submission("s-ele-1", "194-26-001471-ELEC", "electrical", "submitted", "2026-09-01T20:30:01.147Z");
submission("s-ele-2", "194-26-001471-ELEC", "electrical", "submitted", "2026-09-04T11:00:00.000Z");

// STAGED BUT NOT FILED — fields complete, nothing submitted. The state automation stops at.
//
// BOTH ROWS CARRY A TIMESTAMP ON PURPOSE. A staged row can hold submitted_at (it is stamped when
// a run reaches the review window), and a FAILED attempt certainly does. Measured: with these
// rows nulled, `submitted_at IS NOT NULL` alone excluded them and the status filter proved
// nothing — the check passed with the filter deleted.
target("t-str", "187-26-000305-STR", "building");
submission("s-str", "187-26-000305-STR", "building", "awaiting_human_submit", "2026-09-05T09:00:00.000Z");
submission("s-str-failed", "187-26-000305-STR", "building", "failed", "2026-09-06T09:00:00.000Z");

// NEM, whose confirmation number is the same string as the application number.
target("t-nem", "APP-111651", "nem");
submission("s-nem", "APP-111651", "nem", "submitted", "2026-09-02T03:14:56.122Z", "APP-111651");

// THE TRAP: the SAME CLIENT's other project holding the same application number, filed on a
// different day. It has to be the same client — a different client's rows never enter the query,
// which is why the first version of this check passed with the scoping removed and proved
// nothing. Two of one company's jobs in one jurisdiction is the realistic collision.
const { project: sibling } = createProject(db, {
  clientId: client.id, owner: "Sibling Owner", street: "3 Sibling Way", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
});
target("t-sib", "194-26-001471-ELEC", "electrical", sibling.id);
submission("s-sib", "194-26-001471-ELEC", "electrical", "submitted", "2026-01-01T00:00:00.000Z", "", sibling.id);

const tracks = () => {
  const p = clientPortalPayload(db, token)!.projects.find((x) => x.id === project.id)!;
  return Object.fromEntries(p.tracks.map((t) => [t.applicationNumber, t]));
};

check("THE HEADLINE: a filed track says when it actually went in", () => {
  const t = tracks()["194-26-001471-ELEC"];
  assert.ok(t, "the electrical track is missing from the payload");
  assert.equal(String(t.submittedAt).slice(0, 10), "2026-09-01",
    `this is the date the jurisdiction's review clock runs from: ${t.submittedAt}`);
});

check("MUST NOT DRIFT: duplicate rows for one filing keep the EARLIEST date", () => {
  // The live database holds two or three submission rows per application. Taking the latest would
  // move a client's filing date forward every time anything re-recorded it.
  const t = tracks()["194-26-001471-ELEC"];
  assert.doesNotMatch(String(t.submittedAt), /2026-09-04/, "a later duplicate overwrote the real filing date");
});

check("THE SAFETY PROPERTY: a STAGED but unfiled track shows no date at all", () => {
  // Automation never presses final submit. A complete, staged application is not a filing, and a
  // date here would tell a client the city has it when we do — with a review clock they think is
  // running and is not.
  const t = tracks()["187-26-000305-STR"];
  assert.ok(t, "the staged track is missing from the payload");
  assert.equal(t.submittedAt, null,
    `a staged-but-unfiled track claimed a submission date: ${t.submittedAt}`);
});

check("MUST NOT: a sibling project's filing date does not leak in on a shared number", () => {
  // BOTH SIDES ARE ASSERTED. Keyed on the application number alone, the two projects collide and
  // whichever row the database returns last wins — so checking only one of them passes or fails
  // by row order, which is a coin toss dressed as a test. Checking both means the collision is
  // caught whichever way it resolves.
  const payload = clientPortalPayload(db, token)!;
  const mine = payload.projects.find((x) => x.id === project.id)!
    .tracks.find((t) => t.applicationNumber === "194-26-001471-ELEC")!;
  const theirs = payload.projects.find((x) => x.id === sibling.id)!
    .tracks.find((t) => t.applicationNumber === "194-26-001471-ELEC")!;
  assert.equal(String(mine.submittedAt).slice(0, 10), "2026-09-01",
    `this project took the sibling's filing date: ${mine.submittedAt}`);
  assert.equal(String(theirs.submittedAt).slice(0, 10), "2026-01-01",
    `the sibling took this project's filing date: ${theirs.submittedAt}`);
});

check("the tracking number is carried, and a duplicate confirmation is not repeated", () => {
  // PowerClerk's confirmation number IS the application number. Printing both would be two
  // identical strings on one line, which reads as a page that does not know what it is showing.
  const nem = tracks()["APP-111651"];
  assert.equal(nem.applicationNumber, "APP-111651");
  assert.equal(nem.confirmationNumber, "", "a confirmation identical to the application number is noise");
});

check("...but a confirmation that DIFFERS is shown, because then it is a second fact", () => {
  db.run("UPDATE submissions SET confirmation_number = 'RCPT-8891' WHERE id = 's-nem'");
  assert.equal(tracks()["APP-111651"].confirmationNumber, "RCPT-8891");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\ntrackSubmittedAt: all checks passed."
  : `\ntrackSubmittedAt: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
