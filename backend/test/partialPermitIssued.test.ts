// ONE PERMIT ISSUED IS NOT THE PROJECT'S PERMITS ISSUED (live 2026-09-28).
//
// A separate-permit AHJ (Marion County for City of Jefferson) issued the ELECTRICAL permit while
// the BUILDING permit sat in review. The status writer (repository.updateProjectForPermitOutcome)
// wrote the project headline "issued" off the electrical reading alone, and the client update
// said "That clears the permit side." Both are false until every required permit track is done
// (submittalTracks.isTrackDone — the answer the tracks panel and the handoff already share).
//
// Driven through the real write paths (createProject, createPermitCheckTarget,
// recordPermitStatusCheck, clientUpdateFor). The one raw write is the "issued" headline the OLD
// writer left on live projects — the repair case — set directly because the fixed writer can no
// longer produce it.
//
//   npx tsx backend/test/partialPermitIssued.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-permit-issued-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
delete process.env.PORTAL_AUTOMATION;
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE"]) process.env[k] = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.AUTO_RELEARN_STALE = "0";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { requiredTracks } = await import("../src/submittalTracks");
const { clientUpdateFor } = await import("../src/clientUpdates");

const db = await openDatabase();
interface Row { [k: string]: unknown }

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const statusOf = (pid: string): Row => db.get<Row>("SELECT status, current_stage FROM projects WHERE id = ?", [pid]) ?? {};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 3));

const ISSUED = "Permit issued. Download permit card from the portal.";
const IN_REVIEW = "Plan review in progress.";

// Salem files SEPARATE building + electrical permits (plus NEM) — the Michael shape.
const SALEM = { state: "OR", dcKw: "8.6", acKw: "5.8", permitPath: "prescriptive", street: "905 Quarry Bend", city: "Salem", zip: "97301", ahj: "City of Salem", utility: "Portland General Electric" };
const salem = (owner: string): string => R.createProject(db, { owner, ...SALEM } as never).project.id;
const PORTLAND = { state: "OR", dcKw: "8.6", acKw: "6.5", permitPath: "prescriptive", street: "123 Solar Way", city: "Portland", zip: "97201", ahj: "Portland", utility: "PGE" };

type TargetInput = { applicationNumber: string; permitType?: string; targetType?: "permit" | "nem" };
const addTargets = (pid: string, targets: TargetInput[]): Record<string, string> => {
  let detail = R.getProjectDetail(db, pid);
  for (const t of targets) detail = R.createPermitCheckTarget(db, pid, { jurisdiction: t.targetType === "nem" ? "PGE" : "City", ...t } as never);
  return Object.fromEntries(detail.permitCheckTargets.map((t) => [t.applicationNumber, t.id]));
};
const read = async (pid: string, targetId: string, text: string): Promise<void> => {
  await R.recordPermitStatusCheck(db, pid, { targetId, source: "manual", rawStatusText: text });
  await tick();
};

