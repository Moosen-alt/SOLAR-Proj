// "IS THIS TRACK DONE?" — THE ONE ANSWER THE HANDOFF AND THE TRACKS PANEL SHARE.
//
// The per-track handoff (repository.handoffBlockers → submittalTracks.isTrackDone) replaced
// "has anything on this project ever read issued". A skeptic's probes found three ways the
// replacement was wrong, plus two repair-round items that live next to it:
//
//   1. STRUCTURAL. A building permit tagged 'structural' (the fee layer's and the operator's word
//      for it) was never read by the building track, so a project with structural + electrical +
//      nem targets — live project ec5c36d3 — could never reach handoff_ready, and handoff_ready
//      cannot be set by hand (409 "computed").
//   2. UNTAGGED. Dashboard-added targets carry permit_type ''. On a multi-permit project the ''
//      fallback resolved building AND electrical to the same newest-polled target, so the
//      electrical permit's "issued" handed off a project whose building permit was in plan review.
//   3. LATEST-ONLY. Targets are polled forever; after issuance the AHJ's text moves on ("Record
//      Status: Finaled" → needs_human_review, "Final Approved" → reviewed_by_ahj, "Inspections in
//      progress" → waiting), so a finaled permit read "not done" and the project never handed off.
//   6. STAGED MEANWHILE. prepareSubmission re-checks, at the last point before dispatch, whether
//      the track reached the portal (another run) since the call began.
//   7. PROVENANCE. The cold-start portal.url_researched audit note says whether the URL came from
//      a web-grounded search or model memory.
//
// Everything is driven through the real write paths (createProject, createPermitCheckTarget,
// recordPermitStatusCheck, prepareSubmission against the mock portal); the one seam is (6)'s db
// view, which lands another run's portal_runs row between prepareSubmission's entry read and its
// dispatch — the same seam autopilotResumeConcurrency.test.ts uses for Segment A.
//
//   npx tsx backend/test/handoffTrackDone.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-track-done-"));
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
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const R = await import("../src/repository");
const { getSubmittalTracks, requiredTracks, isTrackDone } = await import("../src/submittalTracks");

const db = await openDatabase();
interface Row { [k: string]: unknown }

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const statusOf = (pid: string): string => String(db.get<Row>("SELECT status FROM projects WHERE id = ?", [pid])?.status ?? "");
const handoffNotes = (pid: string): number => Number(db.get<Row>("SELECT COUNT(*) AS n FROM project_notes WHERE project_id = ? AND note_type = 'handoff'", [pid])?.n ?? 0);
const panel = (pid: string): string[] => getSubmittalTracks(db, R.getProjectDetail(db, pid).project).map((t) => `${t.type}:${t.status}`);
const blockers = (pid: string): string[] => R.handoffBlockers(db, R.getProjectDetail(db, pid).project);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 3));

const ISSUED = "Permit issued. Download permit card from the portal.";
const IN_REVIEW = "Plan review in progress.";
const NEM_APPROVED = "Interconnection application approved. Permission to operate granted.";
const CORRECTION = "Corrections required. Please revise the structural calculations and resubmit.";

// Salem files SEPARATE building + electrical permits (plus NEM) — the multi-permit shape.
const SALEM = { state: "OR", dcKw: "8.6", acKw: "5.8", permitPath: "prescriptive", street: "905 Quarry Bend", city: "Salem", zip: "97301", ahj: "City of Salem", utility: "Portland General Electric" };
const salem = (owner: string): string => R.createProject(db, { owner, ...SALEM } as never).project.id;
// Portland files ONE combination permit (plus NEM).
const PORTLAND = { state: "OR", dcKw: "8.6", acKw: "6.5", permitPath: "prescriptive", street: "123 Solar Way", city: "Portland", zip: "97201", ahj: "Portland", utility: "PGE" };
const portland = (owner: string): string => R.createProject(db, { owner, ...PORTLAND } as never).project.id;

