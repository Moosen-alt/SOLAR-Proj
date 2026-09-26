// A FINISHED FILING CLOSES THE CORRECTION IT ANSWERED (LNK-7).
//
// The only close for a correction was captureConfirmation (a resubmission going out) or the
// operator's /resolve, which no UI calls. A correction answered in the portal or by reply stayed
// open forever — overdue on the KPI, and a permanent handoff blocker on a project whose permit is
// issued (production: cb3cf605). When a monitor reading finishes a track (isTrackDone — issued /
// approved on its own kind of target, no correction since), the engine now closes what that
// finish answers, through resolveCorrection, with a system actor and a closed_on_terminal_status
// audit:
//   - a correction raised on a tracking target closes when THAT target's track is done;
//   - an unattributed correction closes only when EVERY required track is done and no active
//     target still reads correction_flagged.
// Drives the real path: createProject → createPermitCheckTarget → recordPermitStatusCheck.
// Run: npx tsx backend/test/correctionTerminalClose.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-terminal-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.CLIENT_NOTIFICATIONS = "off";
process.env.BACKGROUND_WORKERS = "off";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.AHJ_FORM_RESEARCH = "off";
process.env.FEE_RESEARCH = "off";
process.env.PORTAL_URL_RESEARCH = "off";
process.env.RUN_TRIAGE = "off";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { requiredTracks } = await import("../src/submittalTracks");
const db = await openDatabase();

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const { project } = R.createProject(db, {
  // WA, not OR: an Oregon ePermitting AHJ now files a STRUCTURAL + a separate ELECTRICAL permit (OAR
  // 918-050-0180(2), cited state rule, 2026-09-26) — this fixture needs a single combo-permit AHJ.
  owner: "Terminal Close", street: "1 Test St", city: "Closeville", state: "WA", zip: "98000",
  ahj: "Closeville", utility: "Pacific Power", dcKw: "5", acKw: "4",
} as never);
const pid = project.id;
check("SETUP: the project files NEM + one combo permit", JSON.stringify(requiredTracks(R.getProjectDetail(db, pid).project)) === JSON.stringify(["nem", "combo"]),
  JSON.stringify(requiredTracks(R.getProjectDetail(db, pid).project)));

const permit = R.createPermitCheckTarget(db, pid, { jurisdiction: "Closeville", applicationNumber: "APP-9", permitType: "combo" })
  .permitCheckTargets.find((t) => t.targetType === "permit")!;
const nem = R.createPermitCheckTarget(db, pid, { jurisdiction: "Pacific Power", applicationNumber: "NEM-9", targetType: "nem" })
  .permitCheckTargets.find((t) => t.targetType === "nem")!;
const read = (targetId: string, rawStatusText: string) => R.recordPermitStatusCheck(db, pid, { targetId, source: "manual", rawStatusText });
const openIds = () => new Set(db.query<{ id: string }>("SELECT id FROM corrections WHERE project_id = ? AND closed_at IS NULL", [pid]).map((r) => r.id));
const newestId = () => db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [pid])!.id;

await read(permit.id, "Review comments: correction required. Revise the fire setback pathway and resubmit.");
const onPermit = newestId();
R.addManualCorrection(db, pid, "Reviewer called: the account number on the application does not match the bill.");
const unattributed = newestId();
await read(nem.id, "Application returned: correction required, revise and resubmit the one-line.");
const onNem = newestId();
check("SETUP: three open corrections (permit, manual, NEM)", openIds().size === 3, String(openIds().size));

// ── the permit issues: ITS correction closes; the others do not ───────────────────────────────
await read(permit.id, "Permit issued. Download permit card.");
let open = openIds();
check("the permit's own correction closes when the permit track is done", !open.has(onPermit), JSON.stringify([...open]));
check("an unattributed correction stays open while another track is unfinished (and a target reads correction)", open.has(unattributed));
check("the NEM correction stays open — a permit issuing does not answer it", open.has(onNem));
const audit = db.get<{ actor_type: string; actor_name: string; details: string }>(
  "SELECT actor_type, actor_name, details FROM audit_logs WHERE project_id = ? AND action = 'correction.resolved' ORDER BY created_at ASC LIMIT 1", [pid],
);
check("closed by a SYSTEM actor, with the reason recorded", audit?.actor_type === "system" && audit?.actor_name === "permit monitor" && /closed_on_terminal_status/.test(String(audit?.details)),
  JSON.stringify(audit));
