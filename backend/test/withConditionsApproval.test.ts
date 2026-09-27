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
//
// THE SKEPTIC'S MUST-FIXES (decisions-0926-close), sections 5-7 below:
//   MF2 the lane's second "is NEM approved" predicate (project 'approved') is gone;
//   MF3 the writer answers "what track is this target" ONE way (trackKind) everywhere downstream —
//       both legacy shapes MUST-EXCLUDE through the real writer, the creator never writes them;
//   MF1 the email tracker files on the email's OWN track's target, with a defined no-target
//       fallback — through the real runEmailTracker, both directions.
// Kills for those: .probe/decisions-0926-close/kill.cjs (email filing back to "newest target";
// the fallback ignoring the email's track; the 'approved' clause restored; raw target_type back
// in the project-status writer / outcomeFinishesTrack / the check-row mapping / otherTrackOutcome;
// the creator's normalisation dropped).
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
const { isTrackDone, requiredTracks, ensureCheckTarget } = await import("../src/submittalTracks");
const { isClientFacingOutcome, clientUpdateFor } = await import("../src/clientUpdates");

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

// ---------------------------------------------------------------------------------------------
// 5. MF2 (decisions-0926 skeptic): "is NEM approved?" has ONE predicate. computeLaneStatusSummary
//    counted projectStatus === 'approved' — a status only a PERMIT reading writes — as nemApproved,
//    so a permit's "Approved" badged the board "NEM approved".
// ---------------------------------------------------------------------------------------------
await check("MF2: a permit's plan-review approval (project 'approved') is NOT the NEM lane's approval", async () => {
  assert.equal(R.computeLaneStatusSummary("approved", [], []).nemApproved, false, "project 'approved' alone read as NEM approved");
  const pid = mkProject("Lane Approved Owner");
  const permitTid = mkPermitTarget(pid);
  mkNemTarget(pid);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  for (const s of ["Approved", "Approved with Conditions"]) {
    await R.recordPermitStatusCheck(db, pid, { targetId: permitTid, source: "manual", rawStatusText: accela(s) });
    assert.equal(projectStatus(pid), "approved");
    const detail = R.getProjectDetail(db, pid);
    const lane = R.computeLaneStatusSummary(detail.project.status, detail.permitStatusChecks, detail.emailProjectMatches);
    assert.equal(lane.nemApproved, false, `permit "${s}" -> laneNemApproved true`);
    assert.equal(lane.readyForIssue, false);
  }
  // The NEM lane still answers through its own reading (isNemApprovalOutcome on a NEM check).
  assert.equal(R.computeLaneStatusSummary("submitted", [{ ...R.getProjectDetail(db, pid).permitStatusChecks[0], targetType: "nem", outcome: "nem_approved" }], []).nemApproved, true);
});

// ---------------------------------------------------------------------------------------------
// 6. MF3 (decisions-0926 skeptic): the writer answers "what track is this target?" ONE way —
//    trackKind — everywhere downstream (project status, track finish, lane, client wording), so
//    the two legacy shapes (target_type 'permit' + permit_type 'nem'; target_type '' + permit_type
//    'nem') are the NEM filings they are, and a blank-typed permit is a permit. Both shapes are
//    forced with raw SQL: the one creator (ensureCheckTarget) no longer writes them.
// ---------------------------------------------------------------------------------------------
const rawTarget = (tid: string) => db.get<{ target_type: string; permit_type: string; latest_outcome: string }>("SELECT target_type, permit_type, latest_outcome FROM permit_check_targets WHERE id = ?", [tid])!;
const laneOf = (pid: string) => {
  const detail = R.getProjectDetail(db, pid);
  const required = requiredTracks(detail.project);
  return R.computeLaneStatusSummary(detail.project.status, detail.permitStatusChecks, detail.emailProjectMatches, {
    permit: required.filter((t) => t !== "nem").some((t) => isTrackDone(db, pid, t, required)),
    nem: isTrackDone(db, pid, "nem", required),
  });
};

