// THE TWO OPERATOR DECISIONS OF 2026-09-26 ON APPROVAL READINGS — D1 and D2.
//
//   D1 "should the with-conditions case get its own label? Yes, for both." — a permit OR an
//      interconnection application marked "approved with conditions" / "conditional approval" gets
//      its OWN stored label and its own client wording on every client-facing surface, instead of
//      being folded into "Reviewed by the jurisdiction" / "Reviewed by the utility". The project's
//      hero headline is unchanged (no new ProjectStatus).
//   D2 (a utility "Approved" showing grey as "Reviewed by the utility" — count as approved?)
//      "Yes" — on a NEM target a reading that says approved IS the interconnection approval:
//      outcome nem_approved (client-facing, finishes the NEM track, feeds the handoff). On a PERMIT
//      target "Approved" stays reviewed_by_ahj -> project 'approved', as before.
//
// ONE QUESTION, ONE PREDICATE: classifyPermitStatusText takes the target's track (REQUIRED), the
// writer passes trackKind(target_type, permit_type), and the drift pass judges with the same kind.
// isNemApprovalOutcome is the one "is this NEM target approved" answer.
//
// MUST-EXCLUDE, both directions, through the production write (recordPermitStatusCheck on a real
// scratch DB): a PERMIT target reading "Approved" never writes nem_approved and never finishes the
// NEM track; a NEM target reading "Approved" never writes project 'approved', 'ready_for_issue' or
// 'issued'.
//
// KILLS (each makes a check red): remove the conditionalApprovalPattern branch -> (d1); drop the
// NEM mapping in the reviewedPattern branch -> (d2); judge drift as "permit" for every row -> (drift).
//   npx tsx backend/test/withConditionsApproval.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "with-conditions-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { classifyPermitStatusText, classificationDrift, isNemApprovalOutcome, trackKind, staleStatusClassifications } = await import("../src/permitMonitor");
const { publicCheckLabel, publicProjectStatusPayload, projectStatusHistory } = await import("../src/clientPortal");
const { isTrackDone, requiredTracks } = await import("../src/submittalTracks");
const { isClientFacingOutcome } = await import("../src/clientUpdates");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const accela = (status: string): string =>
  `Record 187-26-000999-STR: Residential Structural Record Status: ${status} Expiration Date: 03/16/2027 `
  + "Record Info/Schedule Inspections Payments Conditions Processing Status Loading... Loading...";

// ---------------------------------------------------------------------------------------------
// 1. THE CLASSIFIER, both tracks.
// ---------------------------------------------------------------------------------------------
await check("(d1) with-conditions gets its OWN label on both tracks; the outcome is the track's approval", () => {
  for (const s of ["Approved with Conditions", "Conditional Approval", "Conditionally Approved", "approved with conditions - see attached"]) {
    const p = classifyPermitStatusText(accela(s), "permit");
    assert.deepEqual([p.outcome, p.statusLabel], ["reviewed_by_ahj", "Approved with conditions"], `permit "${s}" -> ${p.outcome} / ${p.statusLabel}`);
    const n = classifyPermitStatusText(accela(s), "nem");
    assert.deepEqual([n.outcome, n.statusLabel], ["nem_approved", "Interconnection approved with conditions"], `nem "${s}" -> ${n.outcome} / ${n.statusLabel}`);
    assert.ok(isNemApprovalOutcome(n.outcome));
    assert.match(n.message, /conditions/i);
    assert.match(p.message, /conditions/i);
  }
});

await check("(d2) a NEM target's plain 'Approved' / 'review complete' IS the interconnection approval; a permit's stays reviewed_by_ahj", () => {
  for (const s of ["Approved", "Review Complete", "Application Approved", "Reviewed and approved"]) {
    const n = classifyPermitStatusText(accela(s), "nem");
    assert.deepEqual([n.outcome, n.statusLabel], ["nem_approved", "NEM / interconnection approved"], `nem "${s}" -> ${n.outcome} / ${n.statusLabel}`);
    const p = classifyPermitStatusText(accela(s), "permit");
    assert.deepEqual([p.outcome, p.statusLabel], ["reviewed_by_ahj", "Reviewed by AHJ"], `permit "${s}" -> ${p.outcome} / ${p.statusLabel}`);
  }
  // Prose without a stated status, as an email or a PowerClerk page reads.
  const prose = classifyPermitStatusText("The generation system design for project APP-1 has been approved according to customer generation metering rules.", "nem");
  assert.equal(prose.outcome, "nem_approved");
});

