// PROVENANCE, FAIL-CLOSED — the fourth and last D2 round (decisions-0926-final, 2026-09-27).
//
// Three skeptics found the same defect in three shapes: "a NEM-kind reading of Approved is
// nem_approved" was applied regardless of WHERE THE TEXT CAME FROM. An AHJ's plan-review email
// that mentioned the utility finished the NEM track and told the client the utility approved
// (MF-A); a no-target reading with no declared track opened both guards of the project-status
// writer (MF-B); a NEM target polled "Permit Issued" drafted "the city has issued the permit" (MF-C).
//
// ONE predicate — permitMonitor.readingMayFinishTrack(source, target, track) — asked by the writer
// (recordPermitStatusCheck) and the notifier (shouldNotifyClient / clientUpdateFor): a reading may
// write a track's finishing status ONLY when it is a portal poll or an operator's re-check against a
// target that exists, is active, and whose kind IS the outcome's track. Everything else is persisted
// as needs_human_review / "Reported, unconfirmed" with a human-review item, never a client note.
//
// MUST-PASS: the poll path (a typed active NEM target polled "Approved" -> nem_approved + the
// client's "Interconnection approved"; a permit target polled "Approved with conditions" -> approved
// with the with-conditions label; a manual re-check against a target — what the operator asked for).
// MUST-EXCLUDE: the previous skeptics' probe shapes through the REAL paths on a scratch DB —
// probe-email A / B / I (runEmailTracker), probe-writer none-null (the manual writer with no target
// and no track, and with a body-declared track), an inactive target, the other track's family.
//
// KILLS (each makes a check red — .probe/decisions-0926-final/kill.cjs): drop the source check /
// the target-exists check / the active check / the kind check in readingMayFinishTrack; drop the
// notifier's provenance gate; persist the raw outcome; KM1 (emailTrackTargetId's active filter),
// KM3 (the sweep's kind filter), KM4 (the notify kind).
//   npx tsx backend/test/readingProvenance.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reading-provenance-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
// Notifications ON with no SMTP: the client note (project_notes) and the drafted communication are
// OBSERVED, not inferred — an email that reaches neither is the whole point.
process.env.CLIENT_NOTIFICATIONS = "1";
process.env.AUTOPILOT_TEST_SEAMS = "1"; // the sweep's public fetch is seamed in section 5 (KM15) — no real host is touched
for (const k of ["SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY"]) delete process.env[k];

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { createClient } = await import("../src/clients");
const { isTrackDone, requiredTracks } = await import("../src/submittalTracks");
const { readingMayFinishTrack, outcomeTrack, UNCONFIRMED_READING_LABEL, staleStatusClassifications, classificationDrift } = await import("../src/permitMonitor");
const { shouldNotifyClient } = await import("../src/clientNotifier");
const { clientUpdateFor } = await import("../src/clientUpdates");
const { publicCheckLabel, publicProjectStatusPayload } = await import("../src/clientPortal");
const { trackSafeUrl } = await import("../src/portalChannel");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Fixtures: a client with an updates inbox (so the notifier has somewhere to draft to), projects,
// targets of every shape, a local HTTP "portal" for the real sweep, and an mbox for the tracker.
// ---------------------------------------------------------------------------------------------
const clientId = createClient(db, { companyName: "Probe Solar", businessEmail: "ops@probe.test", updatesInbox: "ops@probe.test" } as never).id;
let seq = 0;
const mkProject = (owner: string, street = "1 Test Way"): string => {
  const pid = R.createProject(db, {
    owner, state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
    street, city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
  } as never).project.id;
  db.run("UPDATE projects SET client_id = ?, status = 'submitted' WHERE id = ?", [clientId, pid]);
  return pid;
};
type TargetRow = { id: string; target_type: string; permit_type: string; active: number; latest_outcome: string; latest_status_label: string; last_checked_at: string | null };
const targetsOf = (d: unknown) => (d as { permitCheckTargets: Array<{ id: string; applicationNumber: string }> }).permitCheckTargets;
const mkTarget = (pid: string, input: Record<string, unknown>): string => {
  const app = String(input.applicationNumber ?? `APP-${++seq}-${Math.floor(Math.random() * 1e7)}`);
  const d = R.createPermitCheckTarget(db, pid, { jurisdiction: "X", portalName: "Y", portalUrl: "", ...input, applicationNumber: app } as never);
  return targetsOf(d).find((t) => t.applicationNumber === app)!.id;
};
const mkPermit = (pid: string, extra: Record<string, unknown> = {}) => mkTarget(pid, { targetType: "permit", permitType: "building", jurisdiction: "City of Coos Bay", ...extra });
const mkNem = (pid: string, extra: Record<string, unknown> = {}) => mkTarget(pid, { targetType: "nem", permitType: "nem", jurisdiction: "Pacific Power", ...extra });
/** The legacy split shape: a NEM filing whose raw target_type says 'permit' (raw SQL, as v28 left them). */
const mkLegacyNem = (pid: string, extra: Record<string, unknown> = {}) => { const t = mkNem(pid, extra); db.run("UPDATE permit_check_targets SET target_type = 'permit' WHERE id = ?", [t]); return t; };
const row = (tid: string): TargetRow => db.get<TargetRow>("SELECT id, target_type, permit_type, active, latest_outcome, latest_status_label, last_checked_at FROM permit_check_targets WHERE id = ?", [tid])!;
const status = (pid: string): string => String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])!.status);
const checks = (pid: string) => db.query<{ target_id: string | null; outcome: string; status_label: string; source: string }>("SELECT target_id, outcome, status_label, source FROM permit_status_checks WHERE project_id = ? ORDER BY rowid ASC", [pid]);
const notes = (pid: string): string[] => db.query<{ body: string }>("SELECT body FROM project_notes WHERE project_id = ? AND note_type = 'client_update'", [pid]).map((n) => n.body);
const comms = (pid: string): string[] => db.query<{ subject: string }>("SELECT subject FROM communications WHERE project_id = ?", [pid]).map((c) => c.subject);
const items = (pid: string) => db.query<{ issue_type: string; parser_value: string; notes: string; status: string }>("SELECT issue_type, parser_value, notes, status FROM human_review_items WHERE project_id = ? AND field_name = 'permit_status_unconfirmed'", [pid]);
const nemDone = (pid: string): boolean => { const p = R.getProjectDetail(db, pid).project; return isTrackDone(db, pid, "nem", requiredTracks(p)); };
const permitDone = (pid: string): boolean => { const p = R.getProjectDetail(db, pid).project; const req = requiredTracks(p); return req.filter((t) => t !== "nem").some((t) => isTrackDone(db, pid, t, req)); };
const anyFinishingRow = (pid: string): string[] => checks(pid).filter((c) => outcomeTrack(c.outcome)).map((c) => c.outcome);
const accela = (s: string): string => `Record 187-26-000999-STR: Residential Record Status: ${s} Expiration Date: 03/16/2027 Record Info Schedule Inspections Payments Conditions Processing Status`;

