// A STRUCTURAL PERMIT LABELLED "ELECTRICAL" IS A WRONG FACT ON A CLIENT'S PAGE.
//
// Spotted by the operator on the live portal. 1780 Ocean Blvd has two permit tracks and the page
// showed them like this:
//
//   Building/electrical permit   Application 187-26-000309-STR   In review
//   Building/electrical permit   Application 194-26-001482-ELEC  Permit issued
//
// One is the structural permit and one is the electrical permit; the page asserted the same
// discipline for both. The client reads "Permit issued" against a row that says electrical and
// has to work out from the -STR/-ELEC suffix which of their two permits actually landed.
//
// The label was hardcoded — `type === "nem" ? "…(NEM)" : "Building/electrical permit"` — while
// `permit_check_targets.permit_type` has held exactly this ('nem' | 'building' | 'electrical' |
// 'combo') since the column was added. Four of seven live rows were blank because
// addPermitCheckTarget's INSERT never listed the column, so it silently defaulted to ''.
//
//   MUST NAME     — each discipline distinctly, from permit_type.
//   MUST NOT GUESS— a blank permit_type says "Permit", never "Building/electrical". Asserting a
//                   discipline we do not have is the bug, and asserting the OTHER one is no fix.
//   MUST BACKFILL — from the submissions table, which recorded the discipline against the same
//                   application number all along. Recorded data, not inference from the suffix.
//   MUST NOT      — backfill across projects. Application numbers are unique per jurisdiction,
//                   not globally, and two clients can hold the same string.
//
//   npx tsx backend/test/trackDiscipline.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "track-discipline-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { ensureClientPortalToken, clientPortalPayload, trackLabel } = await import("../src/clientPortal");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

check("THE BUG: each discipline gets its own name", () => {
  assert.equal(trackLabel("permit", "electrical"), "Electrical permit");
  assert.equal(trackLabel("permit", "building"), "Building permit");
  assert.equal(trackLabel("permit", "structural"), "Building permit", "the fee layer says 'structural' for the same thing");
  // A COMBINATION permit only when the job's structure confirms it (leak sweep 2026-09-28): the
  // default 'combo' track of an UNCONFIRMED structure is just "Permit" on a client's page.
  assert.equal(trackLabel("permit", "combo", { combo: true }), "Combination building & electrical permit");
  assert.equal(trackLabel("permit", "combo"), "Permit", "an unconfirmed structure's default combo track must not claim a combination permit");
  assert.equal(trackLabel("nem", "nem"), "Utility interconnection");
  assert.equal(trackLabel("nem", ""), "Utility interconnection", "target_type alone settles NEM");
});

check("MUST NOT GUESS: an unknown discipline says 'Permit', not 'Building/electrical'", () => {
  // The original label asserted BOTH disciplines for every permit track. Replacing it with a
  // different confident guess would be the same bug wearing a new label.
  assert.equal(trackLabel("permit", ""), "Permit");
  assert.equal(trackLabel("permit", "permit"), "Permit", "the legacy default is not a discipline");
  for (const unknown of ["", "permit", "wat"]) {
    assert.doesNotMatch(trackLabel("permit", unknown), /electrical|building/i,
      `a discipline was asserted for permit_type=${JSON.stringify(unknown)}`);
  }
});

// ── the live shape, and the backfill ─────────────────────────────────────────────────────
const client = createClient(db, { companyName: "Discipline Solar", ccbLicenseNumber: "616161" });
const { project } = createProject(db, {
  clientId: client.id, owner: "Two Track Owner", street: "1780 Ocean Blvd SE", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
});
const other = createClient(db, { companyName: "Elsewhere Solar", ccbLicenseNumber: "626262" });
const { project: elsewhere } = createProject(db, {
  clientId: other.id, owner: "Other Owner", street: "9 Far Away", city: "Salem",
  state: "OR", ahj: "City of Salem", utility: "PGE", dcKw: "8", acKw: "6.4",
});
const token = ensureClientPortalToken(db, client.id);
const now = new Date().toISOString();