await check("MF3 (creator): a target born with permitType 'nem' and no target type IS typed nem", () => {
  const pid = mkProject("Born Nem Owner");
  const d = R.createPermitCheckTarget(db, pid, { jurisdiction: "Pacific Power", portalName: "PowerClerk", portalUrl: "", applicationNumber: "APP-BORN-1", permitType: "nem" } as never);
  const t = targetIds(d).find((x) => x.permitType === "nem")!;
  assert.equal(t.targetType, "nem");
  assert.equal(rawTarget(t.id).target_type, "nem", "the split shape (permit + nem) was written by the API door");
  // The door's own rule-5 check judges by the same kind: this NEM filing's PowerClerk URL is
  // accepted (it used to be refused as "a utility portal on a permit"), and the row is nem.
  const POWERCLERK = "https://pacificorpnetmetering.powerclerk.com/MvcProjects/ProjectDetails";
  const pid2 = mkProject("Born Nem Url Owner");
  const d2 = R.createPermitCheckTarget(db, pid2, { jurisdiction: "Pacific Power", portalName: "PowerClerk", portalUrl: POWERCLERK, applicationNumber: "APP-BORN-2", permitType: "nem" } as never);
  const t2 = targetIds(d2).find((x) => x.permitType === "nem")!;
  assert.equal(rawTarget(t2.id).target_type, "nem");
  // And a PERMIT filing is still refused that URL (permitTargetDoors pins the message).
  assert.throws(() => R.createPermitCheckTarget(db, pid2, { jurisdiction: "X", portalName: "Y", portalUrl: POWERCLERK, applicationNumber: "APP-BORN-3", permitType: "building", targetType: "permit" } as never), /utility interconnection portal/);
  // THE ONE CREATOR itself (every door passes through it): the split shape handed straight to it
  // is still stored as the NEM filing it is.
  const pid3 = mkProject("Born Nem Creator Owner");
  const born = ensureCheckTarget(db, R.getProjectDetail(db, pid3).project, { targetType: "permit", permitType: "nem", applicationNumber: "APP-BORN-4" });
  assert.equal(born.created, true);
  assert.equal(rawTarget(born.targetId).target_type, "nem", "the creator wrote the split shape (permit + nem)");
});

for (const shape of ["permit", ""] as const) {
  await check(`MUST EXCLUDE (legacy NEM shape target_type '${shape}' + permit_type 'nem'): never writes a permit status; its approval finishes the NEM track`, async () => {
    const pid = mkProject(`Legacy ${shape || "blank"} Nem Owner`);
    mkPermitTarget(pid);
    const nemTid = mkNemTarget(pid);
    db.run("UPDATE permit_check_targets SET target_type = ? WHERE id = ?", [shape, nemTid]);
    db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
    assert.equal(trackKind(rawTarget(nemTid).target_type, rawTarget(nemTid).permit_type), "nem");

    await R.recordPermitStatusCheck(db, pid, { targetId: nemTid, source: "manual", rawStatusText: accela("Approved") });
    assert.deepEqual([rawTarget(nemTid).latest_outcome, targetRow(nemTid).latest_status_label], ["nem_approved", "NEM / interconnection approved"]);
    assert.equal(projectStatus(pid), "nem_approved", "the utility's approval on a legacy-typed NEM target did not reach the project");
    const project = R.getProjectDetail(db, pid).project;
    const required = requiredTracks(project);
    assert.equal(isTrackDone(db, pid, "nem", required), true, "the NEM track did not finish on the legacy-typed target's approval");
    for (const t of required.filter((x) => x !== "nem")) assert.equal(isTrackDone(db, pid, t, required), false, `${t} finished by a NEM reading`);
    assert.equal(laneOf(pid).nemApproved, true, "the lane (through the check row's joined kind) did not read the approval");
    assert.equal(laneOf(pid).readyForIssue, false);
    // The check row ALONE (no project status, no track verdict) puts the reading on the NEM lane:
    // the JOINed target's kind (trackKind), not raw target_type, is what hasNemSignal reads.
    const bare = R.computeLaneStatusSummary("submitted", R.getProjectDetail(db, pid).permitStatusChecks, []);
    assert.equal(bare.nemApproved, true, "the check row's kind did not reach the NEM lane");
    assert.equal(bare.latestNemOutcome, "nem_approved", `NEM lane: ${bare.latestNemOutcome}`);
    assert.notEqual(bare.latestPermitOutcome, "nem_approved", "the utility's approval was read on the PERMIT lane");
    assert.ok(R.handoffBlockers(db, project).some((b) => /track not done/.test(b) && !/nem/.test(b)), R.handoffBlockers(db, project).join("; "));
    // The public page's NEM track says approved, and the permit track does not.
    const token = "tok-" + pid.slice(0, 8);
    db.run("UPDATE projects SET status_share_token = ? WHERE id = ?", [token, pid]);
    const page = publicProjectStatusPayload(db, token)!;
    const byType = new Map(page.tracks.map((t) => [t.type, t.statusLabel]));
    assert.match(String(byType.get("nem")), /Interconnection approved/i, `nem track: ${byType.get("nem")}`);
    assert.doesNotMatch(String(byType.get("permit") || ""), /approved|issued/i, `permit track: ${byType.get("permit")}`);

    // Permit statuses never come from this filing, whatever its text says.
    for (const [s, forbidden] of [["Permit Issued", "issued"], ["Approved pending payment", "ready_for_issue"]] as const) {
      await R.recordPermitStatusCheck(db, pid, { targetId: nemTid, source: "manual", rawStatusText: accela(s) });
      assert.notEqual(projectStatus(pid), forbidden, `a NEM filing reading "${s}" wrote project '${forbidden}'`);
      assert.equal(projectStatus(pid), "nem_approved");
      for (const t of required.filter((x) => x !== "nem")) assert.equal(isTrackDone(db, pid, t, required), false, `${t} finished by a NEM reading "${s}"`);
    }
  });
}