type TargetInput = { applicationNumber: string; permitType?: string; targetType?: "permit" | "nem" };
const addTargets = (pid: string, targets: TargetInput[]): Record<string, string> => {
  let detail = R.getProjectDetail(db, pid);
  for (const t of targets) {
    detail = R.createPermitCheckTarget(db, pid, { jurisdiction: t.targetType === "nem" ? "PGE" : "City", ...t } as never);
  }
  return Object.fromEntries(detail.permitCheckTargets.map((t) => [t.applicationNumber, t.id]));
};
const read = async (pid: string, targetId: string, text: string): Promise<void> => {
  await R.recordPermitStatusCheck(db, pid, { targetId, source: "manual", rawStatusText: text });
  await tick();
};

try {
  await check("fixture: Salem requires nem + building + electrical; Portland nem + combo", () => {
    assert.deepEqual(requiredTracks(R.getProjectDetail(db, salem("Fixture Salem")).project), ["nem", "building", "electrical"]);
    assert.deepEqual(requiredTracks(R.getProjectDetail(db, portland("Fixture Portland")).project), ["nem", "combo"]);
  });

  // ═══ 1. STRUCTURAL IS THE BUILDING TRACK ═══════════════════════════════════════════════════
  const s1 = salem("Structural Owner");
  const s1t = addTargets(s1, [
    { applicationNumber: "STR-1", permitType: "structural" },
    { applicationNumber: "ELE-1", permitType: "electrical" },
    { applicationNumber: "NEM-1", targetType: "nem", permitType: "nem" },
  ]);
  await read(s1, s1t["STR-1"], ISSUED);
  await read(s1, s1t["ELE-1"], ISSUED);
  await check("1a. the building track reads the 'structural' target: panel says building:issued", () => {
    const p = panel(s1);
    assert.ok(p.includes("building:issued") && p.includes("electrical:issued"), JSON.stringify(p));
    assert.equal(isTrackDone(db, s1, "building", ["nem", "building", "electrical"]), true);
  });
  await read(s1, s1t["NEM-1"], NEM_APPROVED);
  await check("1b. structural + electrical + NEM all done → handoff_ready, one handoff note", () => {
    assert.deepEqual(blockers(s1), []);
    assert.equal(statusOf(s1), "handoff_ready", `status=${statusOf(s1)}`);
    assert.equal(handoffNotes(s1), 1);
  });

  // ATTRIBUTION, NOT A GUESS: with the fold the structural permit IS the building track, so an
  // unrelated untagged filing still in review is the electrical track's problem alone. (The
  // handoff verdict would be "blocked" either way; the panel is where the fold shows.)
  const s2 = salem("Structural Plus Untagged Owner");
  const s2t = addTargets(s2, [
    { applicationNumber: "STR-2", permitType: "structural" },
    { applicationNumber: "ELE-2" },
    { applicationNumber: "NEM-2", targetType: "nem", permitType: "nem" },
  ]);
  await read(s2, s2t["STR-2"], ISSUED);
  await read(s2, s2t["ELE-2"], IN_REVIEW);
  await read(s2, s2t["NEM-2"], NEM_APPROVED);
  await check("1c. structural issued + an untagged permit in review: building reads issued, electrical in review", () => {
    assert.deepEqual(panel(s2), ["nem:issued", "building:issued", "electrical:in_review"]);
    assert.ok(blockers(s2).includes("electrical track not done"), JSON.stringify(blockers(s2)));
    assert.ok(!blockers(s2).includes("building track not done"), JSON.stringify(blockers(s2)));
    assert.notEqual(statusOf(s2), "handoff_ready");
  });

  // ═══ 2. ONE UNATTRIBUTED TARGET NEVER FINISHES TWO TRACKS ══════════════════════════════════
  const u1 = salem("Untagged Owner");
  const u1t = addTargets(u1, [
    { applicationNumber: "BLD-1" },
    { applicationNumber: "ELE-1" },
    { applicationNumber: "NEM-1", targetType: "nem", permitType: "nem" },
  ]);
  await check("fixture: dashboard-added permit targets carry permit_type ''", () => {
    const tags = db.query<Row>("SELECT permit_type FROM permit_check_targets WHERE project_id = ? AND target_type = 'permit'", [u1]).map((r) => String(r.permit_type));
    assert.deepEqual(tags, ["", ""]);
  });
  await read(u1, u1t["BLD-1"], IN_REVIEW);
  await read(u1, u1t["ELE-1"], ISSUED);
  await read(u1, u1t["NEM-1"], NEM_APPROVED);
  await check("2a. building in plan review + electrical issued (both untagged) + NEM approved does NOT hand off", () => {
    assert.notEqual(statusOf(u1), "handoff_ready");
    assert.equal(handoffNotes(u1), 0, "an installer handoff note was published");
    const b = blockers(u1);
    assert.ok(b.includes("building track not done") && b.includes("electrical track not done"), JSON.stringify(b));
  });
  await check("2b. the panel agrees — neither permit track reads issued off the one issued target", () => {
    assert.deepEqual(panel(u1), ["nem:issued", "building:in_review", "electrical:in_review"]);
    const building = getSubmittalTracks(db, R.getProjectDetail(db, u1).project).find((t) => t.type === "building")!;
    assert.doesNotMatch(building.statusLabel, /issued/i, `label "${building.statusLabel}" contradicts the status`);
  });
  await read(u1, u1t["BLD-1"], ISSUED);
  await check("2c. MUST PASS: once EVERY untagged permit target is issued, the project hands off", () => {
    assert.equal(statusOf(u1), "handoff_ready", `status=${statusOf(u1)} blockers=${JSON.stringify(blockers(u1))}`);
    assert.equal(handoffNotes(u1), 1);
  });

  const u2 = salem("Single Untagged Owner");
  const u2t = addTargets(u2, [
    { applicationNumber: "PERMIT-1" },
    { applicationNumber: "NEM-1", targetType: "nem", permitType: "nem" },
  ]);
  await read(u2, u2t["PERMIT-1"], ISSUED);
  await read(u2, u2t["NEM-1"], NEM_APPROVED);
  await check("2d. ONE untagged permit target on a two-permit project cannot finish both tracks", () => {
    assert.notEqual(statusOf(u2), "handoff_ready");
    assert.deepEqual(blockers(u2), ["building track not done", "electrical track not done"]);
  });

  // Every track tagged and finished, plus an unattributed permit target still in review (an MPU
  // tracked without an MPU track, a dashboard-added filing): nothing draws on the pool, but the
  // filing is still open.
  const u3 = salem("Tagged Plus Stray Owner");
  const u3t = addTargets(u3, [
    { applicationNumber: "BLD-3", permitType: "building" },
    { applicationNumber: "ELE-3", permitType: "electrical" },
    { applicationNumber: "MPU-3" },
    { applicationNumber: "NEM-3", targetType: "nem", permitType: "nem" },
  ]);
  await read(u3, u3t["BLD-3"], ISSUED);
  await read(u3, u3t["ELE-3"], ISSUED);
  await read(u3, u3t["MPU-3"], IN_REVIEW);
  await read(u3, u3t["NEM-3"], NEM_APPROVED);
  await check("2f. every track issued but an unattributed permit target still in review does NOT hand off", () => {
    assert.notEqual(statusOf(u3), "handoff_ready");
    assert.deepEqual(blockers(u3), ["1 unattributed permit tracking target(s) not done"]);
  });
  await read(u3, u3t["MPU-3"], ISSUED);
  await check("2g. MUST PASS: …and hands off once that filing is issued too", () => {
    assert.equal(statusOf(u3), "handoff_ready", `status=${statusOf(u3)} blockers=${JSON.stringify(blockers(u3))}`);
  });

  // A single-permit project is NOT held by a stray target: nothing in the app can deactivate or
  // delete one tracking target, so that rule would strand the handoff with no remedy but SQL.
  const c2 = portland("Combo Plus Stray Owner");
  const c2t = addTargets(c2, [
    { applicationNumber: "COMBO-2", permitType: "combo" },
    { applicationNumber: "STRAY-2" },
    { applicationNumber: "NEM-2", targetType: "nem", permitType: "nem" },
  ]);
  await read(c2, c2t["COMBO-2"], ISSUED);
  await read(c2, c2t["STRAY-2"], IN_REVIEW);
  await read(c2, c2t["NEM-2"], NEM_APPROVED);
  await check("2h. MUST PASS: a combo project with its tagged permit issued hands off despite a stray untagged target", () => {
    assert.equal(statusOf(c2), "handoff_ready", `status=${statusOf(c2)} blockers=${JSON.stringify(blockers(c2))}`);
  });

  const c1 = portland("Combo Untagged Owner");
  const c1t = addTargets(c1, [
    { applicationNumber: "COMBO-1" },
    { applicationNumber: "NEM-1", targetType: "nem", permitType: "nem" },
  ]);
  await read(c1, c1t["COMBO-1"], ISSUED);
  await read(c1, c1t["NEM-1"], NEM_APPROVED);
  await check("2e. MUST PASS: a single-permit (combo) project's one untagged target still finishes its track", () => {
    assert.equal(statusOf(c1), "handoff_ready", `status=${statusOf(c1)} blockers=${JSON.stringify(blockers(c1))}`);
  });

  // ═══ 3. EVER ISSUED, NO CORRECTION SINCE ═══════════════════════════════════════════════════
  const f1 = portland("Finaled Owner");
  const f1t = addTargets(f1, [
    { applicationNumber: "COMBO-F", permitType: "combo" },
    { applicationNumber: "NEM-F", targetType: "nem", permitType: "nem" },
  ]);
  await read(f1, f1t["COMBO-F"], ISSUED);
  await read(f1, f1t["COMBO-F"], "Record Status: Finaled");
  await check("fixture: the finaled reading classified away from 'issued'", () => {
    const t = db.get<Row>("SELECT latest_outcome FROM permit_check_targets WHERE id = ?", [f1t["COMBO-F"]]);
    assert.notEqual(String(t?.latest_outcome), "issued");
  });
  await check("3a. a permit that read issued and then 'Finaled' is still DONE (panel says combo:issued)", () => {
    assert.equal(isTrackDone(db, f1, "combo", ["nem", "combo"]), true);
    assert.ok(panel(f1).includes("combo:issued"), JSON.stringify(panel(f1)));
  });
  await read(f1, f1t["NEM-F"], NEM_APPROVED);
  await read(f1, f1t["NEM-F"], "Engineering Review");
  await check("3b. …and with NEM approved (then re-read in review) the project hands off", () => {
    assert.equal(statusOf(f1), "handoff_ready", `status=${statusOf(f1)} blockers=${JSON.stringify(blockers(f1))}`);
  });

  const x1 = portland("Corrected After Issue Owner");
  const x1t = addTargets(x1, [
    { applicationNumber: "COMBO-X", permitType: "combo" },
    { applicationNumber: "NEM-X", targetType: "nem", permitType: "nem" },
  ]);
  await read(x1, x1t["COMBO-X"], ISSUED);
  await read(x1, x1t["COMBO-X"], CORRECTION);
  await read(x1, x1t["COMBO-X"], IN_REVIEW);
  await check("3c. issued, THEN a correction, then in review: the track is NOT done", () => {
    assert.equal(isTrackDone(db, x1, "combo", ["nem", "combo"]), false);
  });
  await read(x1, x1t["COMBO-X"], ISSUED);
  await check("3d. MUST PASS: the same permit issued again after its correction is done again", () => {
    assert.equal(isTrackDone(db, x1, "combo", ["nem", "combo"]), true);
  });

  const r1 = portland("Fees Due Owner");
  const r1t = addTargets(r1, [
    { applicationNumber: "COMBO-R", permitType: "combo" },
    { applicationNumber: "NEM-R", targetType: "nem", permitType: "nem" },
  ]);
  await read(r1, r1t["COMBO-R"], "Approved pending payment. Permit is ready to issue; issuance fees are due.");
  await read(r1, r1t["COMBO-R"], IN_REVIEW);
  await read(r1, r1t["NEM-R"], NEM_APPROVED);
  await check("3e. ready_for_issue in the history is NOT issued — no handoff", () => {
    assert.equal(isTrackDone(db, r1, "combo", ["nem", "combo"]), false);
    assert.notEqual(statusOf(r1), "handoff_ready");
  });

  // ═══ 6. STAGED MEANWHILE → 409 ══════════════════════════════════════════════════════════════
  const client = createClient(db, {
    companyName: "Handoff Track Solar LLC", legalBusinessName: "Handoff Track Solar LLC",
    ccbLicenseNumber: "240137", electricalLicenseNumber: "C1236",
    businessEmail: "ops@handofftrack.test", businessPhone: "(503) 555-0144",
  });
  const FULL = {
    ...PORTLAND, account: "1234567890", meter: "987654321", exportKw: "6.5",
    moduleMake: "Qcells", moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20",
    invModel: "IQ8M", invQty: "20", invOutputW: "325", interco: "Load-side breaker", busRating: "200",
    mainBreaker: "200", pvBreaker: "40", permitPath: "PRESCRIPTIVE", roofRafterSpacing: "24", roofRafterSpan: "10",
    snow: "25", deadLoad: "3.2", wind: "B",
    locateCalloutText: "No locate-triggering scope found.",
    sitePlanNotesText: "Roof plan shows fire access pathway, ridge/eave setbacks, array dimensions, service equipment, and PV layout.",
    roofPlanNotesText: "Roof framing: 2x6 rafters at 24 inches on center, 10 ft clear span, roof slope 5:12. Racking attachment detail shows flashed standoffs lagged to rafters.",
    structuralCalcText: "Oregon prescriptive rooftop PV worksheet complete. Dead load 3.2 psf, ground snow 25 psf, wind exposure B, rafter span checked.",
    electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A. NEC 690.12 rapid shutdown shown.",
    labelsText: "PV label schedule includes rapid shutdown label, service power source directory, disconnect labels, and backfed breaker warning.",
    splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation and rapid shutdown: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
    utilityDownloadChecklistText: "PGE package includes SLD/3-line, site/plot plan, module spec, inverter spec, utility bill, meter data, and account data.",
    packetReadinessText: "READY - Plan set\nREADY - Utility bill\nREADY - Module spec\nREADY - Inverter spec",
  };
  const stageable = (owner: string): string => {
    const pid = R.createProject(db, { clientId: client.id, owner, ...FULL } as never).project.id;
    saveProjectDocument(db, pid, {
      docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n% handoff track plan set\n", "utf8"), source: "upload",
    });
    return pid;
  };
  const STAGED_READ = /FROM portal_runs[\s\S]*'awaiting_human_submit', 'submitted', 'paused_for_human'/;
  const racingView = (pid: string, track: string): { view: typeof db; reads: () => number } => {
    let reads = 0;
    const view = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return (sql: string, params?: unknown[]) => {
            const out = target.get(sql as never, params as never);
            // The FIRST staged read for this project+track is prepareSubmission's entry read: answer
            // it truthfully (nothing staged), then another run lands its row.
            if (STAGED_READ.test(sql) && Array.isArray(params) && params[0] === pid && params[1] === track && ++reads === 1) {
              target.run(
                `INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, error_message,
                   human_action_required, screenshots_path, logs_path, result_json, permit_type)
                 VALUES (?, ?, NULL, 'prepare_submit', 'awaiting_human_submit', ?, '', 0, '', '', '{}', ?)`,
                [`run-other-${pid}`, pid, new Date().toISOString(), track],
              );
            }
            return out;
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof db;
    return { view, reads: () => reads };
  };
  const refusal = async (fn: () => Promise<unknown>): Promise<{ status: number; message: string; details: Row } | null> => {
    try { await fn(); return null; }
    catch (err) { const e = err as { status?: number; message?: string; details?: Row }; return { status: Number(e.status ?? 0), message: String(e.message ?? ""), details: e.details ?? {} }; }
  };

  const m0 = stageable("Stage Control Owner");
  await check("6-fixture. MUST PASS: the stageable fixture stages the combo track on the mock portal", async () => {
    await R.prepareSubmission(db, m0, "combo", false, false);
    const run = db.get<Row>("SELECT status FROM portal_runs WHERE project_id = ? AND permit_type = 'combo'", [m0]);
    assert.equal(String(run?.status), "awaiting_human_submit");
  });

  const m1 = stageable("Staged Meanwhile Owner");
  const race = racingView(m1, "combo");
  const refused = await refusal(() => R.prepareSubmission(race.view, m1, "combo", false, false));
  await check("6a. a track staged by another run while this call was preparing is refused 409 before dispatch", () => {
    assert.ok(race.reads() >= 2, `prepareSubmission must re-read the staged state before dispatch (reads: ${race.reads()})`);
    assert.ok(refused, "prepareSubmission staged a second draft beside the one another run just staged");
    assert.equal(refused!.status, 409);
    assert.match(refused!.message, /staged to the portal by another run/);
    assert.match(refused!.message, /duplicate application/);
    assert.equal(refused!.details.track, "combo");
  });
  await check("6b. …and staged nothing: only the other run's portal_runs row exists", () => {
    const runs = db.query<Row>("SELECT id FROM portal_runs WHERE project_id = ?", [m1]);
    assert.deepEqual(runs.map((r) => String(r.id)), [`run-other-${m1}`]);
  });
  await check("6c. MUST PASS: an explicit re-stage of a track ALREADY staged at entry still goes", async () => {
    await R.prepareSubmission(db, m0, "combo", false, false);
    const runs = db.query<Row>("SELECT id FROM portal_runs WHERE project_id = ? AND permit_type = 'combo'", [m0]);
    assert.equal(runs.length, 2);
  });

  // ═══ 7. COLD-START RESEARCH PROVENANCE ════════════════════════════════════════════════════
  await check("7a. the portal.url_researched note says web-grounded / model memory / unknown — never guesses", () => {
    const web = R.researchedUrlProvenance(true);
    const memory = R.researchedUrlProvenance(false);
    const unknown = R.researchedUrlProvenance(undefined);
    assert.equal(web.provenance, "web_grounded");
    assert.match(web.note, /web-grounded/i);
    assert.equal(memory.provenance, "model_memory");
    assert.match(memory.note, /model memory/i);
    assert.doesNotMatch(memory.note, /web-grounded search/i);
    assert.equal(unknown.provenance, "unknown");
    assert.doesNotMatch(unknown.note, /found by a web-grounded/i);
  });
} finally {
  // Generated application PDFs land under <cwd>/backend/data/filled/<projectId> — the repo's
  // real data dir when run from the root. Remove this test's projects' folders so runs leave no trace.
  try {
    for (const row of db.query<{ id: string }>("SELECT id FROM projects")) {
      fs.rmSync(path.join(process.cwd(), "backend", "data", "filled", String(row.id)), { recursive: true, force: true });
    }
  } catch { /* cleanup is best-effort */ }
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(failures ? `\nhandoffTrackDone: ${failures} check(s) FAILED, ${passed} passed` : `\nhandoffTrackDone: all ${passed} checks passed`);
process.exit(failures ? 1 : 0);
