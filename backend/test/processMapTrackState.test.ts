// THE PROCESS SUMMARY READS EACH FILING'S STATE, NOT THE LANE ROLLUP.
//
// The process map's headline ("PermitFlow waiting, NEMflow waiting") and the handoff packet's
// "PermitFlow: … | NEMflow: …" line were the lanes' rollup — "waiting" whenever ANY step waits
// (a staged run awaiting its human submit, a checklist gap). So a permit that was
// ready_for_issue (approved, fee due) read "waiting" (demo: Walt Brennan — building
// ready_for_issue, electrical and NEM in review). They now read the per-track state
// (getSubmittalTracks — isTrackDone and the latest reading per target): ready_for_issue is
// "fee due", never "waiting" and never "issued".
//
// Drives the real path: createProject → createPermitCheckTarget → recordPermitStatusCheck.
// Run: npx tsx backend/test/processMapTrackState.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "process-map-track-"));
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
  owner: "Track Words", street: "1 Test St", city: "Wordville", state: "WA", zip: "98000",
  ahj: "Wordville", utility: "Pacific Power", dcKw: "5", acKw: "4",
} as never);
const pid = project.id;
check("SETUP: NEM + one combo permit", JSON.stringify(requiredTracks(R.getProjectDetail(db, pid).project)) === JSON.stringify(["nem", "combo"]));
const permit = R.createPermitCheckTarget(db, pid, { jurisdiction: "Wordville", applicationNumber: "APP-W", permitType: "combo" })
  .permitCheckTargets.find((t) => t.targetType === "permit")!;
const nem = R.createPermitCheckTarget(db, pid, { jurisdiction: "Pacific Power", applicationNumber: "NEM-W", targetType: "nem" })
  .permitCheckTargets.find((t) => t.targetType === "nem")!;
await R.recordPermitStatusCheck(db, pid, { targetId: permit.id, source: "manual", rawStatusText: "Plan review in progress." });
await R.recordPermitStatusCheck(db, pid, { targetId: permit.id, source: "manual", rawStatusText: "Pre-issuance complete. Permit is ready to issue and fees are due." });
await R.recordPermitStatusCheck(db, pid, { targetId: nem.id, source: "manual", rawStatusText: "Application received. Engineering review in progress." });
// A staged run awaiting its human submit — the lane rollup reads waiting/blocked, never the permit.
db.run(
  `INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, error_message, human_action_required, screenshots_path, logs_path, result_json, permit_type)
   VALUES ('run-w1', ?, NULL, 'prepare_submit', 'awaiting_human_submit', ?, '', 0, '', '', '{}', 'nem')`,
  [pid, new Date().toISOString()],
);
check("SETUP: the permit reads ready_for_issue", R.getProjectDetail(db, pid).project.status === "ready_for_issue", R.getProjectDetail(db, pid).project.status);

const map = R.getProjectProcessMap(db, pid);
check("SETUP: the permit LANE rollup is not the permit's state (the old, wrong source)", map.permitStatus !== "done", map.permitStatus);
check("the headline says the permit's fee is due", /PermitFlow fee due/.test(map.headline), map.headline);
check("MUST EXCLUDE: the headline never states a lane rollup (waiting / blocked / …) for a ready_for_issue permit", !/PermitFlow (waiting|blocked|in progress|not started|done)/i.test(map.headline), map.headline);
check("the NEM side reads in review", /NEMflow in review/.test(map.headline), map.headline);
check("the copyable report carries the same headline", map.reportText.includes(map.headline));

const packet = R.getProjectHandoffPacket(db, pid);
const line = packet.sections.flatMap((s) => s.lines).find((l) => /^PermitFlow: /.test(l)) ?? "";
check("the handoff packet's snapshot line reads the per-track state", line === "PermitFlow: fee due | NEMflow: in review", line);

// The words, per track — several permit tracks are named one by one; NEM "issued" is "approved".
const words = R.trackStateSummary([
  { type: "nem", category: "utility", status: "issued" },
  { type: "building", category: "permit", status: "ready_for_issue" },
  { type: "electrical", category: "permit", status: "in_review" },
]);
check("multi-permit: each permit is named with its own state", words.permit === "building fee due, electrical in review", words.permit);
check("an approved NEM reads approved, not issued", words.nem === "approved", words.nem);
check("no NEM track reads not required", R.trackStateSummary([{ type: "combo", category: "permit", status: "issued" }]).nem === "not required");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nprocessMapTrackState: all checks passed");