/** The MUST-EXCLUDE shape, asserted in full: no finishing outcome persisted anywhere, the project
 *  untouched, no client note, no drafted email, one human-review item naming the reading. */
const assertRefused = (pid: string, reading: { targetId: string | null; rawOutcome: string }, why: RegExp): void => {
  assert.equal(status(pid), "submitted", `project moved to '${status(pid)}'`);
  assert.deepEqual(anyFinishingRow(pid), [], `a finishing outcome was persisted: ${anyFinishingRow(pid).join(",")}`);
  const stored = checks(pid).filter((c) => (c.target_id ?? null) === reading.targetId);
  assert.equal(stored.length, 1, `expected one check row on ${reading.targetId ?? "NO target"}, found ${stored.length}`);
  assert.deepEqual([stored[0].outcome, stored[0].status_label], ["needs_human_review", UNCONFIRMED_READING_LABEL]);
  if (reading.targetId) assert.deepEqual([row(reading.targetId).latest_outcome, row(reading.targetId).latest_status_label], ["needs_human_review", UNCONFIRMED_READING_LABEL], "the target was written differently from its newest row");
  assert.equal(nemDone(pid), false, "the NEM track finished");
  assert.equal(permitDone(pid), false, "a permit track finished");
  assert.deepEqual(notes(pid), [], `client note written: ${notes(pid).join(" | ")}`);
  assert.deepEqual(comms(pid), [], `client email drafted: ${comms(pid).join(" | ")}`);
  const pending = items(pid);
  assert.equal(pending.length, 1, `expected one human-review item, found ${pending.length}`);
  assert.equal(pending[0].status, "pending");
  assert.match(pending[0].parser_value, new RegExp(`^${reading.rawOutcome}:`), `the item names ${pending[0].parser_value}, not the reading`);
  assert.match(pending[0].notes, why, `the item's reason: ${pending[0].notes}`);
};

// ---------------------------------------------------------------------------------------------
// 1. THE PREDICATE ITSELF — every arm.
// ---------------------------------------------------------------------------------------------
await check("outcomeTrack: the finishing family and which track each outcome belongs to; everything else is ungated", () => {
  assert.equal(outcomeTrack("nem_approved"), "nem");
  for (const o of ["issued", "ready_for_issue", "reviewed_by_ahj"]) assert.equal(outcomeTrack(o), "permit", o);
  for (const o of ["waiting", "correction_flagged", "needs_human_review", "no_change", "", undefined]) assert.equal(outcomeTrack(o), null, String(o));
});

await check("readingMayFinishTrack: TRUE only for portal / public_url / manual against an existing, ACTIVE target of the outcome's kind", () => {
  const nem = { active: 1, target_type: "nem", permit_type: "nem" };
  const legacyNem = { active: 1, target_type: "permit", permit_type: "nem" };
  const permit = { active: 1, target_type: "permit", permit_type: "building" };
  for (const source of ["portal", "public_url", "manual"]) {
    assert.equal(readingMayFinishTrack(source, nem, "nem").trusted, true, `${source} nem/nem`);
    assert.equal(readingMayFinishTrack(source, legacyNem, "nem").trusted, true, `${source} legacy nem`);
    assert.equal(readingMayFinishTrack(source, permit, "permit").trusted, true, `${source} permit`);
    // the other track's family on this target
    assert.equal(readingMayFinishTrack(source, nem, "permit").trusted, false, `${source} permit family on a NEM target`);
    assert.equal(readingMayFinishTrack(source, permit, "nem").trusted, false, `${source} nem family on a permit target`);
    // no target / inactive / no track
    assert.equal(readingMayFinishTrack(source, null, "nem").trusted, false, `${source} no target`);
    assert.equal(readingMayFinishTrack(source, { ...nem, active: 0 }, "nem").trusted, false, `${source} inactive`);
    assert.equal(readingMayFinishTrack(source, nem, null).trusted, false, `${source} no track`);
  }
  // an email of ANY shape, and mock (no evidence), never
  for (const source of ["email", "mock", "", "anything"]) {
    assert.equal(readingMayFinishTrack(source, nem, "nem").trusted, false, `${source}`);
    assert.equal(readingMayFinishTrack(source, permit, "permit").trusted, false, `${source}`);
  }
  const r = readingMayFinishTrack("email", nem, "nem");
  assert.ok(!r.trusted && /email/.test(r.reason), JSON.stringify(r));
});