await check("MUST EXCLUDE (legacy permit shape target_type '' + permit_type 'building'): 'Approved' is plan review, never the NEM approval", async () => {
  const pid = mkProject("Legacy Blank Permit Owner");
  const permitTid = mkPermitTarget(pid);
  const nemTid = mkNemTarget(pid);
  db.run("UPDATE permit_check_targets SET target_type = '' WHERE id = ?", [permitTid]);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: permitTid, source: "manual", rawStatusText: accela("Approved") });
  assert.equal(rawTarget(permitTid).latest_outcome, "reviewed_by_ahj");
  assert.equal(projectStatus(pid), "approved");
  assert.equal(anyNemApprovedRow(pid), 0);
  const project = R.getProjectDetail(db, pid).project;
  assert.equal(isTrackDone(db, pid, "nem", requiredTracks(project)), false);
  assert.equal(laneOf(pid).nemApproved, false, "a blank-typed permit's approval read as the NEM lane's");
  assert.ok(!rawTarget(nemTid).latest_outcome);
  // Its issuance finishes the permit track (a blank-typed permit is still a permit).
  await R.recordPermitStatusCheck(db, pid, { targetId: permitTid, source: "manual", rawStatusText: "Record Status: Issued. Permit issued 09/09/2026. Download permit card." });
  assert.equal(projectStatus(pid), "issued");
  const required = requiredTracks(project);
  assert.ok(required.filter((x) => x !== "nem").some((t) => isTrackDone(db, pid, t, required)), "the blank-typed permit's issuance finished no permit track");
});

await check("MUST INCLUDE (fully blank legacy target '' + ''): a permit, drawn on by the single permit track's pool; its issuance finishes it", async () => {
  // A combo-structure AHJ (unknown in ID -> one combo track), so the one untagged target is the pool.
  const pid = R.createProject(db, {
    owner: "Blank Pool Owner", state: "ID", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
    street: "1 Pool Way", city: "Boise", zip: "83702", ahj: "City of Nowhere", utility: "Idaho Power",
  } as never).project.id;
  const project = R.getProjectDetail(db, pid).project;
  const required = requiredTracks(project);
  assert.deepEqual(required.filter((t) => t !== "nem"), ["combo"], `setup: ${required.join(",")}`);
  const d = R.createPermitCheckTarget(db, pid, { jurisdiction: "City of Nowhere", portalName: "X", portalUrl: "", applicationNumber: "BLANK-1", permitType: "building", targetType: "permit" } as never);
  const tid = targetIds(d).find((t) => t.permitType === "building")!.id;
  db.run("UPDATE permit_check_targets SET target_type = '', permit_type = '' WHERE id = ?", [tid]);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "manual", rawStatusText: "Record Status: Issued. Permit issued 09/09/2026. Download permit card." });
  assert.equal(projectStatus(pid), "issued");
  assert.equal(isTrackDone(db, pid, "combo", required), true, "the blank/blank target did not reach the permit track's pool");
  assert.equal(isTrackDone(db, pid, "nem", required), false);
});

