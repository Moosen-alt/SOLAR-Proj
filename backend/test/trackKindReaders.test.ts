// EVERY DOWNSTREAM READER ASKS trackKind — the kills that SURVIVED the decisions-0926-close-v
// skeptic's harness (KM6-KM12), each pinned with the kill as the red condition: put raw
// `target_type` back in that one reader and the check here goes red. The shape every case uses is
// the legacy split row (target_type 'permit' + permit_type 'nem', as migration v28 left them, and
// the fully blank '' + '' permit), because that is the row where raw target_type and trackKind
// disagree.
//   npx tsx backend/test/trackKindReaders.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "track-kind-readers-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { createClient } = await import("../src/clients");
const { ensureClientPortalToken, clientPortalPayload } = await import("../src/clientPortal");
const { staleStatusClassifications } = await import("../src/permitMonitor");
const { trackForTarget, milestoneFor } = await import("../src/timelineSamples");
const { loadNextStepFacts } = await import("../src/nextStep");
const { unfinishedUnattributedTargets, requiredTracks, ensureCheckTarget } = await import("../src/submittalTracks");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const clientId = createClient(db, { companyName: "Readers Solar", businessEmail: "ops@readers.test" } as never).id;
let seq = 0;
const mkProject = (owner: string): string => {
  const pid = R.createProject(db, {
    owner, state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
    street: `${++seq} Reader Way`, city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
  } as never).project.id;
  db.run("UPDATE projects SET client_id = ?, status = 'submitted' WHERE id = ?", [clientId, pid]);
  return pid;
};
const targetsOf = (d: unknown) => (d as { permitCheckTargets: Array<{ id: string; applicationNumber: string }> }).permitCheckTargets;
const mkTarget = (pid: string, input: Record<string, unknown>): string => {
  const app = String(input.applicationNumber ?? `APP-${++seq}-${Math.floor(Math.random() * 1e7)}`);
  const d = R.createPermitCheckTarget(db, pid, { jurisdiction: "X", portalName: "Y", portalUrl: "", ...input, applicationNumber: app } as never);
  return targetsOf(d).find((t) => t.applicationNumber === app)!.id;
};
const mkPermit = (pid: string, extra: Record<string, unknown> = {}) => mkTarget(pid, { targetType: "permit", permitType: "building", jurisdiction: "City of Coos Bay", ...extra });
/** The legacy split shape (raw SQL, as v28 left them): a NEM filing whose target_type says 'permit'. */
const mkLegacyNem = (pid: string, extra: Record<string, unknown> = {}): string => {
  const t = mkTarget(pid, { targetType: "nem", permitType: "nem", jurisdiction: "Pacific Power", ...extra });
  db.run("UPDATE permit_check_targets SET target_type = 'permit' WHERE id = ?", [t]);
  return t;
};
/** The fully blank legacy permit ('' + ''): a permit, by trackKind. */
const mkBlankPermit = (pid: string, extra: Record<string, unknown> = {}): string => {
  const t = mkPermit(pid, extra);
  db.run("UPDATE permit_check_targets SET target_type = '', permit_type = '' WHERE id = ?", [t]);
  return t;
};
const row = (tid: string) => db.get<{ target_type: string; permit_type: string; latest_outcome: string; application_number: string }>("SELECT target_type, permit_type, latest_outcome, application_number FROM permit_check_targets WHERE id = ?", [tid])!;
const status = (pid: string): string => String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])!.status);
const accela = (s: string): string => `Record 187-26-000999-STR: Residential Record Status: ${s} Expiration Date: 03/16/2027 Record Info Schedule Inspections Payments Conditions Processing Status`;

