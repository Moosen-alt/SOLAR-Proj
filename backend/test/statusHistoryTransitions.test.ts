// A TIMELINE OF CHECKS IS NOT A TIMELINE — AND A HELPER NOTHING CALLS IS NOT A FIX.
//
// The operator opened a live client status page and found twelve "Recent updates" entries, six
// pairs of them seconds apart, every one of them saying the same thing and none of them saying
// which of the project's three filings it was about:
//
//   Permit issued   Sep 14      In review   Sep 14
//   Permit issued   Sep 13      In review   Sep 13
//   ... eight more of the same ...
//
// Two defects produced that page, and a third produced the round of work that failed to fix it.
//
//   1. permit_status_checks was written on every CHECK, not every CHANGE. A permit that sits in
//      "In review" for three weeks gets a row per sweep, and the pairs are one sweep's structural
//      target followed by its electrical target. The EMAIL side already had this right — the
//      client is notified only when the outcome moves — so the page showed the ladder the inbox
//      was deliberately spared.
//   2. No entry named its subject. The projection emitted date + statusLabel + outcome. The
//      discipline and the application number were both one join away and neither was carried.
//   3. THE FIX WAS WRITTEN AND NEVER CONNECTED. shouldRecordStatusCheck() and
//      projectStatusHistory() both shipped with tests and NO PRODUCTION CALLER — the insert was
//      byte-unchanged and the route still built its own `permitStatusChecks.slice(0, 12)`. The
//      previous version of THIS FILE called both helpers directly, so 398 lines of green
//      assertions sat on top of a page that had not changed at all.
//
// So the rule for this file: the load-bearing checks drive PRODUCTION ENTRY POINTS.
// recordPermitStatusCheck() for the write, publicProjectStatusPayload() — the whole body of
// GET /api/public/status/:token — for the read, plus a source assertion that the route still
// delegates to it. The direct-helper checks are kept, clearly marked, as unit cover for the
// policy itself; they are NOT what proves the wiring, and on their own they never could.
//
//   MUST NOT WRITE — a row for a polled check that changed nothing. Asserted as ROW COUNTS in
//                    permit_status_checks after real sweeps. This is what fails if the gate in
//                    recordPermitStatusCheck is removed.
//   MUST COLLAPSE  — consecutive identical states, PER TARGET, at READ time. Rows written before
//                    the gate landed are still in the table and are never deleted, so the page
//                    must repair them. Exercised with real `manual`-sourced rows, which are
//                    exempt from the gate and therefore still ladder.
//   MUST KEEP      — the FIRST row of a run. A timeline entry dated today for a status that last
//                    moved in August is a wrong date, not a fresh update.
//   MUST RECORD    — a genuine transition, including one that changes only the LABEL and not the
//                    outcome ("In review" → "Action needed before review" is the single most
//                    important thing a client can be told, and it is not a new outcome).
//   MUST NOT LOSE  — audit fidelity. One audit_logs `permit_status.checked` row per CHECK stays,
//                    suppressed checks included, and permit_check_targets.last_checked_at still
//                    advances every time we look.
//   MUST NOT LOSE  — a genuine correction. The gate covers the correction and human-review rows
//                    too (they are the same check's other artifacts); the FIRST sighting must
//                    still land in full, and a correction that returns after a state change must
//                    land again.
//   MUST EXEMPT    — email and manual sources. An inbound AHJ email is an event, not a poll, and
//                    email_project_matches.status_check_id is a foreign key onto the row written
//                    for it. An operator pasting status text expects a record of having done so.
//   MUST NAME      — every entry: which filing, and the jurisdiction's own reference for it.
//   MUST SAY       — who the next move belongs to, in the words themselves, on the timeline AND
//                    on the track badges.
//
//   npx tsx backend/test/statusHistoryTransitions.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-history-transitions-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, createPermitCheckTarget, recordPermitStatusCheck } = await import("../src/repository");
const { publicProjectStatusPayload, projectStatusHistory, publicCheckLabel, trackLabel } = await import("../src/clientPortal");
const { ensureStatusShareToken } = await import("../src/clientNotifier");
const { shouldRecordStatusCheck, classifyPermitStatusText } = await import("../src/permitMonitor");
const { clientUpdateFor } = await import("../src/clientUpdates");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

// The real status strings from the stalled Coos Bay permit and its siblings.
const IN_REVIEW = "Record Status: In Review. Application received and assigned to a plans examiner.";
const INTAKE_NEEDED = "Record Status: Intake Requirements Needed. Submitted 09/02/2026.";
const ISSUED = "Record Status: Issued. Permit issued 09/09/2026. Download permit card.";
const NEM_APPROVED = "Interconnection application approved. Permission to operate granted.";
const CORRECTION = "Corrections required. Revise and resubmit the structural calculations.";

