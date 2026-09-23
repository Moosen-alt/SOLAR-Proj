// ONE FILING'S READING MUST NOT SPEAK FOR ANOTHER FILING (LNK-3, LNK-4).
//
// A project files two or three things (NEM + one combo permit, or NEM + building + electrical),
// and the permit monitor reads each one's portal separately — but the project has ONE status,
// and the handoff asked "has anything ever read issued?". So:
//
//   LNK-3  the ELECTRICAL permit reading "issued" rewrote correction_received to issued while
//          the BUILDING permit still stood in correction — the most urgent state hidden.
//   LNK-4  triggerHandoffIfReady counted `ready_for_issue` (fees due, no permit card) and ONE
//          of two permits as "permit issued", and re-handed-off a project a new correction had
//          just reopened. A false "scope complete" publishes an installer checklist that says
//          to post a permit card that does not exist.
//
// Real write paths only: createProject, markTrackSubmitted (the operator's "I filed it", which
// creates each filing's tracking target) and recordPermitStatusCheck with source 'manual' (the
// classifier reads the text exactly as it reads a portal). No portal, no browser, no staging.
//
//   npx tsx backend/test/permitOutcomeTracks.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "permit-outcome-tracks-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.CLIENT_NOTIFICATIONS = "off";
process.env.BACKGROUND_WORKERS = "off";
process.env.DOCUMENT_FETCH = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.AHJ_FORM_RESEARCH = "off";
process.env.FEE_RESEARCH = "off";
process.env.PORTAL_URL_RESEARCH = "off";
process.env.RUN_TRIAGE = "off";
process.env.AUTO_RELEARN_STALE = "0";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { markTrackSubmitted, getSubmittalTracks, requiredTracks, outcomeFinishesTrack } = await import("../src/submittalTracks");
const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = (label: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
interface Row { [k: string]: unknown }
const statusOf = (pid: string): string => String(db.get<Row>("SELECT status FROM projects WHERE id = ?", [pid])?.status ?? "");
const count = (sql: string, params: unknown[]): number => Number(db.get<{ n: number }>(sql, params as never)?.n ?? 0);
const targetFor = (pid: string, track: string): string => {
  const t = db.get<Row>("SELECT id FROM permit_check_targets WHERE project_id = ? AND permit_type = ? AND active = 1", [pid, track]);
  assert.ok(t, `no tracking target for the ${track} track — markTrackSubmitted should have created one`);
  return String(t!.id);
};
const read = (pid: string, track: string, text: string) =>
  R.recordPermitStatusCheck(db, pid, { targetId: targetFor(pid, track), source: "manual", rawStatusText: text });
const outcomeOf = (pid: string, track: string): string =>
  String(db.get<Row>("SELECT latest_outcome FROM permit_check_targets WHERE id = ?", [targetFor(pid, track)])?.latest_outcome ?? "");
const handoffNotes = (pid: string): number => count("SELECT COUNT(*) AS n FROM project_notes WHERE project_id = ? AND note_type = 'handoff'", [pid]);

const CORRECTION = "Plan review complete. Corrections required - please revise and resubmit.";
const ISSUED = "Permit issued. Download permit card from the portal.";
const READY_FOR_ISSUE = "Approved pending payment. Permit is ready to issue; issuance fees are due.";
const NEM_APPROVED = "Interconnection application approved. Permission to operate granted.";

/** A filed project: every required track recorded as submitted through the operator's door. */
const filed = (owner: string, where: "salem" | "portland"): string => {
  const base = where === "salem"
    ? { street: "905 Quarry Bend", city: "Salem", zip: "97301", ahj: "City of Salem", utility: "Portland General Electric" }
    : { street: "123 Solar Way", city: "Portland", zip: "97201", ahj: "Portland", utility: "PGE" };
  const pid = R.createProject(db, { owner, state: "OR", dcKw: "8.6", acKw: "5.8", permitPath: "prescriptive", ...base } as never).project.id;
  const project = R.getProjectDetail(db, pid).project;
  for (const t of requiredTracks(project)) {
    markTrackSubmitted(db, R.getProjectDetail(db, pid).project, t, { applicationNumber: `POT-${t}`, submittedBy: "permit outcome test" });
  }
  return pid;
};

try {
  // ── fixtures prove the texts classify as intended ───────────────────────────────────────
  const s1 = filed("Salem Correction Owner", "salem");
  check("fixture: Salem files nem + building + electrical, each with its own tracking target", () => {
    assert.deepEqual(requiredTracks(R.getProjectDetail(db, s1).project), ["nem", "building", "electrical"]);
    for (const t of ["nem", "building", "electrical"]) targetFor(s1, t);
  });

  // ═══ LNK-3: another permit's good news does not clear this permit's correction ═════════
  await read(s1, "building", CORRECTION);
  check("fixture: the building permit's correction reading puts the project at correction_received", () => {
    assert.equal(outcomeOf(s1, "building"), "correction_flagged");
    assert.equal(statusOf(s1), "correction_received");
  });
  await read(s1, "electrical", ISSUED);
  check("3a. the ELECTRICAL permit's 'issued' does NOT erase the BUILDING permit's open correction", () => {
    assert.equal(outcomeOf(s1, "electrical"), "issued", "fixture: the text must classify as issued");
    assert.equal(statusOf(s1), "correction_received", `status=${statusOf(s1)}`);
  });
  await read(s1, "nem", NEM_APPROVED);
  check("3b. a NEM approval does not erase it either (any other target's positive reading)", () => {
    assert.equal(outcomeOf(s1, "nem"), "nem_approved", "fixture: the text must classify as nem_approved");
    assert.equal(statusOf(s1), "correction_received", `status=${statusOf(s1)}`);
  });
  // ═══ LNK-4 (shape 2): electrical issued + building in correction + NEM approved ═════════
  check("4b. electrical issued + building in correction + NEM approved does NOT hand off", () => {
    assert.notEqual(statusOf(s1), "handoff_ready");
    assert.equal(handoffNotes(s1), 0, "an installer handoff note was published");
  });

  // Same target recovering is legitimate news.
  const s2 = filed("Salem Recovery Owner", "salem");
  await read(s2, "building", CORRECTION);
  await read(s2, "building", ISSUED);
  check("3c. MUST PASS: the SAME permit recovering (correction, then issued) still moves the project to issued", () => {
    assert.equal(statusOf(s2), "issued", `status=${statusOf(s2)}`);
  });

  // ═══ LNK-4 (shape 1): NEM approved, then the permit only reaches ready_for_issue ════════
  const p1 = filed("Portland Fees Due Owner", "portland");
  check("fixture: Portland files nem + combo", () => {
    assert.deepEqual(requiredTracks(R.getProjectDetail(db, p1).project), ["nem", "combo"]);
  });
  await read(p1, "nem", NEM_APPROVED);
  await read(p1, "combo", READY_FOR_ISSUE);
  check("4a. NEM approved then the permit read ready_for_issue (fees due) does NOT hand off", () => {
    assert.equal(outcomeOf(p1, "combo"), "ready_for_issue", "fixture: the text must classify as ready_for_issue");
    assert.equal(statusOf(p1), "ready_for_issue", `status=${statusOf(p1)}`);
    assert.equal(handoffNotes(p1), 0);
  });
  // …and issuance then does hand off, once.
  await read(p1, "combo", ISSUED);
  check("4d. MUST PASS: the permit issued with NEM approved hands off — one note, one audit row", () => {
    assert.equal(statusOf(p1), "handoff_ready", `status=${statusOf(p1)}`);
    assert.equal(handoffNotes(p1), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action = 'handoff.ready'", [p1]), 1);
  });
  await read(p1, "nem", NEM_APPROVED);
  await read(p1, "combo", ISSUED);
  check("4e. repeat polls on a handed-off project keep it handed off and write no second handoff note", () => {
    assert.equal(statusOf(p1), "handoff_ready");
    assert.equal(handoffNotes(p1), 1);
  });

  // ═══ LNK-4 (shape 3): a correction after handoff stays a correction ════════════════════
  await read(p1, "combo", CORRECTION);
  check("4c. a correction arriving after handoff leaves the project at correction_received (not re-handed-off)", () => {
    assert.equal(statusOf(p1), "correction_received", `status=${statusOf(p1)}`);
    assert.equal(handoffNotes(p1), 1, "the handoff note was published again");
  });

  // ═══ ONE "is this track done" rule — the tracks panel and the handoff agree ═══════════
  check("4f. outcomeFinishesTrack (the outcome half of isTrackDone): permit tracks are done at issued only, NEM at nem_approved only, each on its own kind of target", () => {
    assert.equal(outcomeFinishesTrack("combo", "issued", "permit"), true);
    assert.equal(outcomeFinishesTrack("combo", "ready_for_issue", "permit"), false);
    assert.equal(outcomeFinishesTrack("combo", "nem_approved", "permit"), false);
    assert.equal(outcomeFinishesTrack("nem", "nem_approved", "nem"), true);
    assert.equal(outcomeFinishesTrack("nem", "issued", "nem"), false);
    assert.equal(outcomeFinishesTrack("building", "issued", "nem"), false);
  });
  const p2 = filed("Portland Wrong Kind Owner", "portland");
  await read(p2, "nem", ISSUED);
  await read(p2, "combo", ISSUED);
  check("4g. a NEM target whose text reads 'permit issued' is NOT a finished NEM track — panel and handoff agree", () => {
    const nem = getSubmittalTracks(db, R.getProjectDetail(db, p2).project).find((t) => t.type === "nem")!;
    assert.notEqual(nem.status, "issued", `the NEM track reads '${nem.status}' off a permit-kind outcome`);
    assert.equal(nem.outstanding, true);
    assert.notEqual(statusOf(p2), "handoff_ready");
  });
} finally {
  console.log(failures ? `\npermitOutcomeTracks: ${failures} check(s) FAILED, ${passed} passed` : `\npermitOutcomeTracks: all ${passed} checks passed`);
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* leave to the OS */ }
}
process.exit(failures ? 1 : 0);