await check("the notifier asks the same verdict (required argument) and the wording door refuses the other family", () => {
  assert.equal(shouldNotifyClient("nem_approved", "waiting", { trusted: true }), true);
  assert.equal(shouldNotifyClient("nem_approved", "waiting", { trusted: false, reason: "x" }), false, "an untrusted approval reached the notifier");
  assert.equal(shouldNotifyClient("issued", "", { trusted: false, reason: "x" }), false);
  // A correction is not a finishing outcome: an AHJ's own correction email still tells the client "nothing to do yet".
  assert.equal(shouldNotifyClient("correction_flagged", "waiting", { trusted: false, reason: "x" }), true);
  assert.equal(shouldNotifyClient("nem_approved", "nem_approved", { trusted: true }), false, "re-sent on an unchanged outcome");
  const project = { id: "p", ahj: "City of Coos Bay", utility: "Pacific Power" };
  assert.equal(clientUpdateFor(db, project, "issued", { targetType: "nem" }), null, "'Permit issued' worded on the NEM track");
  assert.equal(clientUpdateFor(db, project, "nem_approved", { targetType: "permit" }), null, "'Interconnection approved' worded on a permit");
  assert.ok(clientUpdateFor(db, project, "issued", { targetType: "permit" }));
  assert.ok(clientUpdateFor(db, project, "nem_approved", { targetType: "nem" }));
  assert.ok(clientUpdateFor(db, project, "correction_flagged", { targetType: "nem" }), "a correction on the NEM track has wording");
});

await check("the client page words the unconfirmed label instead of passing an operator string through", () => {
  assert.match(publicCheckLabel("needs_human_review", UNCONFIRMED_READING_LABEL, "nem"), /^Update reported — we are confirming it with the utility$/);
  assert.match(publicCheckLabel("needs_human_review", UNCONFIRMED_READING_LABEL, "permit"), /jurisdiction$/);
  assert.equal(classificationDrift({ outcome: "needs_human_review", statusLabel: UNCONFIRMED_READING_LABEL, rawStatusText: accela("Approved") }, "nem").stale, false,
    "a provenance-refused row reads as stale — the rules did not move, the provenance did");
});

// ---------------------------------------------------------------------------------------------
// 2. MUST-PASS — the poll and the operator's re-check, through the real writer (what D2 asked for).
// ---------------------------------------------------------------------------------------------
await check("MUST PASS (poll): a typed active NEM target polled 'Approved' -> nem_approved, project nem_approved, NEM done, client told 'approved the interconnection', no review item", async () => {
  const pid = mkProject("Poll Nem Owner");
  mkPermit(pid);
  const tid = mkNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: accela("Approved") });
  await sleep(150);
  assert.equal(row(tid).latest_outcome, "nem_approved");
  assert.equal(status(pid), "nem_approved");
  assert.equal(nemDone(pid), true);
  assert.equal(notes(pid).length, 1, `notes: ${notes(pid).join(" | ")}`);
  assert.match(notes(pid)[0], /Pacific Power has approved the interconnection/);
  assert.equal(comms(pid).length, 1, "no client email drafted");
  assert.deepEqual(items(pid), []);
});

await check("MUST PASS (manual re-check): an operator's re-check against an active NEM target reading 'PTO Granted' finishes the NEM track and tells the client — the path production 712cdb55 now needs", async () => {
  const pid = mkProject("Manual Nem Owner");
  mkPermit(pid);
  const tid = mkNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "manual", rawStatusText: "PTO Granted. Permission to operate effective today." });
  await sleep(150);
  assert.equal(row(tid).latest_outcome, "nem_approved");
  assert.equal(status(pid), "nem_approved");
  assert.equal(nemDone(pid), true);
  assert.equal(notes(pid).length, 1, `notes: ${notes(pid).join(" | ")}`);
  assert.deepEqual(items(pid), []);
});

await check("MUST PASS (poll): a permit target polled 'Approved with conditions' -> reviewed_by_ahj with the with-conditions label, project approved; polled 'Permit Issued' -> issued + the client's 'issued the building permit'", async () => {
  const pid = mkProject("Poll Permit Owner");
  const tid = mkPermit(pid);
  mkNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "portal", rawStatusText: accela("Approved with Conditions") });
  assert.deepEqual([row(tid).latest_outcome, row(tid).latest_status_label], ["reviewed_by_ahj", "Approved with conditions"]);
  assert.equal(status(pid), "approved");
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "portal", rawStatusText: accela("Issued") + " Permit issued 09/09/2026. Download permit card." });
  await sleep(150);
  assert.equal(row(tid).latest_outcome, "issued");
  assert.equal(status(pid), "issued");
  assert.equal(permitDone(pid), true);
  assert.ok(notes(pid).some((n) => /has issued the building permit/.test(n)), `notes: ${notes(pid).join(" | ")}`);
  assert.deepEqual(items(pid), []);
});