// ─────────────────────────────────────────────────────────────────────────────────────────
// SHARED COUNTERS — every one of them reads the DATABASE, not a return value. A function can
// return a tidy answer while writing a ladder behind it; that is the bug this file exists for.
// ─────────────────────────────────────────────────────────────────────────────────────────
const rowsFor = (targetId: string): number => Number(
  db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_status_checks WHERE target_id = ?", [targetId])?.n ?? 0,
);
const rowsForProject = (projectId: string): number => Number(
  db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_status_checks WHERE project_id = ?", [projectId])?.n ?? 0,
);
const auditChecks = (projectId: string): number => Number(
  db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action = 'permit_status.checked'", [projectId],
  )?.n ?? 0,
);
const lastCheckedAt = (targetId: string): string => String(
  db.get<{ last_checked_at?: string }>("SELECT last_checked_at FROM permit_check_targets WHERE id = ?", [targetId])?.last_checked_at || "",
);
const correctionsFor = (projectId: string): number => Number(
  db.get<{ n: number }>("SELECT COUNT(*) AS n FROM corrections WHERE project_id = ?", [projectId])?.n ?? 0,
);
const reviewItemsFor = (projectId: string, field: string): number => Number(
  db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM human_review_items WHERE project_id = ? AND field_name = ?", [projectId, field],
  )?.n ?? 0,
);

// ═════════════════════════════════════════════════════════════════════════════════════════
// PART 1 — THE PRODUCTION WRITE PATH.
//
// Everything here goes through recordPermitStatusCheck(), the one function that writes
// permit_status_checks. The assertions are row counts, because "the page looks right" is
// exactly what the read-time collapse can deliver over a table that is still laddering.
// ═════════════════════════════════════════════════════════════════════════════════════════

const client = createClient(db, { companyName: "Transition Solar", ccbLicenseNumber: "717171" });
const { project } = createProject(db, {
  clientId: client.id, owner: "Two Permit Owner", street: "1780 Ocean Blvd SE", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
});

// Real targets via the real writer, so the discipline lands the way production lands it.
createPermitCheckTarget(db, project.id, {
  jurisdiction: "City of Coos Bay", applicationNumber: "187-26-000309-STR",
  targetType: "permit", permitType: "building",
});
const detailAfterStr = createPermitCheckTarget(db, project.id, {
  jurisdiction: "City of Coos Bay", applicationNumber: "194-26-001482-ELEC",
  targetType: "permit", permitType: "electrical",
});
const strTarget = detailAfterStr.permitCheckTargets.find((t) => t.applicationNumber.endsWith("-STR"))!;
const eleTarget = detailAfterStr.permitCheckTargets.find((t) => t.applicationNumber.endsWith("-ELEC"))!;

const poll = (targetId: string, raw: string) =>
  recordPermitStatusCheck(db, project.id, { targetId, source: "portal", rawStatusText: raw });

await check("THE OPERATOR'S CASE: two targets, three sweeps, TWO ROWS — not six", async () => {
  // Sweep 1: both targets read for the first time.
  await poll(strTarget.id, IN_REVIEW);
  await poll(eleTarget.id, IN_REVIEW);
  // Sweeps 2 and 3: nothing has moved. This is `check-permits-now --all` being run twice.
  await poll(strTarget.id, IN_REVIEW);
  await poll(eleTarget.id, IN_REVIEW);
  await poll(strTarget.id, IN_REVIEW);
  await poll(eleTarget.id, IN_REVIEW);

  // THE ASSERTION THAT FAILS IF THE GATE IN recordPermitStatusCheck IS REMOVED. Not the shape of
  // the page — the contents of the table. Read-time collapse would make the page look correct
  // over six rows, which is precisely how the unwired version of this fix passed its tests.
  assert.equal(rowsFor(strTarget.id), 1,
    `the structural filing wrote ${rowsFor(strTarget.id)} rows for one state — permit_status_checks `
    + "is still one row per CHECK, so the ladder is still being written and every consumer of this "
    + "table still sees it");
  assert.equal(rowsFor(eleTarget.id), 1, "the electrical filing laddered too");
  assert.equal(rowsForProject(project.id), 2, "one row per FILING that has moved, not one per sweep");

  // ...and the page the operator was looking at, through the function the route calls.
  const history = projectStatusHistory(db, project.id);
  assert.equal(history.length, 2,
    `the client is shown the ladder again: ${JSON.stringify(history.map((h) => [h.label, h.statusLabel, h.at]))}`);
  const labels = history.map((h) => h.label).sort();
  assert.deepEqual(labels, ["Building permit", "Electrical permit"],
    `the two filings are indistinguishable on the timeline: ${JSON.stringify(history)}`);
});