await check("KM6: the client portal payload types the legacy 'permit'+'nem' row as the NEM track (and the blank '' + '' row as a permit)", () => {
  const pid = mkProject("Portal Owner");
  const legacy = mkLegacyNem(pid, { applicationNumber: "APP-KM6-NEM" });
  const blank = mkBlankPermit(pid, { applicationNumber: "187-26-KM6-STR" });
  assert.deepEqual([row(legacy).target_type, row(legacy).permit_type], ["permit", "nem"], "fixture");
  assert.deepEqual([row(blank).target_type, row(blank).permit_type], ["", ""], "fixture");
  const payload = clientPortalPayload(db, ensureClientPortalToken(db, clientId))!;
  const project = payload.projects.find((p) => p.id === pid)!;
  assert.ok(project, "the project is not on the portal");
  const byApp = (app: string) => project.tracks.find((t) => JSON.stringify(t).includes(app))!;
  assert.ok(byApp("APP-KM6-NEM"), `the legacy filing is missing from the tracks: ${JSON.stringify(project.tracks)}`);
  assert.equal(byApp("APP-KM6-NEM").type, "nem", `the legacy 'permit'-typed NEM filing shows as ${byApp("APP-KM6-NEM").type}`);
  assert.equal(byApp("187-26-KM6-STR").type, "permit");
});

await check("KM7: the stale scan reports the legacy 'permit'+'nem' row's stale reading as targetType 'nem'", async () => {
  const pid = mkProject("Stale Owner");
  const tid = mkLegacyNem(pid);
  // A trusted reading (manual re-check against the active target) writes nem_approved…
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "manual", rawStatusText: accela("Approved") });
  assert.equal(row(tid).latest_outcome, "nem_approved", "fixture: the manual re-check did not write nem_approved");
  // …then the stored row is forced to the pre-D2 verdict, as a row classified by the old rules would be.
  db.run("UPDATE permit_status_checks SET outcome = 'reviewed_by_ahj', status_label = 'Reviewed by AHJ' WHERE target_id = ?", [tid]);
  db.run("UPDATE permit_check_targets SET latest_outcome = 'reviewed_by_ahj', latest_status_label = 'Reviewed by AHJ' WHERE id = ?", [tid]);
  const stale = staleStatusClassifications(db, [pid]);
  assert.equal(stale.length, 1, `stale readings: ${JSON.stringify(stale.map((s) => [s.storedOutcome, s.currentOutcome, s.targetType]))}`);
  assert.equal(stale[0].currentOutcome, "nem_approved");
  assert.equal(stale[0].targetType, "nem", `the stale reading on a 'permit'-typed NEM filing is reported as ${stale[0].targetType}`);
});

await check("KM8: nextStep counts a numbered fully-blank legacy target ('' + '') as the PERMIT track's filing evidence", () => {
  const pid = mkProject("Next Step Owner");
  mkBlankPermit(pid, { applicationNumber: "187-26-KM8-STR" });
  const project = R.getProjectDetail(db, pid).project;
  const facts = loadNextStepFacts(db, [project]).get(pid)!;
  assert.ok(facts, "no facts");
  const permitTracks = facts.tracks.filter((t) => t.track !== "nem");
  assert.ok(permitTracks.length >= 1, `no permit track among ${facts.tracks.map((t) => t.track).join(",")}`);
  assert.ok(permitTracks.some((t) => t.filed), `no permit track reads filed from the numbered blank target: ${JSON.stringify(permitTracks.map((t) => [t.track, t.filed]))}`);
  const nem = facts.tracks.find((t) => t.track === "nem");
  if (nem) assert.equal(nem.filed, false, "the blank PERMIT target was counted as the NEM filing");
});

await check("KM9: trackForTarget / milestoneFor judge the legacy split shapes by trackKind", () => {
  assert.equal(trackForTarget("permit", "nem"), "nem");
  assert.equal(trackForTarget("", "nem"), "nem");
  assert.equal(trackForTarget("", ""), "permit");
  assert.equal(milestoneFor("nem", "nem", "nem_approved"), "issued");
  assert.equal(milestoneFor("nem", "permit", "nem_approved"), null, "a permit-kind target finished the NEM track's milestone");
});