// ---------------------------------------------------------------------------------------------
// 3. MUST-EXCLUDE — the manual writer (probe-writer none-null; the body-declared track; inactive;
//    the other family — MF-B, MF-C).
// ---------------------------------------------------------------------------------------------
for (const [text, rawOutcome] of [["PTO Granted", "nem_approved"], ["Permit Issued", "issued"], ["Approved pending payment", "ready_for_issue"], ["Status: Approved", "reviewed_by_ahj"]] as const) {
  await check(`MUST EXCLUDE (probe-writer none-null, MF-B): no target, no track, manual '${text}' -> no status, no note, a review item`, async () => {
    const pid = mkProject(`None Null ${text}`);
    mkPermit(pid); mkNem(pid);
    await R.recordPermitStatusCheck(db, pid, { targetId: null, track: null, source: "manual", rawStatusText: accela(text) });
    await sleep(120);
    assertRefused(pid, { targetId: null, rawOutcome }, /no tracking target/);
  });
}

await check("MUST EXCLUDE (body-declared track): no target + track 'nem' + 'Status: Approved' is worded as the interconnection approval but writes nothing (the route passes req.body through)", async () => {
  const pid = mkProject("Body Track Owner");
  mkPermit(pid); mkNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: null, track: "nem", source: "manual", rawStatusText: accela("Approved") });
  await sleep(120);
  assertRefused(pid, { targetId: null, rawOutcome: "nem_approved" }, /no tracking target/);
});

await check("MUST EXCLUDE (inactive target): a manual re-check against an INACTIVE NEM target reading 'PTO Granted' is unconfirmed — a retired filing is not this reading's", async () => {
  const pid = mkProject("Inactive Owner");
  mkPermit(pid);
  const tid = mkNem(pid);
  db.run("UPDATE permit_check_targets SET active = 0 WHERE id = ?", [tid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "manual", rawStatusText: "PTO Granted" });
  await sleep(120);
  assertRefused(pid, { targetId: tid, rawOutcome: "nem_approved" }, /inactive/);
});

await check("MUST EXCLUDE (MF-C, other family): an active NEM target POLLED 'Permit Issued' is unconfirmed — no 'city has issued the permit' note, project untouched", async () => {
  const pid = mkProject("Nem Reads Issued");
  mkPermit(pid);
  const tid = mkNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: accela("Permit Issued") });
  await sleep(120);
  assertRefused(pid, { targetId: tid, rawOutcome: "issued" }, /permit track but the target is a nem filing/);
});

await check("MUST EXCLUDE (MF-C, other family): an active PERMIT target polled 'PTO Granted' is unconfirmed — no 'approved the interconnection' note", async () => {
  const pid = mkProject("Permit Reads Pto");
  const tid = mkPermit(pid);
  mkNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "portal", rawStatusText: accela("PTO Granted") });
  await sleep(120);
  assertRefused(pid, { targetId: tid, rawOutcome: "nem_approved" }, /nem track but the target is a permit filing/);
});

await check("MUST EXCLUDE (email on the RIGHT target): an AHJ email reading 'Permit issued' filed on the active permit target is still unconfirmed", async () => {
  const pid = mkProject("Email Issued Owner");
  const tid = mkPermit(pid);
  mkNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "email", rawStatusText: "Email bucket: permit_approval\nStatus: Permit issued\nYour permit has been issued. Download permit card." });
  await sleep(120);
  assertRefused(pid, { targetId: tid, rawOutcome: "issued" }, /came from email/);
});

await check("AGREEMENT is not news: an email saying what the poll already read (issued) leaves the target issued, raises no item, sends nothing twice", async () => {
  const pid = mkProject("Agreement Owner");
  const tid = mkPermit(pid);
  mkNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "portal", rawStatusText: accela("Issued") + " Permit issued. Download permit card." });
  await sleep(120);
  assert.equal(row(tid).latest_outcome, "issued");
  assert.equal(notes(pid).length, 1);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "email", rawStatusText: "Email bucket: permit_approval\nStatus: Permit issued\nYour permit has been issued. Download permit card." });
  await sleep(120);
  assert.equal(row(tid).latest_outcome, "issued", `an agreeing email downgraded the target to ${row(tid).latest_outcome}`);
  assert.equal(status(pid), "issued");
  assert.deepEqual(items(pid), [], "an agreeing email raised a review item");
  assert.equal(notes(pid).length, 1, "the agreeing email re-notified the client");
});