await check("MUST EXCLUDE: the neighbouring readings keep their verdicts on both tracks", () => {
  const expected: Array<[string, string, string, string]> = [
    // status, nem outcome, permit outcome, note
    ["Not Approved", "correction_flagged", "correction_flagged", "a refusal is a correction, whatever the track"],
    ["Approved pending payment", "ready_for_issue", "ready_for_issue", "fees due wins over approved"],
    ["In Review", "waiting", "waiting", "still in review"],
    ["Intake Requirements Needed", "needs_human_review", "needs_human_review", "waiting on us"],
    ["Permit Issued", "issued", "issued", "issued family is not track-dependent here"],
    ["PTO Granted", "nem_approved", "nem_approved", "the explicit NEM wording was already an approval on either kind"],
  ];
  for (const [s, nemOutcome, permitOutcome, why] of expected) {
    assert.equal(classifyPermitStatusText(accela(s), "nem").outcome, nemOutcome, `nem "${s}": ${why}`);
    assert.equal(classifyPermitStatusText(accela(s), "permit").outcome, permitOutcome, `permit "${s}": ${why}`);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. THE CLIENT WORDING — the stored keys are matching keys; the new ones have their own words.
// ---------------------------------------------------------------------------------------------
await check("(d1 wording) every surface words the with-conditions case on its own, never as 'Reviewed by …'", () => {
  const permit = publicCheckLabel("reviewed_by_ahj", "Approved with conditions", "permit");
  assert.equal(permit, "Approved by the jurisdiction — with conditions");
  const nem = publicCheckLabel("nem_approved", "Interconnection approved with conditions", "nem");
  assert.equal(nem, "Interconnection approved — with conditions");
  // A legacy NEM row (classified before the track-aware rules) still words as the utility's.
  const legacy = publicCheckLabel("reviewed_by_ahj", "Approved with conditions", "nem");
  assert.match(legacy, /utility.*with conditions/i);
  assert.doesNotMatch(legacy, /jurisdiction/i);
  for (const w of [permit, nem, legacy]) {
    assert.doesNotMatch(w, /^Reviewed by/i, `folded into 'Reviewed by': ${w}`);
    assert.doesNotMatch(w, /\bAHJ\b|flagged|human review/i, `jargon: ${w}`);
  }
  // The plain approvals keep their words.
  assert.equal(publicCheckLabel("nem_approved", "NEM / interconnection approved", "nem"), "Interconnection approved");
  assert.equal(publicCheckLabel("reviewed_by_ahj", "Reviewed by AHJ", "permit"), "Reviewed by the jurisdiction");
  assert.ok(isClientFacingOutcome("nem_approved"), "the utility's approval is told to the client");
});

// ---------------------------------------------------------------------------------------------
// 3. THROUGH THE PRODUCTION WRITE — must-exclude both directions.
// ---------------------------------------------------------------------------------------------
const mkProject = (name: string): string => R.createProject(db, {
  owner: name, state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
  street: "1 Test Way", city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
} as never).project.id;
const targetIds = (detail: unknown): Array<{ id: string; targetType: string; permitType: string }> =>
  (detail as { permitCheckTargets: Array<{ id: string; targetType: string; permitType: string }> }).permitCheckTargets;
const mkPermitTarget = (pid: string): string => {
  const d = R.createPermitCheckTarget(db, pid, {
    jurisdiction: "City of Coos Bay", portalName: "Oregon ePermitting (Accela)",
    portalUrl: "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx",
    applicationNumber: `187-26-${Math.floor(Math.random() * 1e6)}-STR`, permitType: "building", targetType: "permit",
  } as never);
  return targetIds(d).find((t) => t.targetType === "permit")!.id;
};
const mkNemTarget = (pid: string): string => {
  const d = R.createPermitCheckTarget(db, pid, {
    jurisdiction: "Pacific Power", portalName: "Pacific Power NEM portal (PowerClerk)",
    portalUrl: "", applicationNumber: `APP-${Math.floor(Math.random() * 1e6)}`, permitType: "nem", targetType: "nem",
  } as never);
  return targetIds(d).find((t) => t.targetType === "nem")!.id;
};
const targetRow = (tid: string) => db.get<{ latest_outcome: string; latest_status_label: string }>("SELECT latest_outcome, latest_status_label FROM permit_check_targets WHERE id = ?", [tid])!;
const projectStatus = (pid: string): string => String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])!.status);
const anyNemApprovedRow = (pid: string): number => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_status_checks WHERE project_id = ? AND outcome = 'nem_approved'", [pid])?.n ?? 0);