await check("KM10: the timeline sample for a legacy 'permit'+'nem' target's approval lands on the NEM track (through the real writer)", async () => {
  const pid = mkProject("Timeline Owner");
  const tid = mkLegacyNem(pid, { applicationNumber: "APP-KM10" });
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, submitted_at, created_at)
     VALUES (?, ?, 'interconnection', 'nem', 'submitted', ?, ?)`,
    [`sub-${Math.random().toString(36).slice(2, 10)}`, pid, tenDaysAgo, tenDaysAgo],
  );
  // The milestone is a TRANSITION: seen in review first, then approved — both trusted polls.
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: accela("In Review") });
  await new Promise((r) => setTimeout(r, 20));
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: accela("Approved") });
  assert.equal(row(tid).latest_outcome, "nem_approved", "fixture: the poll did not write nem_approved");
  const samples = db.query<{ track: string; milestone: string }>("SELECT track, milestone FROM permit_timeline_samples WHERE project_id = ?", [pid]);
  assert.deepEqual(samples, [{ track: "nem", milestone: "issued" }], `samples: ${JSON.stringify(samples)}`);
});

await check("KM11: a permit's 'waiting' rewinds ready_for_issue when the only other holder is a legacy 'permit'+'nem' NEM filing (a NEM target never holds a permit status)", async () => {
  const pid = mkProject("Rewind Owner");
  const permitTid = mkPermit(pid);
  const legacy = mkLegacyNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: permitTid, source: "portal", rawStatusText: accela("Approved pending payment") });
  assert.equal(status(pid), "ready_for_issue", "fixture: the permit's reading did not earn ready_for_issue");
  // The legacy NEM row holds a permit-family outcome the old rules wrote (raw SQL: today's writer refuses it).
  db.run("UPDATE permit_check_targets SET latest_outcome = 'ready_for_issue', latest_status_label = 'Ready for issue' WHERE id = ?", [legacy]);
  await R.recordPermitStatusCheck(db, pid, { targetId: permitTid, source: "portal", rawStatusText: accela("In Review") });
  assert.equal(status(pid), "submitted", `the permit regressed but the project stayed '${status(pid)}' — held by a NEM filing's outcome`);
});

await check("KM12: unfinishedUnattributedTargets counts permits by trackKind — a legacy 'permit'+'nem' row is not an unfinished permit; a blank '' + '' row is", () => {
  const pid = mkProject("Unattributed Owner");
  const project = R.getProjectDetail(db, pid).project;
  const permitTracks = requiredTracks(project).filter((t) => t !== "nem");
  const tracks = [...new Set([...permitTracks, "building", "electrical"])] as Parameters<typeof unfinishedUnattributedTargets>[2];
  mkLegacyNem(pid);
  assert.equal(unfinishedUnattributedTargets(db, pid, tracks), 0, "the legacy 'permit'-typed NEM filing was counted as an unfinished permit");
  mkBlankPermit(pid);
  assert.equal(unfinishedUnattributedTargets(db, pid, tracks), 1, "the fully blank legacy permit was not counted");
});