await check("AGREEMENT changes NO status: a legacy email-written nem_approved NEM target beside a project at 'submitted', one more email 'PTO Granted' -> row persisted, project stays submitted, no handoff, no note, no item", async () => {
  const pid = mkProject("Legacy Agreement Owner");
  const permitTid = mkPermit(pid);
  const nemTid = mkNem(pid);
  // The pre-round class of row: an email finished the NEM target under the old rules, and the permit is issued.
  db.run("UPDATE permit_check_targets SET latest_outcome = 'nem_approved', latest_status_label = 'NEM / interconnection approved' WHERE id = ?", [nemTid]);
  db.run("UPDATE permit_check_targets SET latest_outcome = 'issued', latest_status_label = 'Permit issued' WHERE id = ?", [permitTid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: nemTid, source: "email", rawStatusText: "Email bucket: nem_approval\nWorkflow: nem\nStatus: PTO Granted\nPermission to operate granted." });
  await sleep(120);
  assert.equal(checks(pid).filter((c) => c.target_id === nemTid).length, 1, "the agreeing email was not recorded");
  assert.equal(row(nemTid).latest_outcome, "nem_approved", "the agreeing email changed the target");
  assert.equal(status(pid), "submitted", `an agreeing email moved the project to '${status(pid)}'`);
  assert.equal(db.query<{ id: string }>("SELECT id FROM project_notes WHERE project_id = ? AND note_type = 'handoff'", [pid]).length, 0, "an agreeing email handed the project off");
  assert.deepEqual(notes(pid), []);
  assert.deepEqual(items(pid), []);
  // The same shape on the permit side: a legacy issued target, an email 'Permit issued', project still submitted.
  const pid2 = mkProject("Legacy Agreement Permit");
  const t2 = mkPermit(pid2);
  mkNem(pid2);
  db.run("UPDATE permit_check_targets SET latest_outcome = 'issued', latest_status_label = 'Permit issued' WHERE id = ?", [t2]);
  await R.recordPermitStatusCheck(db, pid2, { targetId: t2, source: "email", rawStatusText: "Email bucket: permit_approval\nStatus: Permit issued\nYour permit has been issued. Download permit card." });
  await sleep(120);
  assert.equal(row(t2).latest_outcome, "issued");
  assert.equal(status(pid2), "submitted", `an agreeing email moved the project to '${status(pid2)}'`);
  assert.deepEqual(notes(pid2), []);
  assert.deepEqual(items(pid2), []);
});

await check("the unconfirmed reading is CURRENT on the stale scan (no re-check offered as if the rules moved), and the client page words it", async () => {
  const pid = mkProject("Stale Scan Owner");
  mkPermit(pid);
  const tid = mkNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "email", rawStatusText: "Email bucket: nem_approval\nWorkflow: nem\nStatus: NEM / interconnection approved\nYour interconnection application is approved." });
  await sleep(120);
  assert.deepEqual([row(tid).latest_outcome, row(tid).latest_status_label], ["needs_human_review", UNCONFIRMED_READING_LABEL]);
  assert.deepEqual(staleStatusClassifications(db, [pid]), [], "the refused row was marked stale");
  const token = `tok-${pid.slice(0, 8)}`;
  db.run("UPDATE projects SET status_share_token = ? WHERE id = ?", [token, pid]);
  const page = publicProjectStatusPayload(db, token)!;
  const nemTrack = page.tracks.find((t) => t.type === "nem")!;
  assert.match(String(nemTrack.statusLabel), /Update reported — we are confirming it with the utility/, `client page says: ${nemTrack.statusLabel}`);
  assert.doesNotMatch(JSON.stringify(page), /approved the interconnection|Interconnection approved/i, "the client page claims the approval");
  // ...and the operator's re-check (the item's remedy) is the trusted door: it finishes the track.
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "manual", rawStatusText: accela("Approved") });
  await sleep(120);
  assert.equal(row(tid).latest_outcome, "nem_approved");
  assert.equal(status(pid), "nem_approved");
  assert.equal(notes(pid).length, 1, `notes after the re-check: ${notes(pid).join(" | ")}`);
});

await check("a LEGACY email row (production 712cdb55's shape) is stale, and today's verdict for it is 'Reported, unconfirmed' — never nem_approved on the words alone", async () => {
  const pid = mkProject("Legacy Row Owner");
  mkPermit(pid);
  const tid = mkNem(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "email", rawStatusText: "Email bucket: nem_approval\nWorkflow: nem\nStatus: NEM / interconnection approved\nYour interconnection application is approved." });
  // Stored under the OLD rules: an email filed on the NEM target read as plan review.
  db.run("UPDATE permit_status_checks SET outcome = 'reviewed_by_ahj', status_label = 'Reviewed by AHJ' WHERE target_id = ?", [tid]);
  db.run("UPDATE permit_check_targets SET latest_outcome = 'reviewed_by_ahj', latest_status_label = 'Reviewed by AHJ' WHERE id = ?", [tid]);
  const legacy = staleStatusClassifications(db, [pid]);
  assert.equal(legacy.length, 1, "a legacy email row stored under the old rules is not offered a re-check");
  assert.deepEqual([legacy[0].source, legacy[0].storedOutcome, legacy[0].currentOutcome, legacy[0].currentStatusLabel], ["email", "reviewed_by_ahj", "needs_human_review", UNCONFIRMED_READING_LABEL],
    `today's verdict for a legacy email row reads as ${legacy[0].currentOutcome} / ${legacy[0].currentStatusLabel}`);
  // The same words from a TRUSTED source are today's nem_approved, and the scan says so.
  db.run("UPDATE permit_status_checks SET source = 'manual' WHERE target_id = ?", [tid]);
  const trusted = staleStatusClassifications(db, [pid]);
  assert.equal(trusted[0]?.currentOutcome, "nem_approved", `a manual row's re-read: ${trusted[0]?.currentOutcome}`);
});