await check("MF3 (client wording): the other track is found by kind — a legacy-typed NEM filing still in review keeps 'That clears the permit side.'", async () => {
  const pid = mkProject("Other Track Owner");
  const permitTid = mkPermitTarget(pid);
  const nemTid = mkNemTarget(pid);
  db.run("UPDATE permit_check_targets SET target_type = 'permit' WHERE id = ?", [nemTid]);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: nemTid, source: "manual", rawStatusText: "Project Status: In Review" });
  assert.equal(rawTarget(nemTid).latest_outcome, "waiting");
  await R.recordPermitStatusCheck(db, pid, { targetId: permitTid, source: "manual", rawStatusText: "Record Status: Issued. Permit issued 09/09/2026. Download permit card." });
  const project = R.getProjectDetail(db, pid).project;
  const update = clientUpdateFor(db, project, "issued", { targetType: "permit", permitType: "building" })!;
  assert.equal(update.meaning, "That clears the permit side.", `wording: ${update.meaning}`);
  assert.match(update.action, /interconnection|utility/i, update.action);
});

// ---------------------------------------------------------------------------------------------
// 7. MF1 (decisions-0926 skeptic): the email tracker files an inbound email on the target of the
//    email's OWN track — never "the project's newest target, whoever sent it". Through the real
//    runEmailTracker -> recordPermitStatusCheck, both directions, plus the two fallbacks (no
//    target of that kind; a workflow naming no single track), which never touch the other track.
// ---------------------------------------------------------------------------------------------
const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), "with-conditions-mail-"));
let mailSeq = 0;
const deliver = async (subject: string, body: string): Promise<Awaited<ReturnType<typeof R.runEmailTracker>>> => {
  const file = path.join(mailDir, `m${++mailSeq}.mbox`);
  fs.writeFileSync(file, `From sender@example.gov Wed Jun 17 10:0${mailSeq}:00 2026\nSubject: ${subject}\nDate: Wed, 17 Jun 2026 10:0${mailSeq}:00 -0700\n\n${body}\n`);
  const label = `m${mailSeq}.mbox`;
  const configured = R.configureEmailTrackingSource(db, { filePath: file, label });
  const source = configured.sources.find((s) => s.label === label)!;
  return R.runEmailTracker(db, { sourceId: source.id });
};
const checksOn = (tid: string | null, pid: string) => db.query<{ outcome: string; target_id: string | null }>(
  tid ? "SELECT outcome, target_id FROM permit_status_checks WHERE target_id = ?" : "SELECT outcome, target_id FROM permit_status_checks WHERE project_id = ? AND target_id IS NULL",
  [tid ?? pid],
);
const mkMailProject = (owner: string, street: string): string => R.createProject(db, {
  owner, state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
  street, city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
} as never).project.id;
const pause = () => new Promise((r) => setTimeout(r, 15)); // created_at order between targets