await check("MUST EXCLUDE (permit): a PERMIT target reading 'Approved' never writes nem_approved and never finishes the NEM track", async () => {
  const pid = mkProject("Permit Approved Owner");
  const permitTid = mkPermitTarget(pid);
  const nemTid = mkNemTarget(pid);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: permitTid, source: "manual", rawStatusText: accela("Approved") });
  assert.deepEqual([targetRow(permitTid).latest_outcome, targetRow(permitTid).latest_status_label], ["reviewed_by_ahj", "Reviewed by AHJ"]);
  assert.equal(projectStatus(pid), "approved", "a permit's Approved is plan review done -> project approved, as before");
  assert.equal(anyNemApprovedRow(pid), 0, "a permit reading wrote nem_approved");
  const project = R.getProjectDetail(db, pid).project;
  const required = requiredTracks(project);
  assert.equal(isTrackDone(db, pid, "nem", required), false, "the NEM track was finished by a permit reading");
  assert.ok(!targetRow(nemTid).latest_outcome, `the NEM target was written by the permit reading: ${targetRow(nemTid).latest_outcome}`);
  assert.ok(R.handoffBlockers(db, project).some((b) => /nem track not done/.test(b)), `handoff blockers: ${R.handoffBlockers(db, project).join("; ")}`);
});

await check("MUST EXCLUDE (nem): a NEM target reading 'Approved' becomes nem_approved and never writes project approved / ready_for_issue / issued", async () => {
  const pid = mkProject("Nem Approved Owner");
  mkPermitTarget(pid);
  const nemTid = mkNemTarget(pid);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: nemTid, source: "manual", rawStatusText: "Project Status: Approved. Application APP-1 approved by the utility's engineering team." });
  assert.deepEqual([targetRow(nemTid).latest_outcome, targetRow(nemTid).latest_status_label], ["nem_approved", "NEM / interconnection approved"]);
  assert.equal(projectStatus(pid), "nem_approved", "the utility's approval is the NEM outcome, not a permit status");
  assert.ok(!["approved", "ready_for_issue", "issued"].includes(projectStatus(pid)));
  const project = R.getProjectDetail(db, pid).project;
  const required = requiredTracks(project);
  assert.equal(isTrackDone(db, pid, "nem", required), true, "the NEM track did not finish on the utility's approval");
  for (const t of required.filter((x) => x !== "nem")) assert.equal(isTrackDone(db, pid, t, required), false, `${t} track finished by a NEM reading`);
  assert.ok(R.handoffBlockers(db, project).length > 0, "the project handed off on the NEM approval alone");
  // And the lane summary / process map read it as approved through the one predicate.
  assert.equal(R.computeLaneStatusSummary("submitted", R.getProjectDetail(db, pid).permitStatusChecks, []).nemApproved, true);
});