await check("MUST NOT LOSE AUDIT FIDELITY: one audit row per CHECK, all six", () => {
  assert.equal(auditChecks(project.id), 6,
    "the per-check evidence trail was collapsed along with the client timeline — audit_logs must "
    + "keep one permit_status.checked row for every time we looked, whether or not a status row "
    + "was written");
});

await check("MUST KEEP LOOKING: last_checked_at STRICTLY advances on an unchanged poll", async () => {
  // The gate is about what the client is SHOWN, never about whether we looked. This is the one
  // assertion that stops the obvious wrong implementation: putting the permit_check_targets
  // UPDATE inside the gated branch. Do that and last_checked_at freezes at the last transition,
  // and the operator's board reads "last checked three weeks ago" for a target polled nightly.
  const before = lastCheckedAt(strTarget.id);
  assert.ok(before, `${strTarget.applicationNumber} has no last_checked_at at all`);
  await new Promise((r) => setTimeout(r, 40)); // nowIso() is millisecond-precision
  await poll(strTarget.id, IN_REVIEW); // nothing has moved
  assert.equal(rowsFor(strTarget.id), 1, "the unchanged poll wrote a row after all");
  const after = lastCheckedAt(strTarget.id);
  assert.ok(after > before, // ISO-8601 sorts lexicographically
    `an unchanged poll left last_checked_at at ${before} — the target UPDATE must run whether or `
    + "not a row was written");
});

await check("A GENUINE TRANSITION WRITES A ROW AND A TIMELINE ENTRY", async () => {
  const before = projectStatusHistory(db, project.id).length;
  await poll(eleTarget.id, ISSUED);
  await new Promise((r) => setTimeout(r, 60)); // the client notify is fire-and-forget
  assert.equal(rowsFor(eleTarget.id), 2, "the move to issued was gated away — the gate is too wide");
  const after = projectStatusHistory(db, project.id);
  assert.equal(after.length, before + 1,
    `the move to issued never reached the timeline: ${JSON.stringify(after.map((h) => [h.label, h.statusLabel]))}`);
  assert.equal(after[0].label, "Electrical permit", "the newest entry must be the filing that moved");
  assert.match(after[0].statusLabel, /issued/i, after[0].statusLabel);
  // ...and the STRUCTURAL permit, which did not move, is still one entry and still "in review".
  const strEntries = after.filter((h) => h.applicationNumber === "187-26-000309-STR");
  assert.equal(strEntries.length, 1, `the untouched filing grew entries: ${JSON.stringify(strEntries)}`);
});

await check("THE CITY STOPS AND STARTS WAITING ON US — recorded once, not once per sweep", async () => {
  // 187-26-000309-STR's real move: "Intake Requirements Needed". The outcome changes here
  // (waiting → needs_human_review) AND so does the label.
  const rowsBefore = rowsFor(strTarget.id);
  const before = projectStatusHistory(db, project.id).length;
  await poll(strTarget.id, INTAKE_NEEDED);
  await poll(strTarget.id, INTAKE_NEEDED); // and the next sweep, which changed nothing
  await poll(strTarget.id, INTAKE_NEEDED); // and the one after that
  assert.equal(rowsFor(strTarget.id), rowsBefore + 1,
    "the stall was written three times — one per sweep, exactly the ladder");
  // The needs_human_review branch writes a human_review_items row alongside the check. Gating the
  // check without gating that leaves the operator a fresh pending review item every single sweep.
  assert.equal(reviewItemsFor(project.id, "permit_status"), 1,
    `${reviewItemsFor(project.id, "permit_status")} pending review items for one stall — the `
    + "human_review_items insert is not inside the gate");
  const after = projectStatusHistory(db, project.id);
  assert.equal(after.length, before + 1,
    `the stall either never showed or showed twice: ${JSON.stringify(after.map((h) => [h.label, h.statusLabel]))}`);
  assert.equal(after[0].label, "Building permit");
  assert.match(after[0].statusLabel, /\bus\b/i,
    `the client is still not told the city is waiting on us: "${after[0].statusLabel}"`);
});

