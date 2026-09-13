// THE DATE A FILING WENT IN IS NOT ALWAYS THE DATE SOMEBODY TYPED IT IN.
//
// markTrackSubmitted stamped submitted_at = now, unconditionally. That is right when an operator
// files in the portal and records it in the same sitting, and wrong every other time: file on
// Monday, get back to the dashboard on Wednesday, and the client's tracker says the jurisdiction
// received it Wednesday. The review clock a client is watching then starts two days late, and the
// number is one WE invented rather than one the portal gave us.
//
// So the real filing date can be stated, and defaults to now when it is not.
//
//   MUST ACCEPT  — an explicit filing date, and use it for the submission AND everything the
//                  client portal renders from it.
//   MUST DEFAULT — to now, because same-sitting is the common case and must stay one click.
//   MUST REFUSE  — a date in the future (nothing was filed tomorrow) and an unparseable one.
//                  Storing garbage here is worse than refusing: it reaches a client's page as a
//                  confident wrong fact, and the tracker's whole job is that date.
//
//   npx tsx backend/test/markSubmittedDate.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mark-submitted-date-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { markTrackSubmitted } = await import("../src/submittalTracks");
const { ensureClientPortalToken, clientPortalPayload } = await import("../src/clientPortal");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const client = createClient(db, { companyName: "Filing Date Solar", ccbLicenseNumber: "818181" });
const token = ensureClientPortalToken(db, client.id);
let n = 0;
const mk = () => createProject(db, {
  clientId: client.id, owner: `Owner ${++n}`, street: `${n} Filing St`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;

const trackFor = (projectId: string, app: string) => {
  const p = clientPortalPayload(db, token)!.projects.find((x) => x.id === projectId)!;
  return p.tracks.find((t) => t.applicationNumber === app)!;
};

check("MUST DEFAULT: no date given means now — the same-sitting case stays one click", () => {
  const p = mk();
  markTrackSubmitted(db, p, "electrical", { applicationNumber: "APP-TODAY" });
  const row = db.get<{ submitted_at: string }>(
    "SELECT submitted_at FROM submissions WHERE project_id = ? AND permit_type = 'electrical'", [p.id],
  )!;
  const age = Date.now() - new Date(row.submitted_at).getTime();
  assert.ok(age >= 0 && age < 60_000, `expected roughly now, got ${row.submitted_at}`);
});

check("THE HEADLINE: the real filing date is recorded when it is stated", () => {
  const p = mk();
  markTrackSubmitted(db, p, "building", {
    applicationNumber: "187-26-000999-STR", submittedAt: "2026-09-09",
  });
  const row = db.get<{ submitted_at: string }>(
    "SELECT submitted_at FROM submissions WHERE project_id = ? AND permit_type = 'building'", [p.id],
  )!;
  assert.equal(row.submitted_at.slice(0, 10), "2026-09-09",
    `the filing date the operator stated was not kept: ${row.submitted_at}`);
});

check("...and it is what the CLIENT sees, which is the point", () => {
  const p = mk();
  markTrackSubmitted(db, p, "building", {
    applicationNumber: "187-26-001000-STR", submittedAt: "2026-09-08T17:45:00.000Z",
  });
  const t = trackFor(p.id, "187-26-001000-STR");
  assert.equal(String(t.submittedAt).slice(0, 10), "2026-09-08",
    `the tracker shows a different day from the one recorded: ${t.submittedAt}`);
});

check("MUST REFUSE: nothing was filed tomorrow", () => {
  const p = mk();
  const tomorrow = new Date(Date.now() + 36 * 3600_000).toISOString();
  assert.throws(
    () => markTrackSubmitted(db, p, "electrical", { applicationNumber: "APP-FUTURE", submittedAt: tomorrow }),
    /future/i,
    "a future filing date was accepted",
  );
  const row = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM submissions WHERE project_id = ?", [p.id])!;
  assert.equal(Number(row.n), 0, "the refusal still wrote a submission row");
});

check("MUST REFUSE: an unparseable date, rather than storing the string", () => {
  // Silently storing "last tuesday" puts it straight on a client's page, where it is a confident
  // wrong fact about the one thing the tracker exists to report.
  const p = mk();
  for (const bad of ["last tuesday", "09/09/26ish", "not-a-date"]) {
    assert.throws(
      () => markTrackSubmitted(db, p, "electrical", { applicationNumber: "APP-BAD", submittedAt: bad }),
      /date/i,
      `"${bad}" was accepted as a filing date`,
    );
  }
});

check("a small clock skew is tolerated — 'now' from another machine is not the future", () => {
  // Refusing anything past this instant would reject a perfectly good "now" from a client whose
  // clock is a few seconds ahead, which is a support call for nothing.
  const p = mk();
  const slightlyAhead = new Date(Date.now() + 30_000).toISOString();
  markTrackSubmitted(db, p, "electrical", { applicationNumber: "APP-SKEW", submittedAt: slightlyAhead });
  const row = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM submissions WHERE project_id = ?", [p.id])!;
  assert.equal(Number(row.n), 1, "a few seconds of clock skew was treated as a future date");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nmarkSubmittedDate: all checks passed."
  : `\nmarkSubmittedDate: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