// ---------------------------------------------------------------------------------------------
// 4. MUST-EXCLUDE — the EMAIL TRACKER, the previous skeptic's probe-email shapes through the real
//    runEmailTracker. The classifier's bucket/workflow is LOGGED, not trusted: whatever it says,
//    an email finishes nothing.
// ---------------------------------------------------------------------------------------------
const deliver = async (subject: string, body: string) => {
  const file = path.join(tmp, `m${++seq}.mbox`);
  fs.writeFileSync(file, `From sender@example.gov Wed Jun 17 10:0${seq % 10}:00 2026\nSubject: ${subject}\nDate: Wed, 17 Jun 2026 10:0${seq % 10}:00 -0700\n\n${body}\n`);
  const label = `m${seq}.mbox`;
  const configured = R.configureEmailTrackingSource(db, { filePath: file, label });
  const source = configured.sources.find((s) => s.label === label)!;
  const run = await R.runEmailTracker(db, { sourceId: source.id });
  await sleep(250);
  return run;
};
const pause = () => sleep(15);

await check("MUST EXCLUDE (probe-email A, MF-A): an AHJ plan-review approval that MENTIONS the interconnection (classifier: nem_approval / nem) finishes nothing and tells the client nothing", async () => {
  const pid = mkProject("Bothie Probe", "81 Harbor View Rd");
  const permitTid = mkPermit(pid, { applicationNumber: "187-26-000777-STR" });
  await pause();
  const nemTid = mkNem(pid);
  const run = await deliver(
    "City of Coos Bay building permit application 187-26-000777-STR",
    "Plan review for the solar building permit application 187-26-000777-STR for Bothie Probe at 81 Harbor View Rd, Coos Bay, OR 97420 has been approved by the City of Coos Bay building division. Once the system is installed and inspected, submit your interconnection application to Pacific Power.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  console.log(`         (classifier said bucket=${run.matches[0].emailBucket} workflow=${run.matches[0].workflow} — irrelevant)`);
  const filedOn = checks(pid)[0]?.target_id ?? null;
  assert.ok(filedOn === nemTid || filedOn === permitTid || filedOn === null, `filed on an unknown target ${filedOn}`);
  const rawOutcome = filedOn === permitTid || (filedOn === null && run.matches[0].workflow === "permit") ? "reviewed_by_ahj" : "nem_approved";
  assertRefused(pid, { targetId: filedOn, rawOutcome }, /came from email/);
  assert.ok(!row(permitTid).latest_outcome || filedOn === permitTid, "the permit target was written by an email filed elsewhere");
});

await check("MUST EXCLUDE (probe-email B): the same email on a permit-only project — a no-target reading, nothing written", async () => {
  const pid = mkProject("Bothtwo Probe", "82 Harbor View Rd");
  const permitTid = mkPermit(pid, { applicationNumber: "187-26-000778-STR" });
  const run = await deliver(
    "City of Coos Bay building permit application 187-26-000778-STR",
    "Plan review for the solar building permit application 187-26-000778-STR for Bothtwo Probe at 82 Harbor View Rd, Coos Bay, OR 97420 has been approved by the City of Coos Bay building division. Once the system is installed and inspected, submit your interconnection application to Pacific Power.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  const filedOn = checks(pid)[0]?.target_id ?? null;
  const rawOutcome = filedOn === permitTid || run.matches[0].workflow === "permit" ? "reviewed_by_ahj" : "nem_approved";
  assertRefused(pid, { targetId: filedOn, rawOutcome }, /came from email/);
});

await check("MUST EXCLUDE (probe-email I, the mirror): a utility approval that mentions the building permit's inspection card (classifier: inspection_final_notice / permit) never writes 'issued', never tells the client the city issued the permit", async () => {
  const pid = mkProject("Mirror Probe", "83 Harbor View Rd");
  const permitTid = mkPermit(pid);
  await pause();
  const nemTid = mkNem(pid, { applicationNumber: "APP-555009" });
  const run = await deliver(
    "Pacific Power interconnection application APP-555009 approved",
    "Pacific Power has approved the interconnection application APP-555009 for Mirror Probe at 83 Harbor View Rd, Coos Bay, OR 97420. Keep your building permit final inspection card for PTO; the permit card and inspection card must be on site.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  console.log(`         (classifier said bucket=${run.matches[0].emailBucket} workflow=${run.matches[0].workflow} — irrelevant)`);
  const filedOn = checks(pid)[0]?.target_id ?? null;
  const stored = checks(pid)[0];
  assert.ok(stored, "no check row");
  assert.deepEqual([stored.outcome, stored.status_label], ["needs_human_review", UNCONFIRMED_READING_LABEL], `persisted ${stored.outcome}`);
  assert.equal(status(pid), "submitted");
  assert.deepEqual(anyFinishingRow(pid), []);
  assert.deepEqual(notes(pid), [], `client note: ${notes(pid).join(" | ")}`);
  assert.equal(items(pid).length, 1);
  assert.ok([permitTid, nemTid, null].includes(filedOn));
});

await check("KM1: a NEM email with the project's NEM target INACTIVE (permit active) is filed on NO target — never the retired filing, never the permit", async () => {
  const pid = mkProject("Inact Probe", "84 Harbor View Rd");
  const nemTid = mkNem(pid, { applicationNumber: "APP-555003" });
  db.run("UPDATE permit_check_targets SET active = 0 WHERE id = ?", [nemTid]);
  await pause();
  const permitTid = mkPermit(pid);
  const run = await deliver(
    "Pacific Power interconnection application APP-555003",
    "Pacific Power has reviewed the interconnection application APP-555003 for Inact Probe at 84 Harbor View Rd, Coos Bay, OR 97420. Status: Approved.",
  );
  assert.equal(run.projectMatches, 1, JSON.stringify(run));
  assert.equal(run.matches[0].workflow, "nem", `workflow ${run.matches[0].workflow}`);
  const stored = checks(pid);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].target_id, null, `filed on ${stored[0].target_id === nemTid ? "the INACTIVE NEM target" : stored[0].target_id === permitTid ? "the permit target" : stored[0].target_id}`);
  assert.ok(!row(nemTid).latest_outcome && !row(permitTid).latest_outcome, "a target was written");
  assertRefused(pid, { targetId: null, rawOutcome: "nem_approved" }, /came from email/);
});

// ---------------------------------------------------------------------------------------------
// 5. THE REAL SWEEP (runDuePermitChecks) against a local HTTP portal: kind-scoped sweeps select by
//    trackKind (KM3), a legacy 'permit'+'nem' target polled 'Approved' finishes the NEM track and is
//    worded as the utility's (KM4), and the poll is the trusted door end to end.
// ---------------------------------------------------------------------------------------------
const pages = new Map<string, string>();
const server = http.createServer((req, res) => {
  const body = pages.get(String(req.url)) ?? "";
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<html><body><h1>Record Detail</h1><div>${body}</div><p>Record Info Schedule Inspections Payments Conditions Processing Status</p></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const pageOf = new Map<string, string>(); // target id -> page path (mkTarget bumps seq too)
const mkPolled = (pid: string, input: Record<string, unknown>, pageText: string): string => {
  const p = `/p${++seq}`;
  pages.set(p, pageText);
  const tid = mkTarget(pid, { ...input, portalUrl: `${base}${p}` });
  pageOf.set(tid, p);
  db.run("UPDATE permit_check_targets SET next_check_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [tid]);
  return tid;
};
const setPage = (tid: string, pageText: string) => pages.set(pageOf.get(tid)!, pageText);
const due = (tid: string) => db.run("UPDATE permit_check_targets SET next_check_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [tid]);

await check("precondition: a local page is a track-safe URL on both tracks (the sweep can fetch it)", () => {
  assert.ok(trackSafeUrl("permit", `${base}/x`) && trackSafeUrl("nem", `${base}/x`), "trackSafeUrl refused 127.0.0.1");
});

await check("KM3: the permit sweep polls permit-kind targets only and the nem sweep NEM-kind only — the legacy 'permit'+'nem' filing is polled by the NEM sweep, never the permit sweep", async () => {
  const pid = mkProject("Sweep Owner");
  const inReview = "Record Status: In Review Expiration Date: 03/16/2027";
  const permitTid = mkPolled(pid, { targetType: "permit", permitType: "building" }, inReview);
  const nemTid = mkPolled(pid, { targetType: "nem", permitType: "nem" }, inReview);
  const legacyTid = mkPolled(pid, { targetType: "nem", permitType: "nem" }, inReview);
  db.run("UPDATE permit_check_targets SET target_type = 'permit' WHERE id = ?", [legacyTid]);
  const blankTid = mkPolled(pid, { targetType: "permit", permitType: "building" }, inReview);
  db.run("UPDATE permit_check_targets SET target_type = '', permit_type = '' WHERE id = ?", [blankTid]);
  await R.runDuePermitChecks(db, "permit");
  assert.ok(row(permitTid).last_checked_at, "the permit sweep skipped the permit target");
  assert.ok(row(blankTid).last_checked_at, "the permit sweep skipped the fully blank legacy permit");
  assert.equal(row(nemTid).last_checked_at, null, "the permit sweep polled the NEM target");
  assert.equal(row(legacyTid).last_checked_at, null, "the permit sweep polled the legacy 'permit'-typed NEM filing");
  await R.runDuePermitChecks(db, "nem");
  assert.ok(row(nemTid).last_checked_at, "the nem sweep skipped the NEM target");
  assert.ok(row(legacyTid).last_checked_at, "the nem sweep skipped the legacy 'permit'-typed NEM filing");
});

await check("MUST PASS (real sweep) + KM4: a legacy 'permit'+'nem' target whose page says 'Approved' -> nem_approved, project nem_approved, NEM done, the client's 'approved the interconnection' (never the permit's wording)", async () => {
  const pid = mkProject("Sweep Legacy Owner");
  const other = mkPolled(pid, { targetType: "permit", permitType: "building" }, "Record Status: In Review Expiration Date: 03/16/2027");
  db.run("UPDATE permit_check_targets SET next_check_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [other]);
  const tid = mkPolled(pid, { targetType: "nem", permitType: "nem" }, "Record 187-26-000999-STR: Residential Record Status: Approved Expiration Date: 03/16/2027");
  db.run("UPDATE permit_check_targets SET target_type = 'permit' WHERE id = ?", [tid]);
  await R.runDuePermitChecks(db, "all");
  await sleep(200);
  assert.equal(row(tid).latest_outcome, "nem_approved", `the sweep read ${row(tid).latest_outcome}`);
  assert.equal(checks(pid).find((c) => c.target_id === tid)?.source, "public_url");
  assert.equal(status(pid), "nem_approved");
  assert.equal(nemDone(pid), true);
  assert.equal(notes(pid).length, 1, `notes: ${notes(pid).join(" | ")}`);
  assert.match(notes(pid)[0], /Pacific Power has approved the interconnection/);
  assert.doesNotMatch(notes(pid)[0], /issued|permit ready/i);
  assert.deepEqual(items(pid), []);
});

await check("MUST EXCLUDE (real sweep, MF-C): a typed NEM target whose page says 'Permit Issued' is unconfirmed through the sweep too", async () => {
  const pid = mkProject("Sweep Nem Issued");
  mkPermit(pid);
  const tid = mkPolled(pid, { targetType: "nem", permitType: "nem" }, "Record 187-26-000999-STR: Residential Record Status: Permit Issued Expiration Date: 03/16/2027");
  await R.runDuePermitChecks(db, "nem");
  await sleep(200);
  assertRefused(pid, { targetId: tid, rawOutcome: "issued" }, /permit track but the target is a nem filing/);
  // ...and the next sweep, once the page says the utility approved, is the trusted door.
  setPage(tid, "Record 187-26-000999-STR: Residential Record Status: Approved Expiration Date: 03/16/2027");
  due(tid);
  await R.runDuePermitChecks(db, "nem");
  await sleep(200);
  assert.equal(row(tid).latest_outcome, "nem_approved");
  assert.equal(status(pid), "nem_approved");
  assert.equal(notes(pid).length, 1, `notes: ${notes(pid).join(" | ")}`);
});

await check("KM15: the sweep judges a legacy 'permit'+'nem' target bound to a UTILITY host (PowerClerk) as the NEM filing it is — fetched (seamed, no real host), no track-host conflict, its 'Approved' -> nem_approved", async () => {
  const pid = mkProject("Sweep PowerClerk Owner");
  mkPermit(pid);
  const tid = mkTarget(pid, { targetType: "nem", permitType: "nem", jurisdiction: "Pacific Power", portalUrl: "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login" });
  db.run("UPDATE permit_check_targets SET target_type = 'permit', next_check_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [tid]);
  const fetched: string[] = [];
  R.setStatusCheckSeamsForTests({
    checkStatus: async () => null,
    publicCheck: async (url: string) => { fetched.push(url); return "Record Detail Application status: Approved. Interconnection application approved by the utility. Record Info Schedule"; },
  });
  try {
    await R.runDuePermitChecks(db, "nem");
    await sleep(200);
  } finally { R.setStatusCheckSeamsForTests(null); }
  assert.ok(fetched.some((u) => /powerclerk\.com/.test(u)), `the utility page was never fetched (${JSON.stringify(fetched)}) — judged a permit filing bound to a utility host?`);
  const conflict = db.query<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'portal.track_host_conflict'", [pid]);
  assert.equal(conflict.length, 0, `track-host conflict audited for the NEM filing: ${conflict.map((c) => c.details).join(" | ")}`);
  assert.equal(row(tid).latest_outcome, "nem_approved", `the sweep read ${row(tid).latest_outcome}`);
  assert.equal(status(pid), "nem_approved");
});

await check("KM14: an operator's re-check (public_url, no text) against a legacy 'permit'+'nem' target on a PowerClerk host FETCHES the utility page (seamed) — the track-safe URL is judged by trackKind, and 'Approved' -> nem_approved", async () => {
  const pid = mkProject("Recheck PowerClerk Owner");
  mkPermit(pid);
  const tid = mkTarget(pid, { targetType: "nem", permitType: "nem", jurisdiction: "Pacific Power", portalUrl: "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login" });
  db.run("UPDATE permit_check_targets SET target_type = 'permit' WHERE id = ?", [tid]);
  const fetched: string[] = [];
  R.setStatusCheckSeamsForTests({
    checkStatus: async () => null,
    publicCheck: async (url: string) => { fetched.push(url); return "Record Detail Application status: Approved. Interconnection application approved by the utility. Record Info Schedule"; },
  });
  try {
    await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url" });
    await sleep(150);
  } finally { R.setStatusCheckSeamsForTests(null); }
  assert.ok(fetched.some((u) => /powerclerk\.com/.test(u)), `the utility page was never fetched (${JSON.stringify(fetched)}) — the re-check refused the URL as a utility host on a permit`);
  assert.equal(row(tid).latest_outcome, "nem_approved", `the re-check read ${row(tid).latest_outcome} / ${row(tid).latest_status_label}`);
  assert.equal(status(pid), "nem_approved");
});

server.close();
if (failures) { console.error(`\n${failures} reading-provenance test(s) failed.`); process.exit(1); }
console.log("\nAll reading-provenance tests passed.");