await check("A STATE THAT RETURNS IS NOT COLLAPSED AWAY (A → B → A is three)", async () => {
  const strBefore = projectStatusHistory(db, project.id, 50).filter((h) => h.applicationNumber === "187-26-000309-STR").length;
  await poll(strTarget.id, IN_REVIEW); // back into review once we supplied the intake documents
  const strAfter = projectStatusHistory(db, project.id, 50).filter((h) => h.applicationNumber === "187-26-000309-STR");
  assert.equal(strAfter.length, strBefore + 1,
    `going back into review is a change and must show: ${JSON.stringify(strAfter.map((h) => [h.statusLabel, h.at]))}`);
});

await check("PER TARGET, NOT GLOBALLY: interleaved targets do not fake a change", async () => {
  // Both filings are now in different states. Sweep both twice more; neither moves.
  const rowsBefore = rowsForProject(project.id);
  const before = projectStatusHistory(db, project.id, 50).length;
  await poll(strTarget.id, IN_REVIEW);
  await poll(eleTarget.id, ISSUED);
  await poll(strTarget.id, IN_REVIEW);
  await poll(eleTarget.id, ISSUED);
  assert.equal(rowsForProject(project.id), rowsBefore,
    "an interleaved sweep of two settled filings wrote rows — the write gate is comparing against "
    + "the wrong target, or against the project instead of the target");
  const after = projectStatusHistory(db, project.id, 50);
  assert.equal(after.length, before,
    "an interleaved sweep of two settled filings added entries — the collapse is comparing "
    + `globally instead of per target: ${JSON.stringify(after.map((h) => [h.label, h.statusLabel, h.at]))}`);
});