try {
  await check("fixture: Salem requires nem + building + electrical", () => {
    assert.deepEqual(requiredTracks(R.getProjectDetail(db, salem("Fixture Salem")).project), ["nem", "building", "electrical"]);
  });

  // ═══ 1. the live shape: building in review, electrical issued ═══════════════════════════════
  const p1 = salem("Partial Owner");
  const t1 = addTargets(p1, [
    { applicationNumber: "STR-1", permitType: "building" },
    { applicationNumber: "ELE-1", permitType: "electrical" },
    { applicationNumber: "NEM-1", targetType: "nem", permitType: "nem" },
  ]);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [p1]); // both filed by hand (capture-confirmation's end state)
  await read(p1, t1["STR-1"], IN_REVIEW);
  await read(p1, t1["ELE-1"], ISSUED);
  await check("1a. MUST-EXCLUDE the electrical permit alone never makes the project headline 'issued'", () => {
    const s = statusOf(p1);
    assert.equal(s.status, "submitted", JSON.stringify(s));
    assert.match(String(s.current_stage), /Not yet issued: the building permit/, JSON.stringify(s));
  });
  await check("1b. MUST-EXCLUDE the client is not told 'that clears the permit side' — the building permit is named as still in review", () => {
    const project = R.getProjectDetail(db, p1).project;
    const u = clientUpdateFor(db, project, "issued", { targetType: "permit", permitType: "electrical", permitNumber: "ELE-1" });
    assert.ok(u, "no update drafted");
    assert.match(u!.headline, /issued the electrical permit/);
    assert.doesNotMatch(`${u!.meaning} ${u!.action}`, /clears the permit side|installation can be scheduled/i, JSON.stringify(u));
    assert.match(u!.meaning, /The building permit is still in review/, JSON.stringify(u));
  });
  await read(p1, t1["STR-1"], ISSUED);
  await check("1c. MUST-PASS once the building permit is issued too, the headline is 'issued'", () => {
    assert.equal(statusOf(p1).status, "issued", JSON.stringify(statusOf(p1)));
    const project = R.getProjectDetail(db, p1).project;
    const u = clientUpdateFor(db, project, "issued", { targetType: "permit", permitType: "building", permitNumber: "STR-1" });
    assert.doesNotMatch(u!.meaning, /still in review, so the installation/, JSON.stringify(u));
  });

  // ═══ 2. the repair: a project the OLD writer left at 'issued' ═══════════════════════════════
  const p2 = salem("Stale Headline Owner");
  const t2 = addTargets(p2, [
    { applicationNumber: "STR-2", permitType: "building" },
    { applicationNumber: "ELE-2", permitType: "electrical" },
  ]);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [p2]);
  await read(p2, t2["STR-2"], IN_REVIEW);
  db.run("UPDATE projects SET status = 'issued' WHERE id = ?", [p2]); // what the old writer wrote
  await read(p2, t2["ELE-2"], ISSUED); // the next poll of the issued electrical permit
  await check("2. the next poll of the issued electrical permit corrects a stale 'issued' headline to 'submitted'", () => {
    assert.equal(statusOf(p2).status, "submitted", JSON.stringify(statusOf(p2)));
  });

  // ═══ 3. MUST-PASS: a single combination permit is still 'issued' on its own reading ══════════
  const p3 = R.createProject(db, { owner: "Combo Owner", ...PORTLAND } as never).project.id;
  const t3 = addTargets(p3, [{ applicationNumber: "CMB-3", permitType: "combo" }]);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [p3]);
  await read(p3, t3["CMB-3"], ISSUED);
  await check("3. MUST-PASS a combination permit's own 'issued' writes the headline 'issued'", () => {
    assert.equal(statusOf(p3).status, "issued", JSON.stringify(statusOf(p3)));
  });

  // ═══ 4. fees due on the building permit are not rewound by the electrical issuance ══════════
  const p4 = salem("Fees Due Owner");
  const t4 = addTargets(p4, [
    { applicationNumber: "STR-4", permitType: "building" },
    { applicationNumber: "ELE-4", permitType: "electrical" },
  ]);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [p4]);
  await read(p4, t4["STR-4"], "Approved pending payment. Issuance fees due.");
  const before = statusOf(p4).status;
  await read(p4, t4["ELE-4"], ISSUED);
  await check("4. the building permit's fees-due state holds when the electrical permit issues", () => {
    assert.equal(before, "ready_for_issue", `fixture: building reading gave ${String(before)}`);
    assert.equal(statusOf(p4).status, "ready_for_issue", JSON.stringify(statusOf(p4)));
  });
  // ═══ 5. MUST-PASS: a required permit nobody has tracked does not hold the headline ══════════
  // (Only a TRACKED filing not yet issued does — an untracked one is "not started" on its card.)
  const p5 = salem("Untracked Electrical Owner");
  const t5 = addTargets(p5, [{ applicationNumber: "STR-5", permitType: "building" }]);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [p5]);
  await read(p5, t5["STR-5"], ISSUED);
  await check("5. MUST-PASS building issued with no electrical filing tracked: the headline is 'issued'", () => {
    assert.equal(statusOf(p5).status, "issued", JSON.stringify(statusOf(p5)));
  });
} finally {
  console.log(`\npartialPermitIssued: ${passed} passed, ${failures} failed`);
  if (failures) { console.error(`partialPermitIssued: ${failures} check(s) FAILED`); process.exitCode = 1; }
  else console.log("partialPermitIssued: all checks passed — one permit issued is not the project's permits issued");
}