await check("KM13: ensureCheckTarget matches an existing filing by NUMBER on trackKind — the legacy 'permit'+'nem' row is the NEM filing its number names (never the older typed NEM row by permit_type), and a blank '' + '' row is the permit its number names (never a duplicate)", () => {
  const pid = mkProject("Identity Owner");
  const project = R.getProjectDetail(db, pid).project;
  const olderTypedNem = mkTarget(pid, { targetType: "nem", permitType: "nem", jurisdiction: "Pacific Power", applicationNumber: "APP-KM13-OLD" });
  // The second NEM row cannot come through the door (it dedupes one NEM filing per project by
  // permit_type) — it is the legacy split row as old data left it, written raw.
  const legacy = `t-km13-${Math.random().toString(36).slice(2, 8)}`;
  const later = new Date(Date.now() + 1000).toISOString();
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, jurisdiction, portal_name, portal_url, application_number, permit_number,
       check_frequency_days, active, next_check_at, latest_status_label, notes, target_type, permit_type, portal_platform, tracking_url, created_at, updated_at)
     VALUES (?, ?, 'Pacific Power', 'PowerClerk', '', 'APP-KM13-LEGACY', '', 7, 1, ?, '', '', 'permit', 'nem', 'unknown', '', ?, ?)`,
    [legacy, pid, later, later, later],
  );
  const nem = ensureCheckTarget(db, project, { targetType: "nem", permitType: "nem", applicationNumber: "APP-KM13-LEGACY" });
  assert.deepEqual([nem.created, nem.matchedOn, nem.targetId], [false, "application_number", legacy],
    `the NEM filing APP-KM13-LEGACY resolved to ${nem.targetId === olderTypedNem ? "the OLDER typed NEM row (by permit_type)" : nem.created ? "a new row" : nem.targetId} via ${nem.matchedOn}`);
  assert.equal(row(olderTypedNem).application_number, "APP-KM13-OLD", "the older NEM row's number was overwritten");
  const blank = mkBlankPermit(pid, { applicationNumber: "187-26-KM13-STR" });
  const permit = ensureCheckTarget(db, project, { targetType: "permit", permitType: "building", applicationNumber: "187-26-KM13-STR" });
  assert.deepEqual([permit.created, permit.matchedOn, permit.targetId], [false, "application_number", blank],
    `the permit 187-26-KM13-STR ${permit.created ? "was created AGAIN beside the blank legacy row" : `resolved to ${permit.targetId} via ${permit.matchedOn}`}`);
});

await check("KM16: a correction reopen scoped to the PERMIT track by wording finds ONE candidate when the other filing is a legacy 'permit'+'nem' NEM row — it is not a second permit candidate", async () => {
  const pid = mkProject("Reopen Scope Owner");
  const permitTid = mkPermit(pid, { applicationNumber: "187-26-000305-STR", portalUrl: "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx" });
  const legacy = `t-km16-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, jurisdiction, portal_name, portal_url, application_number, permit_number,
       check_frequency_days, active, next_check_at, latest_status_label, notes, target_type, permit_type, portal_platform, tracking_url, created_at, updated_at)
     VALUES (?, ?, 'Pacific Power', 'PowerClerk', 'https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login', 'APP-KM16-NEM', '', 7, 1, ?, '', '', 'permit', 'nem', 'powerclerk', '', ?, ?)`,
    [legacy, pid, now, now, now],
  );
  // Permit wording, quoting no tracked number: the reopen scopes candidates by the correction's TRACK.
  const corrected = R.addManualCorrection(db, pid, "The city's building plan reviewer returned the permit application: add the roof attachment detail and the structural calculations for the rafters before the building permit can proceed.");
  const correctionId = corrected.corrections[0].id;
  const runner = (async () => ({
    ok: true, needsHuman: false, finalSubmitClicked: false, finalSubmitClickedByAutomation: false,
    reopenedForm: "Correction Form", attachedDocs: 0, browserLeftOpen: false, message: "", offeredForms: [],
  })) as never;
  const reopened = await R.reopenCorrectionOnPortal(db, correctionId, { runner });
  assert.equal(reopened.ok, true, `the reopen did not proceed: ${reopened.message}`);
  assert.equal(Boolean((reopened as { needsHuman?: boolean }).needsHuman), false, `the reopen asked a human to pick between candidates: ${reopened.message}`);
  const run = db.get<{ target_id?: string; details?: string }>("SELECT * FROM portal_runs WHERE project_id = ? ORDER BY rowid DESC LIMIT 1", [pid]);
  assert.ok(run, "no portal run recorded");
  assert.doesNotMatch(JSON.stringify(run), new RegExp(legacy), "the reopen ran against the legacy NEM filing");
  assert.ok(row(permitTid).application_number === "187-26-000305-STR");
});

if (failures) { console.error(`\n${failures} trackKind-reader test(s) failed.`); process.exit(1); }
console.log("\nAll trackKind-reader tests passed.");