await check("THE FIRST ROW OF A RUN SURVIVES, not the latest — the date is when it CHANGED", () => {
  const history = projectStatusHistory(db, project.id, 50);
  const ele = history.find((h) => h.applicationNumber === "194-26-001482-ELEC" && /issued/i.test(h.statusLabel))!;
  const firstIssued = db.get<{ created_at: string }>(
    `SELECT created_at FROM permit_status_checks
      WHERE target_id = ? AND outcome = 'issued' ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    [eleTarget.id],
  )!;
  assert.equal(ele.at, firstIssued.created_at,
    "the timeline is dated by the last time we LOOKED, not the moment the permit was issued");
});

await check("MUST EXEMPT email: an inbound AHJ email is always recorded", async () => {
  const before = rowsFor(eleTarget.id);
  await recordPermitStatusCheck(db, project.id, { targetId: eleTarget.id, source: "email", rawStatusText: ISSUED });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rowsFor(eleTarget.id), before + 1,
    "an email-sourced check was suppressed — email_project_matches.status_check_id would then "
    + "point at an older row than the email it describes");
});

await check("MUST EXEMPT manual: an operator's paste is always recorded", async () => {
  const before = rowsFor(eleTarget.id);
  await recordPermitStatusCheck(db, project.id, { targetId: eleTarget.id, source: "manual", rawStatusText: ISSUED });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rowsFor(eleTarget.id), before + 1, "an operator's own check vanished");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// A GENUINE CORRECTION IS NOT A DUPLICATE — the gate must not swallow one.
//
// The same unconditional insert also produced a fresh corrections row, a fresh
// human_review_items row and a fresh correction-triage job on EVERY sweep of a permit that had
// come back once. Gating the check row alone would leave those orphaned (a correction with no
// check row to hang off) and still duplicated. So all three are inside the gate — which makes
// "did we just lose a real correction?" the question this block has to answer.
// ─────────────────────────────────────────────────────────────────────────────────────────
const { project: corrProject } = createProject(db, {
  clientId: client.id, owner: "Correction Owner", street: "44 Revise Ave", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "7", acKw: "5.6",
});
const corrDetail = createPermitCheckTarget(db, corrProject.id, {
  jurisdiction: "City of Coos Bay", applicationNumber: "187-26-000401-STR",
  targetType: "permit", permitType: "building",
});
const corrTarget = corrDetail.permitCheckTargets[0]!;

await check("THE FIRST SIGHTING OF A CORRECTION LANDS IN FULL", async () => {
  await recordPermitStatusCheck(db, corrProject.id, { targetId: corrTarget.id, source: "portal", rawStatusText: CORRECTION });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rowsFor(corrTarget.id), 1, "the correction check itself was never written");
  assert.equal(correctionsFor(corrProject.id), 1,
    "a real correction was suppressed — the gate must never swallow the FIRST sighting of one");
  assert.equal(reviewItemsFor(corrProject.id, "correction"), 1, "the correction's review item is missing");
  const stored = db.get<{ correction_text?: string }>(
    "SELECT correction_text FROM corrections WHERE project_id = ?", [corrProject.id],
  );
  assert.match(String(stored?.correction_text || ""), /structural calculations/,
    "the correction landed without the text a coordinator has to act on");
});

await check("RE-READING THE SAME CORRECTION DOES NOT FILE IT AGAIN", async () => {
  await recordPermitStatusCheck(db, corrProject.id, { targetId: corrTarget.id, source: "portal", rawStatusText: CORRECTION });
  await recordPermitStatusCheck(db, corrProject.id, { targetId: corrTarget.id, source: "portal", rawStatusText: CORRECTION });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(correctionsFor(corrProject.id), 1,
    `${correctionsFor(corrProject.id)} corrections rows for ONE correction — every sweep of a `
    + "returned permit files it again, and triages it again");
  assert.equal(reviewItemsFor(corrProject.id, "correction"), 1, "and a new pending review item each sweep");
  assert.equal(rowsFor(corrTarget.id), 1, "and a new status row each sweep");
  assert.equal(auditChecks(corrProject.id), 3, "all three looks are still in the audit trail");
});

await check("A CORRECTION THAT COMES BACK AFTER A CHANGE IS A NEW CORRECTION", async () => {
  await recordPermitStatusCheck(db, corrProject.id, { targetId: corrTarget.id, source: "portal", rawStatusText: IN_REVIEW });
  await recordPermitStatusCheck(db, corrProject.id, { targetId: corrTarget.id, source: "portal", rawStatusText: CORRECTION });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(correctionsFor(corrProject.id), 2,
    "the permit went back into review and came back out again with a second correction, and the "
    + "second one was swallowed — suppression must be per CONSECUTIVE state, never permanent");
  assert.equal(rowsFor(corrTarget.id), 3, "in-review and the second correction are both transitions");
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// PART 2 — THE PRODUCTION READ PATH.
//
// publicProjectStatusPayload() is the entire body of GET /api/public/status/:token. This is the
// endpoint behind status.html's "Recent updates" card — the exact screen in the complaint.
// ═════════════════════════════════════════════════════════════════════════════════════════

const statusToken = ensureStatusShareToken(db, project.id);

await check("THE ROUTE STILL DELEGATES — the read wiring is in server.ts, not just available to it", () => {
  // A behavioural test cannot reach the route (server.ts listens at import), and this is the exact
  // hole the previous round fell through: the helper worked, was tested, and the endpoint built its
  // own payload beside it. So assert the wiring at the source, both ways.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "src", "server.ts"), "utf8");
  const at = src.indexOf('app.get("/api/public/status/:token"');
  assert.ok(at > 0, "the public status route is gone entirely");
  const nextRoute = src.slice(at + 40).search(/\napp\.(get|post|put|patch|delete|use)\(/);
  const body = src.slice(at, nextRoute > 0 ? at + 40 + nextRoute : at + 2000);
  assert.match(body, /publicProjectStatusPayload\(/,
    "the status route builds its own payload instead of calling publicProjectStatusPayload — the "
    + "collapse, the filing labels and the client wording all live in that function and none of "
    + "them reach the page from here");
  assert.doesNotMatch(body, /permitStatusChecks/,
    "the route is still reading permit_status_checks directly: that is the raw one-row-per-check "
    + "ladder, with no per-target collapse and nothing naming the filing");
  assert.match(src, /import \{[^}]*publicProjectStatusPayload[^}]*\} from "\.\/clientPortal"/,
    "publicProjectStatusPayload is not imported from clientPortal");
});

await check("THE ENDPOINT'S OWN PAYLOAD: no ladder, every line named", () => {
  const payload = publicProjectStatusPayload(db, statusToken)!;
  assert.ok(payload, "a valid status token resolved to nothing");
  // Sixteen real checks went through the writer above. The card must not be sixteen lines.
  assert.ok(payload.history.length <= 6,
    `the "Recent updates" card is back to a ladder: ${JSON.stringify(payload.history.map((h) => [h.label, h.statusLabel, h.at]))}`);
  for (const h of payload.history) {
    assert.ok(h.label, `a timeline entry with no subject: ${JSON.stringify(h)}`);
    assert.ok(h.applicationNumber, `a timeline entry with no reference: ${JSON.stringify(h)}`);
    assert.ok(h.statusLabel, `a timeline entry with no words: ${JSON.stringify(h)}`);
  }
  const str = payload.history.find((h) => h.applicationNumber === "187-26-000309-STR");
  const ele = payload.history.find((h) => h.applicationNumber === "194-26-001482-ELEC");
  assert.ok(str && ele, `both filings must appear on the card: ${JSON.stringify(payload.history)}`);
  assert.equal(str!.label, trackLabel("permit", "building"), "the STR filing is the building permit");
  assert.equal(ele!.label, trackLabel("permit", "electrical"), "the ELEC filing is the electrical permit");
  assert.notEqual(str!.label, ele!.label, "both permits are still wearing one label");
});

await check("THE ENDPOINT SAYS WHO IS WAITING — on the badges too, not only the timeline", async () => {
  // status.html renders tracks and history from the same payload. The tracks half shipped
  // latestStatusLabel RAW, so Coos Bay's "Action needed before review" reached a client as an
  // instruction to THEM when the work is ours.
  await poll(strTarget.id, INTAKE_NEEDED);
  const payload = publicProjectStatusPayload(db, statusToken)!;
  const strTrack = payload.tracks.find((t) => t.applicationNumber === "187-26-000309-STR")!;
  assert.match(strTrack.statusLabel, /\bus\b/i,
    `the track badge still reads "${strTrack.statusLabel}" — the raw operator label, which a client `
    + "reads as their own action");
  assert.doesNotMatch(strTrack.statusLabel, /^Action needed/i, strTrack.statusLabel);
  assert.equal(strTrack.outcome, "needs_human_review",
    "the raw outcome must survive untouched — status.html colours the badge from it");
  const eleTrack = payload.tracks.find((t) => t.applicationNumber === "194-26-001482-ELEC")!;
  assert.match(eleTrack.statusLabel, /issued/i, eleTrack.statusLabel);
  // And the same wording on the newest timeline entry.
  assert.match(payload.history[0].statusLabel, /\bus\b/i, payload.history[0].statusLabel);
});

await check("THE PUBLIC PAYLOAD CARRIES NO INTERNAL PROSE", () => {
  // raw_status_text and message are scraped portal prose and forwarded AHJ email carrying
  // homeowner names and examiners' direct lines. This page is public to anyone holding the link.
  const blob = JSON.stringify(publicProjectStatusPayload(db, statusToken));
  assert.doesNotMatch(blob, /assigned to a plans examiner/i, `raw portal text reached the client: ${blob}`);
  assert.doesNotMatch(blob, /rawStatusText|raw_status_text|"message"/i, blob);
  assert.doesNotMatch(blob, /structural calculations/i, "another project's correction text is on this page");
});

await check("A BLANK OR UNKNOWN TOKEN RESOLVES TO NOTHING (the route 404s on null)", () => {
  // status_share_token defaults to '' on every project row, so a plain equality match on the empty
  // string would hand the first never-shared project to anyone hitting /status with no token.
  assert.equal(publicProjectStatusPayload(db, ""), null);
  assert.equal(publicProjectStatusPayload(db, "   "), null);
  assert.equal(publicProjectStatusPayload(db, "not-a-real-token"), null);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE LADDER ALREADY IN THE DATABASE. The write gate stops NEW ladders; it cannot touch the rows
// written before it landed, and those rows are never deleted — email_project_matches
// .status_check_id is a foreign key into this table and the per-check trail is evidence. So the
// collapse at READ time has to keep working on its own.
//
// Built with `manual`-sourced checks, which are exempt from the gate and therefore still write a
// row every time: a real one-row-per-check ladder, through the real writer, with no raw SQL.
// ─────────────────────────────────────────────────────────────────────────────────────────
const { project: legacyProject } = createProject(db, {
  clientId: client.id, owner: "Legacy Ladder Owner", street: "9 Old Rows Ln", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "9", acKw: "7.2",
});
const legacyDetail = createPermitCheckTarget(db, legacyProject.id, {
  jurisdiction: "Pacific Power", applicationNumber: "APP-111667",
  targetType: "nem", permitType: "nem",
});
const nemTarget = legacyDetail.permitCheckTargets[0]!;
const legacyToken = ensureStatusShareToken(db, legacyProject.id);

await check("A LADDER ALREADY IN THE TABLE COLLAPSES AT READ TIME", async () => {
  for (let i = 0; i < 5; i++) {
    await recordPermitStatusCheck(db, legacyProject.id, { targetId: nemTarget.id, source: "manual", rawStatusText: IN_REVIEW });
  }
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rowsFor(nemTarget.id), 5,
    "the fixture did not actually build a ladder, so the collapse below proves nothing");
  const payload = publicProjectStatusPayload(db, legacyToken)!;
  assert.equal(payload.history.length, 1,
    `five identical rows reached the client as ${payload.history.length} lines — the read-time `
    + `collapse is gone: ${JSON.stringify(payload.history)}`);
  assert.equal(payload.history[0].label, "Utility interconnection (NEM)",
    `the NEM filing is not named on the card: ${JSON.stringify(payload.history[0])}`);
  assert.equal(payload.history[0].applicationNumber, "APP-111667");
});

await check("...and the FIRST of the five is the one kept, with the date it changed", async () => {
  const first = db.get<{ created_at: string }>(
    "SELECT created_at FROM permit_status_checks WHERE target_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1",
    [nemTarget.id],
  )!;
  assert.equal(publicProjectStatusPayload(db, legacyToken)!.history[0].at, first.created_at,
    "the collapsed run is dated by the last row of it — the client is told a three-week-old status "
    + "changed today");
  // A real move, through the same exempt source, still shows as a second line.
  await recordPermitStatusCheck(db, legacyProject.id, { targetId: nemTarget.id, source: "manual", rawStatusText: NEM_APPROVED });
  await new Promise((r) => setTimeout(r, 60));
  const after = publicProjectStatusPayload(db, legacyToken)!.history;
  assert.equal(after.length, 2, `the approval never surfaced: ${JSON.stringify(after)}`);
  assert.match(after[0].statusLabel, /interconnection approved/i, after[0].statusLabel);
});

await check("A PROJECT WITH NO CHECKS AT ALL yields an empty timeline, not a crash", () => {
  const { project: fresh } = createProject(db, {
    clientId: client.id, owner: "Nothing Yet", street: "2 Empty Rd", city: "Coos Bay",
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "5", acKw: "4",
  });
  const token = ensureStatusShareToken(db, fresh.id);
  assert.deepEqual(publicProjectStatusPayload(db, token)!.history, []);
  assert.deepEqual(projectStatusHistory(db, fresh.id), []);
  assert.deepEqual(projectStatusHistory(db, ""), []);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// PART 3 — THE POLICY AND THE WORDING, on their own.
//
// UNIT COVER ONLY. Everything below calls a helper directly, which is what the previous version
// of this file did for ALL of its assertions while production called none of them. These checks
// are here because they pin down branches the scenarios above cannot reach cheaply (an
// outcome-identical label move, every classifier branch's client wording) — they are not, and
// must never again be, the evidence that the fix is connected. Part 1 and Part 2 are that.
// ═════════════════════════════════════════════════════════════════════════════════════════

await check("POLICY: an unchanged poll is not a change", () => {
  const prev = { outcome: "waiting", statusLabel: "In review" };
  assert.equal(shouldRecordStatusCheck(prev, { outcome: "waiting", statusLabel: "In review" }, "portal"), false,
    "an identical portal poll was treated as a transition — this is the row-per-check bug");
  assert.equal(shouldRecordStatusCheck(prev, { outcome: "waiting", statusLabel: "In review" }, "public_url"), false);
  assert.equal(shouldRecordStatusCheck(prev, { outcome: "waiting", statusLabel: "In review" }, "mock"), false);
});

await check("POLICY: the first check on a target always counts", () => {
  assert.equal(shouldRecordStatusCheck(null, { outcome: "waiting", statusLabel: "In review" }, "portal"), true,
    "a target with no target row at all must still record");
  assert.equal(shouldRecordStatusCheck({ outcome: "", statusLabel: "" }, { outcome: "waiting", statusLabel: "In review" }, "portal"), true,
    "nothing → something is a transition");
});

await check("POLICY: a LABEL-only move counts, even when the outcome is unchanged", () => {
  // needs_human_review carries three labels and ready_for_issue carries two. On an outcome-only
  // comparison, a permit going from "Needs human review" to "Action needed before review" — the
  // agency has stopped and is waiting on US — would be swallowed as "nothing happened". No live
  // status text pairs those two labels back to back, which is why this branch is pinned here.
  assert.equal(
    shouldRecordStatusCheck(
      { outcome: "needs_human_review", statusLabel: "Needs human review" },
      { outcome: "needs_human_review", statusLabel: "Action needed before review" },
      "portal",
    ),
    true,
    "a label-only transition was swallowed; compare on BOTH outcome and statusLabel",
  );
  assert.equal(
    shouldRecordStatusCheck(
      { outcome: "ready_for_issue", statusLabel: "Ready for issue" },
      { outcome: "ready_for_issue", statusLabel: "Ready for issue - fee/payment needed" },
      "portal",
    ),
    true,
    "a fee falling due is news",
  );
  assert.equal(shouldRecordStatusCheck({ outcome: "waiting", statusLabel: "In review" }, { outcome: "issued", statusLabel: "Permit issued" }, "portal"), true);
});

await check("POLICY: email and manual are EXEMPT — they are events, not polls", () => {
  const same = { outcome: "waiting", statusLabel: "In review" };
  assert.equal(shouldRecordStatusCheck(same, same, "email"), true,
    "gating email would silently link an inbound AHJ email to an OLDER status check row");
  assert.equal(shouldRecordStatusCheck(same, same, "manual"), true,
    "an operator who pasted status text expects a record of having done so");
});

await check("THE INVERSION: 'the agency is reviewing' vs 'the agency is waiting on us'", () => {
  const them = publicCheckLabel("waiting", "In review");
  const us = publicCheckLabel("needs_human_review", "Action needed before review");
  assert.match(them, /jurisdiction/i, `"${them}" does not say who is reviewing`);
  assert.notEqual(them, us);
  assert.match(us, /\bus\b/i,
    `"${us}" still names an action without its owner — the client reads it as theirs`);
  assert.doesNotMatch(us, /^Action needed/i,
    "the raw operator label reached the client page unchanged");
  // MUST NOT tell a client to act on work that is ours.
  for (const phrase of [/you (?:must|need|should)/i, /please (?:send|provide|upload)/i, /action required from you/i]) {
    assert.doesNotMatch(us, phrase, `the client is being told to act on our own work: "${us}"`);
  }
});

await check("THE WORDING IS A MAP, NOT A GUESS: an unknown label passes through", () => {
  assert.equal(publicCheckLabel("waiting", "Some legacy label we never emitted"), "Some legacy label we never emitted");
  assert.equal(publicCheckLabel("waiting", ""), "", "a blank label must stay blank so the page can fall back");
  assert.equal(publicCheckLabel("issued", "Permit issued"), "Permit issued");
});

await check("NO OPERATOR JARGON REACHES THE CLIENT PAGE", () => {
  // The classifier's labels are written for somebody reading a work queue. "Reviewed by AHJ",
  // "Correction flagged" and "Needs human review" are all names for OUR queue states, and a
  // paying customer reading them learns nothing and asks. A wording that is already plain
  // ("Permit issued") is correct as it stands — the defect is jargon, not sameness. Drive the
  // real classifier rather than restating its label list here, so a new branch is caught.
  const JARGON: Array<[RegExp, string]> = [
    [/\bAHJ\b/, "our acronym for the jurisdiction"],
    [/human review/i, "the name of our internal queue"],
    [/\bflagged\b/i, "what our monitor did, not what the city did"],
    [/^no status text/i, "a description of our scraper's output"],
    [/^action needed/i, "an action with no owner — the client reads it as theirs"],
  ];
  const samples = [IN_REVIEW, INTAKE_NEEDED, ISSUED,
    "Record Status: Approved. Plan review complete.",
    "Record Status: Ready for Issue. Fees due.",
    CORRECTION,
    NEM_APPROVED,
    ""]; // the no-text branch
  const seen = new Set<string>();
  for (const raw of samples) {
    const c = classifyPermitStatusText(raw);
    seen.add(`${c.outcome}::${c.statusLabel}`);
    const words = publicCheckLabel(c.outcome, c.statusLabel);
    for (const [pattern, why] of JARGON) {
      assert.doesNotMatch(words, pattern,
        `"${c.statusLabel}" (${c.outcome}) reaches the client as "${words}" — ${why}`);
    }
  }
  // And the fallback branch, which no sample text reaches.
  assert.doesNotMatch(publicCheckLabel("needs_human_review", "Needs human review"), /human review/i);
  assert.ok(seen.size >= 7, `the samples exercised only ${seen.size} classifier branches`);
});

await check("THE CORRECTION NOTE NAMES ITS FILING", () => {
  const proj = { id: "x", ahj: "City of Coos Bay", utility: "Pacific Power" };
  const ele = clientUpdateFor(db, proj as never, "correction_flagged", { targetType: "permit", permitType: "electrical" })!;
  assert.match(ele.headline, /electrical permit application/,
    `with two permits outstanding the client cannot tell which came back: ${ele.headline}`);
  const unknown = clientUpdateFor(db, proj as never, "correction_flagged", { targetType: "permit", permitType: "" })!;
  assert.match(unknown.headline, /sent the application back/, unknown.headline);
  assert.doesNotMatch(unknown.headline, /electrical|building/i,
    `a trade was asserted with no discipline on file: ${unknown.headline}`);
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nstatusHistoryTransitions: all checks passed."
  : `\nstatusHistoryTransitions: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
