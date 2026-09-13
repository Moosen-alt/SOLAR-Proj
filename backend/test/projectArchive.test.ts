// THE CLIENT'S VIEW AND THE WORKSHOP FLOOR ARE NOT THE SAME LIST.
//
// The first render of the per-client portal against the live database showed TML fifteen cards
// for about eight real jobs:
//
//   1075 Flanagan Ave      x4   four passes at one job, Aug 25-30
//   990 17th St NE         x3   two passes plus an Illinois test fixture
//   15622 SE Vivian Way    x2
//   800 E Monroe St        x1   owner "Test Testerson"
//
// Deleting them was the obvious move and the wrong one. portal-bot/src/demoReplay.ts reads the
// LIVE database and names il-test-ameren, 8f4ca8dd and b0ab5169 directly, so a delete breaks the
// demo. HANDOFF.md cites 29cd57b5 and 8f4ca8dd as certified staging runs, and the superseded
// passes carry real submission history. And il-test-comed's Salem address under an Evanston/ComEd
// identity is not a typo — it is the preserved evidence of the snapshot-identity bug that once
// pointed an Illinois project at PGE's real portal.
//
// So: ARCHIVE, not delete. The row stays, the history stays, the demo keeps working, and the
// client stops seeing our workshop. Reversible by design — an archive you cannot undo is a
// delete with extra steps.
//
//   MUST HIDE    — archived projects vanish from the client portal.
//   MUST KEEP    — the row, its submissions and its documents are all still there afterwards.
//   MUST REVERSE — unarchiving puts it back.
//   MUST NOT     — hide anything by accident: a project with no archived_at is visible, and
//                  archiving one client's project does not touch another's.
//
//   npx tsx backend/test/projectArchive.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-archive-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { ensureClientPortalToken, clientPortalPayload } = await import("../src/clientPortal");
const { archiveProject, unarchiveProject } = await import("../src/projectArchive");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const client = createClient(db, { companyName: "Archive Solar", ccbLicenseNumber: "888999" });
const other = createClient(db, { companyName: "Other Solar", ccbLicenseNumber: "888000" });
const mk = (clientId: string, owner: string, street: string) => createProject(db, {
  clientId, owner, street, city: "Coos Bay", state: "OR", ahj: "City of Coos Bay",
  utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;

const keep = mk(client.id, "Real Owner", "1 Keeper St");
const supersededA = mk(client.id, "Real Owner", "1 Keeper St");
const supersededB = mk(client.id, "Real Owner", "1 Keeper St");
const theirs = mk(other.id, "Their Owner", "2 Theirs St");
const token = ensureClientPortalToken(db, client.id);
const otherToken = ensureClientPortalToken(db, other.id);

check("before archiving, all three passes at one job are on the client's page", () => {
  assert.equal(clientPortalPayload(db, token)!.projects.length, 3);
});

const outcome = archiveProject(db, supersededA.id, "superseded by a later pass at the same job");
archiveProject(db, supersededB.id, "superseded by a later pass at the same job");

check("THE HEADLINE: an archived project is gone from the client's page", () => {
  const ids = clientPortalPayload(db, token)!.projects.map((p) => p.id);
  assert.deepEqual(ids, [keep.id], `the client still sees superseded passes: ${JSON.stringify(ids)}`);
});

check("MUST KEEP: the row, its submissions and its documents are all still there", () => {
  // The whole reason this is not a delete. demoReplay.ts reads the live database by project id,
  // and HANDOFF cites these runs — archiving must cost nothing but visibility.
  assert.equal(outcome.archived, true, outcome.reason);
  const row = db.get<Record<string, unknown>>("SELECT id, status, archived_at, archived_reason FROM projects WHERE id = ?", [supersededA.id]);
  assert.ok(row, "the project row was destroyed — this is supposed to be reversible");
  assert.ok(String(row!.archived_at), "archived_at was not stamped");
  assert.match(String(row!.archived_reason), /superseded/, "the reason is how you know why, months later");
});

check("MUST REVERSE: unarchiving puts it back on the page", () => {
  unarchiveProject(db, supersededA.id);
  const ids = clientPortalPayload(db, token)!.projects.map((p) => p.id).sort();
  assert.deepEqual(ids.sort(), [keep.id, supersededA.id].sort(), "an archive you cannot undo is a delete with extra steps");
  archiveProject(db, supersededA.id, "re-archived by the test");
});

check("MUST NOT: archiving one client's project does not touch another's", () => {
  assert.equal(clientPortalPayload(db, otherToken)!.projects.length, 1,
    "the other company's project disappeared too");
});

check("MUST NOT: a project that was never archived stays visible", () => {
  // The failure mode worth guarding: a filter written as `archived_at IS NULL` when the column
  // defaults to '' hides nothing, and one written as `= ''` against a NULL hides everything.
  const visible = clientPortalPayload(db, token)!.projects.map((p) => p.id);
  assert.ok(visible.includes(keep.id), "the live project vanished — the filter is inverted or null-confused");
});

check("archiving an unknown project is refused, not silently ignored", () => {
  const r = archiveProject(db, "no-such-project", "typo");
  assert.equal(r.archived, false);
  assert.match(r.reason, /no such project/i);
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nprojectArchive: all checks passed."
  : `\nprojectArchive: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