await check("(d1 through the write) with-conditions on both tracks reaches the public page and the history with its own words", async () => {
  const pid = mkProject("Conditions Owner");
  const permitTid = mkPermitTarget(pid);
  const nemTid = mkNemTarget(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: permitTid, source: "manual", rawStatusText: accela("Approved with Conditions") });
  await R.recordPermitStatusCheck(db, pid, { targetId: nemTid, source: "manual", rawStatusText: "Status: Approved with conditions. See conditions of approval." });
  assert.equal(targetRow(permitTid).latest_status_label, "Approved with conditions");
  assert.equal(targetRow(nemTid).latest_status_label, "Interconnection approved with conditions");
  assert.equal(targetRow(nemTid).latest_outcome, "nem_approved");
  const token = "tok-" + pid.slice(0, 8);
  db.run("UPDATE projects SET status_share_token = ? WHERE id = ?", [token, pid]);
  const page = publicProjectStatusPayload(db, token)!;
  const byType = new Map(page.tracks.map((t) => [t.type, t.statusLabel]));
  assert.equal(byType.get("permit"), "Approved by the jurisdiction — with conditions");
  assert.equal(byType.get("nem"), "Interconnection approved — with conditions");
  const history = projectStatusHistory(db, pid).map((h) => h.statusLabel);
  assert.ok(history.includes("Approved by the jurisdiction — with conditions"), `history: ${history.join(" / ")}`);
  assert.ok(history.includes("Interconnection approved — with conditions"), `history: ${history.join(" / ")}`);
  for (const w of [...page.tracks.map((t) => t.statusLabel), ...history]) assert.doesNotMatch(w, /^Reviewed by/i, `folded: ${w}`);
  // The hero headline is untouched: no new ProjectStatus was introduced.
  assert.ok(["approved", "nem_approved"].includes(page.project.status), page.project.status);
});

// ---------------------------------------------------------------------------------------------
// 4. DRIFT JUDGES WITH THE TARGET'S KIND — the writer's kind, never a default.
// ---------------------------------------------------------------------------------------------
await check("(drift) a stored NEM 'Reviewed by AHJ' on approved text is stale as a NEM row and current as a permit row", async () => {
  const stored = { outcome: "reviewed_by_ahj", statusLabel: "Reviewed by AHJ", rawStatusText: accela("Approved") };
  assert.equal(classificationDrift(stored, "nem").stale, true);
  assert.equal(classificationDrift(stored, "nem").currentOutcome, "nem_approved");
  assert.equal(classificationDrift(stored, "permit").stale, false);
  // And the stale scan reads the kind off the target row: a legacy blank target_type with
  // permit_type 'nem' is the NEM filing it is.
  assert.equal(trackKind("", "nem"), "nem");
  const pid = mkProject("Drift Owner");
  const nemTid = mkNemTarget(pid);
  const permitTid = mkPermitTarget(pid);
  const ts = "2026-09-21T19:39:42.696Z";
  for (const [tid, tag] of [[nemTid, "n"], [permitTid, "p"]] as const) {
    db.run(
      `INSERT INTO permit_status_checks (id, project_id, target_id, source, raw_status_text, status_label, outcome, confidence,
         correction_id, reviewed_by_ahj, ready_for_issue, issue_fee_due, application_number, permit_number, message, created_at)
       VALUES (?, ?, ?, 'manual', ?, 'Reviewed by AHJ', 'reviewed_by_ahj', 0.82, NULL, 1, 0, 0, '', '', 'old rules', ?)`,
      [`stale-${tag}-${tid}`, pid, tid, accela("Approved"), ts],
    );
    db.run("UPDATE permit_check_targets SET latest_outcome = 'reviewed_by_ahj', latest_status_label = 'Reviewed by AHJ', last_checked_at = ? WHERE id = ?", [ts, tid]);
  }
  const stale = staleStatusClassifications(db, [pid]);
  assert.deepEqual(stale.map((s) => s.targetId), [nemTid], `stale: ${stale.map((s) => `${s.targetType}:${s.currentOutcome}`).join(",")}`);
  assert.equal(stale[0].currentOutcome, "nem_approved");
});

if (failures) { console.error(`\n${failures} with-conditions / NEM-approval test(s) failed.`); process.exit(1); }
console.log("\nAll with-conditions / NEM-approval tests passed.");