await check("MF1 (permit email): filed on the PERMIT target although the NEM target is newer; the NEM track is untouched", async () => {
  const pid = mkMailProject("Wynema Probe", "77 Harbor View Rd");
  const permitTid = mkPermitTarget(pid);
  await pause();
  const nemTid = mkNemTarget(pid);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  const run = await deliver(
    "City of Coos Bay building permit application 187-26-000123-STR",
    "Plan review for the solar building permit application 187-26-000123-STR for Wynema Probe at 77 Harbor View Rd, Coos Bay, OR 97420 has been approved by the City of Coos Bay building division.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  assert.equal(run.matches[0].workflow, "permit");
  assert.equal(checksOn(nemTid, pid).length, 0, "the AHJ's email was filed on the NEM target");
  assert.ok(!rawTarget(nemTid).latest_outcome, `NEM target written: ${rawTarget(nemTid).latest_outcome}`);
  assert.equal(rawTarget(permitTid).latest_outcome, "reviewed_by_ahj");
  assert.equal(projectStatus(pid), "approved");
  assert.equal(anyNemApprovedRow(pid), 0, "an AHJ approval email wrote nem_approved");
  const project = R.getProjectDetail(db, pid).project;
  assert.equal(isTrackDone(db, pid, "nem", requiredTracks(project)), false, "an AHJ approval email finished the NEM track");
  assert.equal(laneOf(pid).nemApproved, false);
  const audit = db.get<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'email.project_matched'", [pid])!;
  assert.match(String(audit.details), new RegExp(permitTid));
});

await check("MF1 (NEM email): filed on the NEM target although the permit target is newer; the permit track is untouched", async () => {
  const pid = mkMailProject("Orvil Probe", "78 Harbor View Rd");
  const nemTid = mkNemTarget(pid);
  await pause();
  const permitTid = mkPermitTarget(pid);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  const run = await deliver(
    "Pacific Power interconnection application APP-555001",
    "Pacific Power has reviewed the interconnection application APP-555001 for Orvil Probe at 78 Harbor View Rd, Coos Bay, OR 97420. Status: Approved.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  assert.equal(run.matches[0].workflow, "nem");
  assert.equal(checksOn(permitTid, pid).length, 0, "the utility's email was filed on the permit target");
  assert.ok(!rawTarget(permitTid).latest_outcome, `permit target written: ${rawTarget(permitTid).latest_outcome}`);
  assert.equal(rawTarget(nemTid).latest_outcome, "nem_approved");
  assert.equal(projectStatus(pid), "nem_approved");
  const project = R.getProjectDetail(db, pid).project;
  const required = requiredTracks(project);
  assert.equal(isTrackDone(db, pid, "nem", required), true);
  for (const t of required.filter((x) => x !== "nem")) assert.equal(isTrackDone(db, pid, t, required), false);
});

await check("MF1 (fallback, no target of the email's kind): a NEM email on a permit-only project is a NO-target NEM reading — never the permit target's", async () => {
  const pid = mkMailProject("Nettie Probe", "79 Harbor View Rd");
  const permitTid = mkPermitTarget(pid);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  // A status-update email (the classifier's own label is the neutral "Status update"), whose words
  // read as the utility's approval on the NEM track and as plan review on the permit track — so
  // this case shows the email's TRACK deciding, not the classifier's bucket label (a nem_approval
  // bucket carries "Status: NEM/interconnection approved" and would classify nem_approved on either).
  const run = await deliver(
    "Interconnection application APP-555002",
    "Status update for the interconnection application APP-555002 for Nettie Probe at 79 Harbor View Rd, Coos Bay, OR 97420: Review Complete.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  assert.equal(run.matches[0].workflow, "nem");
  assert.equal(run.matches[0].emailBucket, "status_update", `bucket ${run.matches[0].emailBucket}`);
  assert.equal(checksOn(permitTid, pid).length, 0, "filed on the permit target");
  assert.ok(!rawTarget(permitTid).latest_outcome);
  const noTarget = checksOn(null, pid);
  assert.equal(noTarget.length, 1, "no check row without a target");
  // Judged as the interconnection reading it is (the email's track), not as plan review.
  assert.equal(noTarget[0].outcome, "nem_approved", `a utility's 'Review Complete' with no NEM target read as ${noTarget[0].outcome}`);
  assert.ok(!["approved", "ready_for_issue", "issued"].includes(projectStatus(pid)), `project '${projectStatus(pid)}' from a utility email`);
  const project = R.getProjectDetail(db, pid).project;
  const required = requiredTracks(project);
  assert.equal(isTrackDone(db, pid, "nem", required), false, "no NEM target exists, so no track finished");
  for (const t of required.filter((x) => x !== "nem")) assert.equal(isTrackDone(db, pid, t, required), false);
});

await check("MF1 (fallback, workflow names no single track): recorded with NO target; neither target is touched", async () => {
  const pid = mkMailProject("Alvah Probe", "80 Harbor View Rd");
  const permitTid = mkPermitTarget(pid);
  await pause();
  const nemTid = mkNemTarget(pid);
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  const run = await deliver(
    "Your solar application",
    "Your solar application for Alvah Probe at 80 Harbor View Rd, Coos Bay, OR 97420 has been received and is under review.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  assert.equal(run.matches[0].workflow, "unknown", `workflow ${run.matches[0].workflow}`);
  assert.equal(checksOn(permitTid, pid).length, 0);
  assert.equal(checksOn(nemTid, pid).length, 0);
  assert.ok(!rawTarget(permitTid).latest_outcome && !rawTarget(nemTid).latest_outcome, "a target was written by an email of no single track");
  assert.equal(checksOn(null, pid).length, 1, "no check row without a target");
});

if (failures) { console.error(`\n${failures} with-conditions / NEM-approval test(s) failed.`); process.exit(1); }
console.log("\nAll with-conditions / NEM-approval tests passed.");