check("…and a closed_on_terminal_status audit entry", Boolean(db.get("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'correction.closed_on_terminal_status'", [pid])));
// One filing's good news does not clear another filing's correction (updateProjectForPermitOutcome),
// and closing the permit's correction must not move the project out of it either.
check("the project still reads the NEM correction (the close did not re-stage or rewind it)",
  R.getProjectDetail(db, pid).project.status === "correction_received", R.getProjectDetail(db, pid).project.status);

// ── the utility approves: every track done → the rest close, and the SAME reading hands off ──
await read(nem.id, "PTO granted. Permission to operate.");
open = openIds();
check("every correction is closed once every track is done", open.size === 0, JSON.stringify([...open]));
check("the same reading hands the project off (open corrections were the last blocker)", R.getProjectDetail(db, pid).project.status === "handoff_ready",
  R.getProjectDetail(db, pid).project.status);

// ── A CORRECTION ENTERED AFTER THE FINISH IS NOT ANSWERED BY THAT FINISH (skeptic PROBE A) ────
// The close is earned by a TRANSITION — a reading that takes a track from not-done to done — and
// only closes corrections that existed before that reading. A routine re-poll of an issued permit
// (or a blip through an unreadable page and back) finishes nothing: the correction an operator
// enters after handoff must stay open and keep the project out of handoff_ready.
R.addManualCorrection(db, pid, "Field inspection failed: the meter label is missing, revise and resubmit.");
const postHandoff = newestId();
check("SETUP: the post-handoff correction moves the project out of handoff_ready",
  R.getProjectDetail(db, pid).project.status !== "handoff_ready", R.getProjectDetail(db, pid).project.status);
await read(permit.id, "Permit issued. Download permit card.");
check("an UNCHANGED re-poll of the issued permit does not close a correction entered after the finish", openIds().has(postHandoff),
  JSON.stringify([...openIds()]));
check("…and the project does not snap back to handoff_ready", R.getProjectDetail(db, pid).project.status !== "handoff_ready",
  R.getProjectDetail(db, pid).project.status);
await read(nem.id, "PTO granted. Permission to operate.");
check("an unchanged re-poll of the approved NEM does not close it either", openIds().has(postHandoff), JSON.stringify([...openIds()]));
// A blip: the portal returns something unreadable, then "issued" again. The outcome changed, but
// the track was done before this reading and is done after it — nothing was finished.
await read(permit.id, "No status text available. Manual AHJ/utility portal check required.");
check("SETUP: the blip reading is not an issued reading",
  db.get<{ latest_outcome: string }>("SELECT latest_outcome FROM permit_check_targets WHERE id = ?", [permit.id])!.latest_outcome !== "issued");
await read(permit.id, "Permit issued. Download permit card.");
check("issued → unreadable → issued (no correction in between) does not close it", openIds().has(postHandoff), JSON.stringify([...openIds()]));
// The real re-finish: the permit reads a correction, then issues again. That reading takes the
// track from not-done to done, and the corrections that existed before it are answered.
await read(permit.id, "Review comments: correction required. Revise the meter label and resubmit.");
const reopened = newestId();
await read(permit.id, "Permit issued. Download permit card.");
open = openIds();
check("a re-issue after a new correction closes that correction", !open.has(reopened), JSON.stringify([...open]));
check("…and the earlier post-handoff correction with it (created before the finishing reading)", !open.has(postHandoff), JSON.stringify([...open]));
check("…and the project hands off again", R.getProjectDetail(db, pid).project.status === "handoff_ready", R.getProjectDetail(db, pid).project.status);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ncorrectionTerminalClose: all checks passed");