// Targets exactly as addPermitCheckTarget left them on the live database: permit_type blank.
for (const [tid, app, type] of [
  ["t-str", "187-26-000309-STR", "permit"],
  ["t-ele", "194-26-001482-ELEC", "permit"],
] as const) {
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, active, latest_outcome, application_number, permit_number, created_at, updated_at)
     VALUES (?, ?, ?, '', 1, 'waiting', ?, ?, ?, ?)`,
    [tid, project.id, type, app, app, now, now],
  );
}
// The submissions that recorded what each one actually is.
for (const [sid, app, discipline] of [
  ["s-str", "187-26-000309-STR", "building"],
  ["s-ele", "194-26-001482-ELEC", "electrical"],
] as const) {
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, application_number, created_at)
     VALUES (?, ?, 'permit', ?, 'submitted', ?, ?)`,
    [sid, project.id, discipline, app, now],
  );
}
// THE TRAP: a different client's submission carrying the SAME application number. Application
// numbers are unique within a jurisdiction, not globally.
db.run(
  `INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, active, latest_outcome, application_number, permit_number, created_at, updated_at)
   VALUES ('t-far', ?, 'permit', '', 1, 'waiting', '187-26-000309-STR', '', ?, ?)`,
  [elsewhere.id, now, now],
);
db.run(
  `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, application_number, created_at)
   VALUES ('s-far', ?, 'permit', 'electrical', 'submitted', '187-26-000309-STR', ?)`,
  [elsewhere.id, now],
);

check("before the backfill, both live rows are blank — the state the operator saw", () => {
  const rows = db.query<{ permit_type: string }>("SELECT permit_type FROM permit_check_targets WHERE id IN ('t-str','t-ele')");
  assert.deepEqual(rows.map((r) => r.permit_type), ["", ""]);
});

db.run("DELETE FROM schema_meta WHERE version >= 28");
const db2 = await openDatabase();

check("BACKFILL: the submissions knew the discipline all along", () => {
  const byId = Object.fromEntries(
    db2.query<{ id: string; permit_type: string }>("SELECT id, permit_type FROM permit_check_targets WHERE id IN ('t-str','t-ele')")
      .map((r) => [r.id, r.permit_type]),
  );
  assert.equal(byId["t-str"], "building", "the STR track is the building permit");
  assert.equal(byId["t-ele"], "electrical", "the ELEC track is the electrical permit");
});

check("MUST NOT: the backfill does not cross projects on a shared application number", () => {
  // t-far belongs to a different client and its own submission says 'electrical'. If the
  // backfill matched on application_number alone it would take the first row it found — which is
  // how one company's data decides another's label.
  const far = db2.get<{ permit_type: string }>("SELECT permit_type FROM permit_check_targets WHERE id = 't-far'")!;
  assert.equal(far.permit_type, "electrical", "it must use t-far's OWN project's submission, not the other project's");
});

check("THE HEADLINE: the client's page now tells the two permits apart", () => {
  const p = clientPortalPayload(db2, token)!.projects.find((x) => x.id === project.id)!;
  const labels = p.tracks.map((t) => t.label).sort();
  assert.deepEqual(labels, ["Building permit", "Electrical permit"],
    `the two permit tracks are still indistinguishable: ${JSON.stringify(p.tracks.map((t) => [t.label, t.applicationNumber]))}`);
  const str = p.tracks.find((t) => t.applicationNumber.endsWith("-STR"))!;
  assert.equal(str.label, "Building permit", "the structural permit is still being called electrical");
});

check("v28 is recorded, so it is a migration and not a startup chore", () => {
  assert.equal(db2.get<{ name: string }>("SELECT name FROM schema_meta WHERE version = 28")?.name, "permit_check_target_discipline");
});

db2.close();
try { db.close(); } catch { /* closed by the replay */ }
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\ntrackDiscipline: all checks passed."
  : `\ntrackDiscipline: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
