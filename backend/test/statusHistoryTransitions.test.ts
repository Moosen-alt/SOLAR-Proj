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
//   MUST DISTINGUISH — a reading we CHECKED and agree with, a reading we checked and DISAGREE with,
//                    and a reading OUR OWN CHECK COULD NOT MAKE. Three states, three encodings on
//                    the wire, three renders on both customer pages. The drift pass is made to
//                    throw and the payload is compared against a confirmed-fresh one: when those
//                    two were byte-identical, a permit stalled at the counter since Sep 3 went on
//                    telling the homeowner the jurisdiction was reviewing it. The pages are RUN
//                    (node:vm over their shipped inline script), not grepped.
//
//   npx tsx backend/test/statusHistoryTransitions.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The two customer pages are inline-script HTML. node:vm runs that script — the shipped bytes —
// against a stub document, so what this file asserts about status.html and portal.html is the
// markup they actually produce and not a string that happens to appear in them.
import vm from "node:vm";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-history-transitions-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, createPermitCheckTarget, recordPermitStatusCheck } = await import("../src/repository");
const { publicProjectStatusPayload, projectStatusHistory, publicCheckLabel, trackLabel, trackKind,
  clientPortalPayload, ensureClientPortalToken } = await import("../src/clientPortal");
const { ensureStatusShareToken } = await import("../src/clientNotifier");
const { shouldRecordStatusCheck, classifyPermitStatusText, staleStatusClassifications,
  scanStaleStatusClassifications, classificationDrift } = await import("../src/permitMonitor");
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
  assert.equal(payload.history[0].label, "Utility interconnection",
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
// PART 2B — TWO THINGS THE PAGE SAID THAT WERE NOT TRUE.
//
//   1. A NEM ROW IS NOT REVIEWED BY A JURISDICTION. publicCheckLabel took no track, so an
//      interconnection application sitting in waiting::"In review" told the client "In review by
//      the jurisdiction" — about an application Pacific Power holds and no city has ever seen.
//      Both surfaces are driven here: the per-project page (/status) and the per-client tracker
//      (/portal), because the same wrong badge was on both.
//   2. A STORED READING CAN PREDATE THE RULE THAT WOULD CHANGE IT. Ann's and Ivy's structural
//      permits have read "Intake Requirements Needed" since Sep 3; the rule that calls that "the
//      city is waiting on US" landed an hour AFTER the last check ran. The client page reads
//      STORED rows, so it keeps publishing "In review by the jurisdiction" about a stalled permit.
//      Nothing may rewrite those rows — permit_status_checks is an audit trail — so the page has
//      to say the reading needs confirming, and a REAL re-check has to write a NEW row.
// ═════════════════════════════════════════════════════════════════════════════════════════

const { project: nemProject } = createProject(db, {
  clientId: client.id, owner: "Interconnection Owner", street: "88 Utility Way", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "6", acKw: "4.8",
});
createPermitCheckTarget(db, nemProject.id, {
  jurisdiction: "City of Coos Bay", applicationNumber: "187-26-000777-STR",
  targetType: "permit", permitType: "building",
});
const nemProjectDetail = createPermitCheckTarget(db, nemProject.id, {
  jurisdiction: "Pacific Power", applicationNumber: "APP-222888",
  targetType: "nem", permitType: "nem",
});
const nemStrTarget = nemProjectDetail.permitCheckTargets.find((t) => t.applicationNumber.endsWith("-STR"))!;
const nemAppTarget = nemProjectDetail.permitCheckTargets.find((t) => t.applicationNumber === "APP-222888")!;
const nemToken = ensureStatusShareToken(db, nemProject.id);

await check("A NEM ROW NEVER SAYS 'JURISDICTION' — through the endpoint, badges and timeline", async () => {
  // ONE stored state, TWO reviewers. Both filings are polled with the same text and both land on
  // waiting::"In review" — the defect is entirely in what the page then calls that state.
  await recordPermitStatusCheck(db, nemProject.id, { targetId: nemStrTarget.id, source: "portal", rawStatusText: IN_REVIEW });
  await recordPermitStatusCheck(db, nemProject.id, { targetId: nemAppTarget.id, source: "portal", rawStatusText: IN_REVIEW });
  await new Promise((r) => setTimeout(r, 60));

  const stored = db.query<{ status_label: string; outcome: string }>(
    "SELECT status_label, outcome FROM permit_status_checks WHERE project_id = ?", [nemProject.id],
  );
  assert.deepEqual([...new Set(stored.map((s) => `${s.outcome}::${s.status_label}`))], ["waiting::In review"],
    "the fixture's two filings are not in the same stored state, so a wording difference below "
    + "would prove nothing about the track");

  const payload = publicProjectStatusPayload(db, nemToken)!;
  const nemTrack = payload.tracks.find((t) => t.applicationNumber === "APP-222888")!;
  const strTrack = payload.tracks.find((t) => t.applicationNumber === "187-26-000777-STR")!;
  assert.doesNotMatch(nemTrack.statusLabel, /jurisdiction|\bAHJ\b/i,
    `the interconnection badge reads "${nemTrack.statusLabel}" — Pacific Power reviews this `
    + "application and no jurisdiction is involved in it");
  assert.match(nemTrack.statusLabel, /utility/i, nemTrack.statusLabel);
  assert.match(strTrack.statusLabel, /jurisdiction/i,
    `the building permit badge reads "${strTrack.statusLabel}" — the city does review this one`);
  assert.doesNotMatch(strTrack.statusLabel, /\butility\b/i, strTrack.statusLabel);
  assert.equal(nemTrack.label, "Utility interconnection");

  const nemHist = payload.history.find((h) => h.applicationNumber === "APP-222888")!;
  const strHist = payload.history.find((h) => h.applicationNumber === "187-26-000777-STR")!;
  assert.ok(nemHist && strHist, `both filings must be on the timeline: ${JSON.stringify(payload.history)}`);
  assert.doesNotMatch(nemHist.statusLabel, /jurisdiction|\bAHJ\b/i,
    `the timeline tells the client a jurisdiction is reviewing their interconnection: "${nemHist.statusLabel}"`);
  assert.match(nemHist.statusLabel, /utility/i, nemHist.statusLabel);
  assert.match(strHist.statusLabel, /jurisdiction/i, strHist.statusLabel);

  // AND THE STORED LABEL IS UNTOUCHED. status_label is a MATCHING KEY — PUBLIC_CHECK_LABELS keys
  // on it, shouldRecordStatusCheck compares on it, and the classifier writes it. Only the display
  // value may differ per track.
  const after = db.query<{ status_label: string }>(
    "SELECT status_label FROM permit_status_checks WHERE project_id = ?", [nemProject.id],
  );
  assert.deepEqual([...new Set(after.map((s) => s.status_label))], ["In review"],
    "the stored matching key was rewritten to make the wording work — every consumer that "
    + "compares on status_label now disagrees with the classifier");
});

await check("...and on the per-CLIENT tracker's badges too (portal.html), not only /status", () => {
  // The same wrong wording was on both public pages, and a fix to one has missed the other before.
  const portalToken = ensureClientPortalToken(db, client.id);
  const portal = clientPortalPayload(db, portalToken)!;
  const proj = portal.projects.find((p) => p.id === nemProject.id)!;
  assert.ok(proj, "the tracker lost the project entirely");
  const nemTrack = proj.tracks.find((t) => t.applicationNumber === "APP-222888")!;
  const strTrack = proj.tracks.find((t) => t.applicationNumber === "187-26-000777-STR")!;
  assert.doesNotMatch(nemTrack.statusLabel, /jurisdiction|\bAHJ\b/i,
    `the tracker's interconnection badge reads "${nemTrack.statusLabel}"`);
  assert.match(nemTrack.statusLabel, /utility/i, nemTrack.statusLabel);
  assert.match(strTrack.statusLabel, /jurisdiction/i, strTrack.statusLabel);
  const nemHist = proj.history.find((h) => h.applicationNumber === "APP-222888")!;
  assert.doesNotMatch(nemHist.statusLabel, /jurisdiction|\bAHJ\b/i, nemHist.statusLabel);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// A STORED READING THAT PREDATES THE RULE.
//
// WHY THE FIXTURE ENDS IN A RAW UPDATE, which this file otherwise never does: the real writer
// CANNOT produce a historically-stale row. It classifies with today's rules by construction, so
// the only way to hold the state Ann's row is in — text that today reads "the city is waiting on
// us", stored under the verdict the OLD rules gave it — is to write the row through the real
// writer and then move the two columns the old rules would have written. The check row AND the
// target's latest_* pair are both moved, because production keeps them in step (the target UPDATE
// is ungated, so it always mirrors the newest check) and a fixture where they disagree would test
// a state production cannot hold.
//
// The precondition below then proves the fixture is actually stale under TODAY's classifier — so
// the day a rule change makes that text classify as "In review" again, this fails loudly instead
// of passing while proving nothing.
// ─────────────────────────────────────────────────────────────────────────────────────────
const { project: staleProject } = createProject(db, {
  clientId: client.id, owner: "Stalled At Intake", street: "1780 Ocean Blvd SE", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8.36", acKw: "7.68",
});
const staleDetail = createPermitCheckTarget(db, staleProject.id, {
  jurisdiction: "City of Coos Bay", applicationNumber: "187-26-000309-STR",
  targetType: "permit", permitType: "building",
});
const staleTarget = staleDetail.permitCheckTargets[0]!;
const staleToken = ensureStatusShareToken(db, staleProject.id);
let staleCheckId = "";

await check("PRECONDITION: the stored row holds a verdict today's rules disagree with", async () => {
  await recordPermitStatusCheck(db, staleProject.id, { targetId: staleTarget.id, source: "portal", rawStatusText: INTAKE_NEEDED });
  await new Promise((r) => setTimeout(r, 60));
  const row = db.get<{ id: string; raw_status_text: string; outcome: string; status_label: string }>(
    "SELECT id, raw_status_text, outcome, status_label FROM permit_status_checks WHERE target_id = ? ORDER BY rowid DESC LIMIT 1",
    [staleTarget.id],
  )!;
  staleCheckId = row.id;
  // Move it back to what the pre-fix classifier wrote for this exact text. Both halves, together.
  db.run("UPDATE permit_status_checks SET outcome = 'waiting', status_label = 'In review' WHERE id = ?", [row.id]);
  db.run("UPDATE permit_check_targets SET latest_outcome = 'waiting', latest_status_label = 'In review' WHERE id = ?", [staleTarget.id]);

  const stored = db.get<{ raw_status_text: string; outcome: string; status_label: string }>(
    "SELECT raw_status_text, outcome, status_label FROM permit_status_checks WHERE id = ?", [row.id],
  )!;
  assert.match(stored.raw_status_text, /Intake Requirements Needed/i,
    "the fixture's stored text is not the stalled-at-intake record this is about");
  const today = classifyPermitStatusText(stored.raw_status_text);
  assert.notEqual(`${today.outcome}::${today.statusLabel}`, `${stored.outcome}::${stored.status_label}`,
    "TODAY's classifier agrees with the stored row, so there is no staleness to detect and every "
    + "assertion below would pass without the fix");
  // And the drift helper itself says so, in the same terms the operator surface reports.
  const drift = classificationDrift({
    outcome: stored.outcome, statusLabel: stored.status_label, rawStatusText: stored.raw_status_text,
  });
  assert.equal(drift.stale, true);
  assert.equal(drift.storedStatusLabel, "In review");
  assert.equal(drift.currentStatusLabel, "Action needed before review");
});

await check("THE PAGE MARKS IT: badge and timeline both say the reading needs confirming", () => {
  const payload = publicProjectStatusPayload(db, staleToken)!;
  const track = payload.tracks.find((t) => t.applicationNumber === "187-26-000309-STR")!;
  assert.equal(track.needsRecheck, true,
    `the client is told "${track.statusLabel}" as a plain fact about a permit whose stored reading `
    + "predates the rule that would change it — a classifier fix that never reaches the stored "
    + "rows is invisible to the customer");
  assert.equal(track.reading, "stale",
    `a reading we CHECKED and disagree with is reported as "${track.reading}"`);
  assert.equal(payload.history[0].needsRecheck, true,
    `the timeline publishes the stale reading unqualified: ${JSON.stringify(payload.history[0])}`);
  assert.equal(payload.history[0].reading, "stale", JSON.stringify(payload.history[0]));
  // The wording is still the STORED verdict, not a silently re-derived one. Quietly re-classifying
  // at read time would publish a verdict no check ever produced and leave the stored row — the one
  // every other consumer reads — wrong and unnoticed.
  assert.match(track.statusLabel, /In review by the jurisdiction/,
    `the page re-derived a new verdict instead of flagging the old one: "${track.statusLabel}"`);
  const stored = db.get<{ outcome: string; status_label: string }>(
    "SELECT outcome, status_label FROM permit_status_checks WHERE id = ?", [staleCheckId],
  )!;
  assert.equal(`${stored.outcome}::${stored.status_label}`, "waiting::In review",
    "reading the page REWROTE the audit row — email_project_matches.status_check_id points into "
    + "this table and correction_id/reviewed_by_ahj feed other logic; history is not editable");
});

await check("A CURRENT READING IS NOT MARKED — the flag is evidence, not decoration", () => {
  // The NEM/permit project above is polled with text today's rules agree with. If everything is
  // marked, the mark says nothing.
  const payload = publicProjectStatusPayload(db, nemToken)!;
  for (const t of payload.tracks) {
    assert.equal(t.needsRecheck, false, `${t.applicationNumber} was marked stale while it is current`);
    assert.equal(t.reading, "current",
      `${t.applicationNumber} reads "${t.reading}" after a pass that ran and agreed with it — if a `
      + "confirmed reading cannot say so, the third value has eaten the second");
  }
  for (const h of payload.history) {
    assert.equal(h.needsRecheck, false, `${h.applicationNumber} (${h.at}) was marked stale while it is current`);
  }
});

await check("THE OPERATOR SURFACE: which rows, what the rule says now, and the call that fixes it", () => {
  const stale = staleStatusClassifications(db, [staleProject.id]);
  assert.equal(stale.length, 1, `the stalled filing is not reported: ${JSON.stringify(stale)}`);
  const only = stale[0];
  assert.equal(only.targetId, staleTarget.id);
  assert.equal(only.checkId, staleCheckId, "the report must name the exact audit row, not a copy");
  assert.equal(only.storedStatusLabel, "In review");
  assert.equal(only.currentOutcome, "needs_human_review");
  assert.equal(only.currentStatusLabel, "Action needed before review");
  assert.equal(only.applicationNumber, "187-26-000309-STR");
  assert.equal(only.hasPortalUrl, false,
    "this target has no portal URL, and an operator handed a fetch trigger for it would get "
    + "'No status text available' — the report has to say which of the two they are getting");
  // NO SCRAPED PROSE, on an operator route or anywhere else. The condition sentence lives in the
  // classifier's message and is not needed to decide to re-check.
  const blob = JSON.stringify(stale);
  assert.doesNotMatch(blob, /rawStatusText|raw_status_text|Submitted 09\/02/i, blob);
  // ...and a project whose readings are current reports nothing at all.
  assert.deepEqual(staleStatusClassifications(db, [nemProject.id]), []);
  assert.deepEqual(staleStatusClassifications(db, []), []);
});

await check("THE CURE IS A NEW ROW: a real re-check clears the mark and leaves history intact", async () => {
  // This is the production path the operator surface points at — POST /api/projects/:id/
  // permit-checks, whose entire body is recordPermitStatusCheck. The stale row is not touched;
  // a second row is written, classified by today's rules.
  const before = rowsFor(staleTarget.id);
  await recordPermitStatusCheck(db, staleProject.id, { targetId: staleTarget.id, source: "manual", rawStatusText: INTAKE_NEEDED });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rowsFor(staleTarget.id), before + 1, "the re-check wrote no new row");
  const preserved = db.get<{ outcome: string; status_label: string }>(
    "SELECT outcome, status_label FROM permit_status_checks WHERE id = ?", [staleCheckId],
  )!;
  assert.equal(`${preserved.outcome}::${preserved.status_label}`, "waiting::In review",
    "the re-check rewrote the old row instead of writing a new one — that is the audit trail "
    + "being edited to say we always knew");

  const payload = publicProjectStatusPayload(db, staleToken)!;
  const track = payload.tracks.find((t) => t.applicationNumber === "187-26-000309-STR")!;
  assert.equal(track.needsRecheck, false, "the mark survived a fresh reading — it is not evidence, it is noise");
  assert.match(track.statusLabel, /\bus\b/i,
    `after a real check the client is finally told who is holding it: "${track.statusLabel}"`);
  // The superseded entry stays on the timeline, unmarked: it is what we believed then, not a
  // claim about today.
  assert.equal(payload.history[0].needsRecheck, false, JSON.stringify(payload.history[0]));
  const old = payload.history.find((h) => /In review by the jurisdiction/.test(h.statusLabel));
  assert.ok(old, `the earlier reading vanished from the timeline: ${JSON.stringify(payload.history)}`);
  assert.equal(old!.needsRecheck, false,
    "a superseded entry is marked 'needs confirming' — history is not re-opened because the rules "
    + "moved on afterwards");
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE TWO CUSTOMER PAGES, ACTUALLY RUN.
//
// The previous version of this check GREPPED status.html and portal.html for `t.needsRecheck`.
// That is the same defect this file was opened over: a string that appears in a file is not a
// caller, and a page can hold the identifier and still render nothing a homeowner can see.
//
// So the inline <script> of each SHIPPED page is executed — the real markup, byte for byte, in a
// node:vm context with a stub document and a fetch that answers with THE REAL PAYLOAD from the
// real builder above. What is asserted is the HTML the page put on screen.
//
// The pages swallow their own errors ("This status link isn't valid anymore"), so every render
// asserts it produced the real card first. Without that, a harness that fed the page nothing would
// sail through every doesNotMatch below.
// ─────────────────────────────────────────────────────────────────────────────────────────
async function renderCustomerPage(file: string, payload: unknown): Promise<string> {
  const html = fs.readFileSync(path.join(REPO, "frontend", file), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1,
    `${file} has ${scripts.length} inline scripts; this harness runs exactly one and would be `
    + "testing the wrong half of the page");
  const app = { innerHTML: "" };
  const fetched: string[] = [];
  const sandbox: Record<string, unknown> = {
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    setTimeout,
    document: { getElementById: (id: string) => (id === "app" ? app : { innerHTML: "" }) },
    location: { search: "?token=harness" },
    fetch: async (url: string) => {
      fetched.push(String(url));
      return { ok: true, status: 200, json: async () => payload };
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${scripts[0]}\n;globalThis.__rendered = load();`, context, { filename: file });
  await (sandbox as { __rendered?: Promise<void> }).__rendered;
  assert.ok(fetched.length > 0, `${file} never asked for its payload`);
  return String(app.innerHTML || "");
}
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
/** The rendered markup from an application number to the end of its row — the caveat's own scope. */
const rowAfter = (html: string, marker: string): string => {
  const at = html.indexOf(marker);
  assert.notEqual(at, -1, `the rendered page never mentions ${marker}`);
  return html.slice(at, at + 500);
};

// ═════════════════════════════════════════════════════════════════════════════════════════
// PART 2b — THE TWO RISKS ROUND 3 LEFT OPEN.
//
//   1. THE ORPHAN. GET /api/projects/:id/permit-checks/stale shipped with ZERO production
//      callers and a test that GREPPED server.ts for its own source text. That is the same
//      defect as the bug it was written to fix — a classifier correction that reaches nobody
//      who can act on it — reproduced inside the fix. It is now called by the operator
//      dashboard, and the checks below DRIVE THE DASHBOARD: they import the real
//      frontend/dashboard.js as a module against a stub DOM and call selectProject(), the same
//      entry point the router calls when an operator opens a project. No string matching.
//
//   2. THE UNGUARDED DRIFT PASS on the customer's critical path. staleTargetIds is reached from
//      publicProjectStatusPayload (the tokenized page we EMAIL a homeowner), clientPortalPayload
//      and projectStatusHistory, and it re-ran a JOIN plus the whole classifier with no try/catch.
//      A throw there served a 500 to a customer over a caveat. The failure is injected below,
//      through the real db.query the real payload builders use.
//
// THE FIXTURE IS A SECOND, PERMANENTLY-STALE PROJECT. The one above is CURED by the re-check test
// directly overhead, and a "nothing is stale" report proves nothing about a staleness report. Two
// targets, deliberately: the ELECTRICAL one is current and the STRUCTURAL one is stale, which is
// exactly Ann's and Ivy's shape — and the structural target is NOT the project's first, so a
// re-check that quietly files against permitCheckTargets[0] records the wrong permit.
// ═════════════════════════════════════════════════════════════════════════════════════════
const { project: driftProject } = createProject(db, {
  clientId: client.id, owner: "Drift Guard", street: "990 Empire Blvd", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "3.52", acKw: "3.072",
});
createPermitCheckTarget(db, driftProject.id, {
  jurisdiction: "Coos County", applicationNumber: "187-26-000401-ELEC",
  targetType: "permit", permitType: "electrical",
});
const driftDetail2 = createPermitCheckTarget(db, driftProject.id, {
  jurisdiction: "City of Coos Bay", applicationNumber: "187-26-000401-STR",
  targetType: "permit", permitType: "building",
});
const driftElec = driftDetail2.permitCheckTargets.find((t) => t.permitType === "electrical")!;
const driftStr = driftDetail2.permitCheckTargets.find((t) => t.permitType === "building")!;
const driftToken = ensureStatusShareToken(db, driftProject.id);

await check("PRECONDITION: one stale filing, one current, on the same project", async () => {
  await recordPermitStatusCheck(db, driftProject.id, { targetId: driftElec.id, source: "portal", rawStatusText: ISSUED });
  await recordPermitStatusCheck(db, driftProject.id, { targetId: driftStr.id, source: "portal", rawStatusText: INTAKE_NEEDED });
  await new Promise((r) => setTimeout(r, 60));
  // Same move as the first fixture: put the structural row back under the verdict the OLD rules
  // gave its text, in both places production keeps in step.
  const row = db.get<{ id: string }>(
    "SELECT id FROM permit_status_checks WHERE target_id = ? ORDER BY rowid DESC LIMIT 1", [driftStr.id],
  )!;
  db.run("UPDATE permit_status_checks SET outcome = 'waiting', status_label = 'In review' WHERE id = ?", [row.id]);
  db.run("UPDATE permit_check_targets SET latest_outcome = 'waiting', latest_status_label = 'In review' WHERE id = ?", [driftStr.id]);

  const scan = scanStaleStatusClassifications(db, [driftProject.id]);
  assert.equal(scan.checked, true, "the drift pass did not even run on the fixture");
  assert.equal(scan.readings.length, 1,
    `the fixture must hold exactly one stale filing, got ${JSON.stringify(scan.readings.map((s) => s.applicationNumber))} — `
    + "with none of them stale every assertion below passes without the fix");
  assert.equal(scan.readings[0].targetId, driftStr.id, "the STRUCTURAL filing is the stale one");
  assert.equal(driftDetail2.permitCheckTargets.length, 2,
    "one filing must be current while the other is stale — if both are stale, 'only the stale one "
    + "is reported' is not being tested at all");
  assert.notEqual(driftElec.id, driftStr.id);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// RISK 2 — A DRIFT-PASS FAILURE MUST NOT REACH THE CUSTOMER, AND MUST NOT READ AS FRESHNESS.
//
// Injected through db.query, which is what staleStatusClassifications actually calls, and keyed
// on the drift query's own signature so every OTHER read the payload builders do still works.
// Anything coarser would prove the page dies of something unrelated.
// ─────────────────────────────────────────────────────────────────────────────────────────
const realQuery = db.query.bind(db);
const INJECTED = "injected: the drift pass exploded";
function breakDriftPass(): () => void {
  (db as unknown as { query: unknown }).query = (sql: string, params?: unknown[]) => {
    if (/MAX\(c2\.rowid\)/.test(String(sql))) throw new Error(INJECTED);
    return (realQuery as (s: string, p?: unknown[]) => unknown)(sql, params);
  };
  return () => { (db as unknown as { query: unknown }).query = realQuery; };
}

/**
 * THE FRESHNESS THE CUSTOMER PAYLOAD IS CLAIMING, and nothing else about the filing.
 *
 * This is the comparison round 4's failure injection made on the live database: with the drift
 * pass broken, Ivy's stalled building permit encoded IDENTICALLY to a filing we had just confirmed
 * was current — same two fields, same two values — so no reader, human or machine, could tell a
 * check that passed from a check that never ran.
 */
const freshnessSignature = (row: { reading?: string; needsRecheck: boolean }): string =>
  JSON.stringify({ reading: row.reading ?? null, needsRecheck: row.needsRecheck });

/** The payloads a broken drift pass produces, captured once and asserted on repeatedly. */
interface BrokenRender {
  status: NonNullable<ReturnType<typeof publicProjectStatusPayload>>;
  portal: NonNullable<ReturnType<typeof clientPortalPayload>>;
  errors: string[];
}
let broken: BrokenRender | null = null;
const portalToken = ensureClientPortalToken(db, client.id);

await check("A DRIFT FAILURE READS AS 'WE COULD NOT CHECK' — never as a confirmed-fresh reading", () => {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  const restore = breakDriftPass();
  try {
    // All three entry points, because all three call it and a guard on one is a guard on none.
    const status = publicProjectStatusPayload(db, driftToken);
    assert.ok(status, "the tokenized status page a customer was emailed returned nothing at all");
    assert.ok(status!.tracks.length >= 2, `the page lost its filings: ${JSON.stringify(status!.tracks)}`);
    const portal = clientPortalPayload(db, portalToken);
    assert.ok(portal, "the per-client tracker died with the drift pass");
    const history = projectStatusHistory(db, driftProject.id);
    assert.ok(Array.isArray(history) && history.length >= 2, "the timeline died with the drift pass");
    broken = { status: status!, portal: portal!, errors };

    // THE THIRD ANSWER REACHES THE CUSTOMER PAYLOAD. Not "stale" — we have no evidence of drift —
    // and not "current", which is the lie: our own pass never ran.
    for (const t of status!.tracks) {
      assert.equal(t.reading, "unverified",
        `${t.applicationNumber} came back as "${t.reading}" from a pass that never ran: ${JSON.stringify(t)}`);
      assert.equal(t.needsRecheck, true,
        `${t.applicationNumber} is published with no caveat at all after our check failed — this is `
        + "Ivy's stalled permit reading \"In review by the jurisdiction\" as a plain fact");
    }
    // The timeline is newest-first, so the FIRST entry for a filing is the one still being claimed
    // as today's state. Only that one carries the verdict; everything behind it is dated history
    // and stays unmarked whatever the pass did.
    const seenFilings = new Set<string>();
    for (const h of history) {
      const isLive = !seenFilings.has(h.applicationNumber);
      seenFilings.add(h.applicationNumber);
      assert.equal(h.reading, isLive ? "unverified" : "current",
        isLive
          ? `the timeline's live entry claims freshness from a pass that never ran: ${JSON.stringify(h)}`
          : `a superseded entry was re-opened by a failed pass: ${JSON.stringify(h)}`);
    }
    assert.equal(seenFilings.size, 2, `the fixture's timeline lost a filing: ${JSON.stringify(history)}`);
    const portalTracks = portal!.projects.find((p) => p.id === driftProject.id)!.tracks;
    assert.ok(portalTracks.length >= 2, JSON.stringify(portalTracks));
    for (const t of portalTracks) {
      assert.equal(t.reading, "unverified", `the per-client tracker publishes ${t.applicationNumber} as checked`);
      assert.equal(t.needsRecheck, true, JSON.stringify(t));
    }

    // ...and the failure is LOUD. A silent empty result is indistinguishable from "all current",
    // which is precisely how a stalled permit goes on reading "In review" to the person waiting.
    const line = errors.find((e) => /permit-monitor/.test(e));
    assert.ok(line, `the drift pass failed and nothing was logged: ${JSON.stringify(errors)}`);
    assert.match(line!, /stale/i, line!);
    assert.match(line!, /unverified|not confirmed/i,
      `the log says the pass failed but not what that means for the readings: ${line}`);
    assert.match(line!, new RegExp(INJECTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the underlying cause was swallowed, so nobody can fix it: ${line}`);

    // THE THIRD ANSWER, kept separate from the second: "we could not tell" is not "nothing is
    // stale". The operator surface reads this and says so in words.
    const scan = scanStaleStatusClassifications(db, [driftProject.id]);
    assert.equal(scan.checked, false, "a failed pass reported itself as a completed one");
    assert.deepEqual(scan.readings, []);
  } finally {
    restore();
    console.error = realError;
  }
});

await check("THE BYTE-IDENTITY ROUND 4 PROVED: a failed check must not encode as a passed one", () => {
  // The working pass, for the same two filings: one CONFIRMED CURRENT, one CONFIRMED STALE.
  const fresh = publicProjectStatusPayload(db, driftToken)!;
  const freshElec = fresh.tracks.find((t) => t.applicationNumber === "187-26-000401-ELEC")!;
  const freshStr = fresh.tracks.find((t) => t.applicationNumber === "187-26-000401-STR")!;
  assert.equal(freshStr.reading, "stale", "the fixture is not stale under a working pass — nothing below is being tested");
  assert.equal(freshElec.reading, "current", JSON.stringify(freshElec));

  const brokenElec = broken!.status.tracks.find((t) => t.applicationNumber === "187-26-000401-ELEC")!;
  const brokenStr = broken!.status.tracks.find((t) => t.applicationNumber === "187-26-000401-STR")!;

  // THIS IS THE BUG, STATED AS AN ASSERTION. On the live database, with the drift query made to
  // throw, the whole track object for a filing we could not check came back byte-for-byte equal to
  // the run where we had checked it and confirmed it current.
  assert.notEqual(JSON.stringify(brokenElec), JSON.stringify(freshElec),
    "a filing we CONFIRMED is current and a filing we COULD NOT CHECK are byte-identical in the "
    + `customer payload — there is no way to tell them apart: ${JSON.stringify(brokenElec)}`);
  assert.notEqual(freshnessSignature(brokenStr), freshnessSignature(freshElec),
    "the stalled building permit, after our check failed, now carries exactly the freshness a "
    + `confirmed-current filing carries: ${freshnessSignature(brokenStr)} — this is Ivy's and Ann's `
    + "permit telling the homeowner the jurisdiction is reviewing it");
  // Belt and braces on the other direction: the three states are three distinct encodings.
  const encodings = new Set([
    freshnessSignature(freshElec), freshnessSignature(freshStr), freshnessSignature(brokenStr),
  ]);
  assert.equal(encodings.size, 3,
    `current / stale / could-not-check collapsed into ${encodings.size} encoding(s): ${[...encodings].join(" ")}`);

  // The same three-way distinction on the per-client tracker, which is a different builder.
  const portalFresh = clientPortalPayload(db, portalToken)!
    .projects.find((p) => p.id === driftProject.id)!.tracks
    .find((t) => t.applicationNumber === "187-26-000401-ELEC")!;
  const portalBroken = broken!.portal.projects.find((p) => p.id === driftProject.id)!.tracks
    .find((t) => t.applicationNumber === "187-26-000401-ELEC")!;
  assert.notEqual(JSON.stringify(portalBroken), JSON.stringify(portalFresh),
    `the tracker cannot tell a confirmed reading from an unchecked one either: ${JSON.stringify(portalBroken)}`);
});

await check("...and the guard did not cost the feature: with the pass working, the mark is back", () => {
  const status = publicProjectStatusPayload(db, driftToken)!;
  const str = status.tracks.find((t) => t.applicationNumber === "187-26-000401-STR")!;
  const elec = status.tracks.find((t) => t.applicationNumber === "187-26-000401-ELEC")!;
  assert.equal(str.needsRecheck, true,
    "the try/catch swallowed the real answer too — the stale reading is published unqualified");
  assert.equal(str.reading, "stale", `a real drift finding was reported as "${str.reading}"`);
  assert.equal(elec.needsRecheck, false, "the current filing was marked as well, which makes the mark noise");
  assert.equal(elec.reading, "current",
    `a filing we checked and agree with reports "${elec.reading}" — if everything is unverified, `
    + "the word means nothing");
  const scan = scanStaleStatusClassifications(db, [driftProject.id]);
  assert.equal(scan.checked, true);
  assert.equal(scan.readings.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// AND NOW THE PAGES THEMSELVES — the surface the homeowner actually reads. renderCustomerPage
// runs the shipped inline script of each file against the payloads captured above.
// ─────────────────────────────────────────────────────────────────────────────────────────

await check("status.html RENDERS THE THIRD ANSWER: 'we could not confirm', on every reading", async () => {
  const html = await renderCustomerPage("status.html", broken!.status);
  assert.doesNotMatch(html, /isn't valid anymore/, `the harness fed the page nothing it could render: ${html.slice(0, 200)}`);
  assert.match(html, /187-26-000401-STR/, `the page did not render the filings: ${html.slice(0, 300)}`);

  // THE RENDERED ROW FIRST, because that is the thing a homeowner reads. The caveat sits inside
  // its own filing's row, under the claim it qualifies.
  assert.match(rowAfter(html, "187-26-000401-STR"), /could not confirm/,
    "the stalled building permit is published as a plain fact — this is the live bug, on the page "
    + "we email a homeowner");
  assert.match(rowAfter(html, "187-26-000401-ELEC"), /could not confirm/,
    "the issued electrical permit claims to be confirmed by a check that never ran");
  // ...and it does NOT claim a re-check is under way for drift we never detected.
  assert.equal(occurrences(html, "needs confirming"), 0,
    "a pass that never ran reported specific readings as stale");
  // The stalled permit still shows what we recorded — we publish what we know, with the caveat.
  assert.match(html, /In review by the jurisdiction/,
    "the page stopped showing the recorded reading altogether, which tells the customer less, not more");

  // EVERY reading the page publishes carries the caveat — counted against the payload itself, so
  // a track or timeline entry that quietly loses its note fails here. The `claims >= 3` guard is
  // the fixture's own tripwire: if the payload ever stops producing unverified rows, the count
  // below would be 0 === 0 and this whole check would pass while proving nothing.
  const claims = [...broken!.status.tracks, ...broken!.status.history]
    .filter((row) => (row.statusLabel || row.outcome) && row.reading === "unverified").length;
  assert.ok(claims >= 3, `the fixture stopped producing unverified rows: ${claims}`);
  assert.equal(occurrences(html, "could not confirm"), claims,
    `${claims} readings we could not check produced ${occurrences(html, "could not confirm")} caveats on the `
    + `page a homeowner opens from our email: ${html.slice(0, 600)}`);
});

await check("status.html KEEPS THE TWO APART: a stale reading and a working check read differently", async () => {
  const html = await renderCustomerPage("status.html", publicProjectStatusPayload(db, driftToken)!);
  assert.doesNotMatch(html, /isn't valid anymore/, html.slice(0, 200));
  assert.equal(occurrences(html, "could not confirm"), 0,
    `the pass RAN and the page still says we could not check: ${html.slice(0, 400)}`);
  assert.match(rowAfter(html, "187-26-000401-STR"), /needs confirming/,
    "the stale reading lost its caveat when the third value was added");
  // The confirmed-current filing carries NO note at all. If every row is caveated, the caveat is
  // wallpaper and the stalled permit stops standing out.
  assert.doesNotMatch(rowAfter(html, "187-26-000401-ELEC"), /needs confirming|could not confirm/,
    "a filing we checked and agree with is shown with a caveat");
});

await check("portal.html RENDERS THE THIRD ANSWER TOO — the tracker is not the forgotten page", async () => {
  const html = await renderCustomerPage("portal.html", broken!.portal);
  assert.doesNotMatch(html, /isn't valid/, `the harness fed the tracker nothing: ${html.slice(0, 200)}`);
  assert.match(html, /187-26-000401-STR/, `the tracker did not render the filings: ${html.slice(0, 300)}`);
  assert.match(rowAfter(html, "187-26-000401-STR"), /could not confirm/,
    "the per-client tracker publishes the stalled permit with no caveat after our check failed");
  assert.match(rowAfter(html, "187-26-000401-ELEC"), /could not confirm/,
    "a reading nobody checked is shown on the tracker as if it were confirmed");
  assert.equal(occurrences(html, "needs confirming"), 0,
    "the tracker reported specific readings as stale from a pass that never ran");

  // And with the pass working, the tracker draws the same distinction the status page does.
  const working = await renderCustomerPage("portal.html", clientPortalPayload(db, portalToken)!);
  assert.equal(occurrences(working, "could not confirm"), 0,
    `the pass ran and the tracker still says we could not check: ${working.slice(0, 400)}`);
  assert.match(rowAfter(working, "187-26-000401-STR"), /needs confirming/,
    "the tracker lost the stale caveat");
  assert.doesNotMatch(rowAfter(working, "187-26-000401-ELEC"), /needs confirming|could not confirm/,
    "a confirmed-current filing is caveated on the tracker");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// RISK 1 — THE OPERATOR'S PAGE, RUN.
//
// frontend/dashboard.js is an ES module (<script type="module">), so it is IMPORTED here — the
// real shipped file, byte for byte, with one appended `export {}` line so the test can reach the
// bindings it already has. Nothing is re-implemented and nothing is grepped: selectProject() is
// the function the hash router calls when an operator opens a project, and what it does with the
// network is observed through a fetch stub.
//
// The DOM is stubbed to the shape dashboard.js actually uses. If this harness starts failing to
// LOAD, that is a real signal — the page acquired a browser dependency that this suite cannot see.
// ─────────────────────────────────────────────────────────────────────────────────────────
interface DashCall { url: string; method: string; body: Record<string, unknown> | null }
class FakeElement {}
let dashCalls: DashCall[] = [];
let dashStaleBody: unknown = { projectId: "P1", checked: true, staleReadings: [] };
const dashElements = new Map<string, Record<string, unknown>>();
const DASH_DETAIL = {
  project: {
    id: "P1", owner: "Drift Guard", status: "approved", ahj: "City of Coos Bay",
    utility: "Pacific Power", street: "990 Empire Blvd", city: "Coos Bay", state: "OR", zip: "97420",
  },
  // Electrical FIRST, structural second — the order that made permitCheckTargets[0] wrong.
  permitCheckTargets: [
    { id: "T-ELEC", targetType: "permit", permitType: "electrical", checkFrequencyDays: 7 },
    { id: "T-STR", targetType: "permit", permitType: "building", checkFrequencyDays: 7 },
  ],
  permitStatusChecks: [], emailProjectMatches: [], qcResults: [], documents: [], corrections: [],
  submissions: [], projectNotes: [], humanReviewItems: [], auditLogs: [],
};

function dashElement(id: string): Record<string, unknown> {
  const existing = dashElements.get(id);
  if (existing) return existing;
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const el = Object.assign(new FakeElement(), {
    id, innerHTML: "", textContent: "", value: "", hidden: false, disabled: false, checked: false,
    dataset: {} as Record<string, string>, style: {} as Record<string, string>, listeners,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type: string, fn: (ev: unknown) => void) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    querySelector: (sel: string) => dashElement(`${id}>>${sel}`),
    querySelectorAll: () => [],
    closest: () => null,
    appendChild() {}, removeChild() {}, remove() {},
    setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
    insertAdjacentHTML() {},
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, select() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  }) as unknown as Record<string, unknown>;
  Object.defineProperty(el, "parentElement", { get: () => dashElement(`${id}^parent`) });
  Object.defineProperty(el, "parentNode", { get: () => dashElement(`${id}^parent`) });
  dashElements.set(id, el);
  return el;
}

const dashGlobals = globalThis as unknown as Record<string, unknown>;
const savedGlobals: Record<string, unknown> = {};
for (const key of ["document", "window", "location", "fetch", "Element", "EventSource", "alert", "confirm"]) {
  savedGlobals[key] = dashGlobals[key];
}
const realConsoleError = console.error;
function installDashDom(): void {
  console.error = (...args: unknown[]) => { dashRenderNoise.push(args.map(String).join(" ")); };
  dashGlobals.document = {
    getElementById: (id: string) => dashElement(id),
    querySelector: (sel: string) => dashElement(`doc>>${sel}`),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: (tag: string) => dashElement(`new:${tag}:${Math.random()}`),
    body: dashElement("body"),
    documentElement: dashElement("html"),
  };
  dashGlobals.window = {
    location: { hash: "", href: "http://localhost/", origin: "http://localhost" },
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    scrollTo() {}, open: () => null,
  };
  dashGlobals.location = (dashGlobals.window as { location: unknown }).location;
  dashGlobals.Element = FakeElement;
  dashGlobals.EventSource = class { addEventListener() {} close() {} };
  dashGlobals.alert = () => {};
  dashGlobals.confirm = () => true;
  dashGlobals.fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = String(url);
    dashCalls.push({
      url: u, method: String(init.method || "GET"),
      body: init.body ? JSON.parse(init.body) as Record<string, unknown> : null,
    });
    const body = u.includes("/permit-checks/stale") ? dashStaleBody
      : (u.includes("/permit-checks") || /\/api\/projects\/[^/?]+$/.test(u)) ? DASH_DETAIL
        : {};
    return { ok: true, status: 200, json: async () => body };
  };
}
function restoreDashDom(): void {
  console.error = realConsoleError;
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete dashGlobals[key];
    else dashGlobals[key] = value;
  }
}

// dashboard.js's own safeRender() reports every panel that fails to render, and on stub data most
// of the OTHER panels do — pages of stack traces that bury this file's results. They are captured
// rather than printed, and quoted back in the failure messages below, where they are evidence.
let dashRenderNoise: string[] = [];

const STALE_REPORT = {
  projectId: "P1",
  checked: true,
  staleReadings: [{
    projectId: "P1", targetId: "T-STR", checkId: "C1", checkedAt: "2026-09-03T10:00:00.000Z",
    source: "portal", targetType: "permit", permitType: "building",
    applicationNumber: "187-26-000401-STR", hasPortalUrl: false,
    stale: true, storedOutcome: "waiting", storedStatusLabel: "In review",
    currentOutcome: "needs_human_review", currentStatusLabel: "Action needed before review",
    label: "Structural permit",
    recheck: { method: "POST", path: "/api/projects/P1/permit-checks", body: { targetId: "T-STR", source: "manual" } },
  }],
};

interface DashModule {
  state: Record<string, unknown>;
  selectProject: (id: string) => Promise<void>;
}
let dash: DashModule | null = null;
let dashLoadError = "";

installDashDom();
try {
  // The shipped file plus one export line. Written beside the test's own scratch DB so nothing
  // is added to frontend/, and imported as .mjs so Node treats it as the module it really is.
  const dashSource = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8");
  const dashFile = path.join(tmpDir, "dashboard.harness.mjs");
  fs.writeFileSync(dashFile, `${dashSource}\nexport { state, selectProject };\n`, "utf8");
  dash = await import(pathToFileURL(dashFile).href) as unknown as DashModule;
} catch (err) {
  dashLoadError = err instanceof Error ? (err.stack || err.message) : String(err);
} finally {
  restoreDashDom();
}

/** Open a project the way the router does, with the stale route answering `body`. */
async function openProjectInDashboard(body: unknown): Promise<string> {
  dashStaleBody = body;
  dashCalls = [];
  dashRenderNoise = [];
  installDashDom();
  try {
    await dash!.selectProject("P1").catch(() => { /* unrelated panels may fail on stub data */ });
    return String((dashElement("permitChecks") as { innerHTML: string }).innerHTML || "");
  } finally {
    restoreDashDom();
  }
}

await check("THE OPERATOR'S PAGE ASKS FOR IT: opening a project calls the stale route", async () => {
  assert.equal(dashLoadError, "", `frontend/dashboard.js would not load in the harness:\n${dashLoadError}`);
  const html = await openProjectInDashboard(STALE_REPORT);
  const asked = dashCalls.filter((c) => c.url.includes("/permit-checks/stale"));
  assert.equal(asked.length, 1,
    "opening a project does not fetch /api/projects/:id/permit-checks/stale — the route has no "
    + `production caller and the operator never learns a reading is stale. Calls: ${JSON.stringify(dashCalls.map((c) => c.url))}`);
  assert.equal(asked[0].url, "/api/projects/P1/permit-checks/stale");
  assert.equal(asked[0].method, "GET", "the drift REPORT was fetched with a write method");
  assert.equal((dash!.state as { staleReadings?: unknown }).staleReadings !== null, true, "the answer was thrown away");

  // ...and it REACHES THE PAGE, through renderDetail → renderPermitMonitor, not by us calling the
  // renderer ourselves.
  assert.match(html, /today's rules would classify differently/i,
    `the report was fetched and never rendered — #permitChecks holds: ${html.slice(0, 400)}\n`
    + `dashboard render errors: ${dashRenderNoise.join(" | ").slice(0, 600)}`);
  assert.match(html, /In review/, "the panel does not say what the client is currently being told");
  assert.match(html, /Action needed before review/, "the panel does not say what the rule says now");
  assert.match(html, /187-26-000401-STR/, "the panel does not name which filing it is about");
  assert.match(html, /data-recheck-target="T-STR"/,
    "there is no control to act on it — a report an operator cannot act on is the orphan again");
  // No portal URL on this filing: a blind fetch would replace a stale reading with a blanker one.
  assert.match(html, /Paste a fresh status/, "a fetch-only control was offered for a filing with no portal URL");
});

await check("THE THIRD ANSWER RENDERS AS UNKNOWN, NOT AS AN ALL-CLEAR", async () => {
  const failed = await openProjectInDashboard({ projectId: "P1", checked: false, staleReadings: [] });
  assert.match(failed, /could not be checked/i,
    `a failed drift pass rendered as silence, which on this page reads as "nothing is stale": ${failed.slice(0, 300)}`);
  assert.match(failed, /unverified/i, "the operator is not told what an unmarked badge now means");
  assert.doesNotMatch(failed, /rules would classify differently/i,
    "a failed pass was reported as a completed one with no findings");

  // And the genuinely clean answer renders NOTHING — otherwise the warning above is wallpaper.
  const clean = await openProjectInDashboard({ projectId: "P1", checked: true, staleReadings: [] });
  assert.doesNotMatch(clean, /could not be checked|rules would classify differently/i,
    `a project with no stale readings still shows the panel: ${clean.slice(0, 300)}`);
});

await check("THE RE-CHECK CONTROL FILES AGAINST ITS OWN FILING, then re-reads the report", async () => {
  await openProjectInDashboard(STALE_REPORT);
  const container = dashElement("permitChecks") as { listeners: Record<string, Array<(ev: unknown) => void>> };
  const clickHandlers = container.listeners.click || [];
  assert.equal(clickHandlers.length, 1,
    "no click handler is bound to #permitChecks, so the button in the panel does nothing");

  const fireClick = (targetId: string, source: string): void => {
    const button = Object.assign(new FakeElement(), { dataset: { recheckTarget: targetId, recheckSource: source } });
    const evTarget = Object.assign(new FakeElement(), {
      closest: (sel: string) => (sel === "button[data-recheck-target]" ? button : null),
    });
    for (const fn of clickHandlers) fn({ target: evTarget });
  };

  // A filing with NO portal URL: fetching would only record "no status text", so the control must
  // send the operator to the paste box instead of firing a check that makes the reading blanker.
  installDashDom();
  dashCalls = [];
  fireClick("T-STR", "manual");
  await new Promise((r) => setTimeout(r, 40));
  restoreDashDom();
  assert.deepEqual(dashCalls, [],
    `a filing with no portal URL was re-checked blind: ${JSON.stringify(dashCalls.map((c) => c.url))}`);
  assert.equal((dash!.state as { recheckTargetId?: string }).recheckTargetId, "T-STR",
    "the paste box was opened without remembering which filing the paste belongs to, so the next "
    + "paste files against permitCheckTargets[0] — the wrong permit");

  // A filing WITH a portal URL: fetch it, and against ITS OWN target, not the project's first.
  installDashDom();
  dashCalls = [];
  fireClick("T-STR", "public_url");
  await new Promise((r) => setTimeout(r, 150));
  restoreDashDom();
  const post = dashCalls.find((c) => c.method === "POST");
  assert.ok(post, `the re-check button fired no request: ${JSON.stringify(dashCalls.map((c) => c.url))}`);
  assert.equal(post!.url, "/api/projects/P1/permit-checks", "the cure is a NEW check on the existing POST route");
  assert.equal(post!.body?.targetId, "T-STR",
    `the re-check was filed against ${JSON.stringify(post!.body?.targetId)} — the project's FIRST target, not the `
    + "stale one. On Ann's project that records the electrical permit and leaves the structural stale.");
  assert.equal(post!.body?.source, "public_url");
  const postIndex = dashCalls.indexOf(post!);
  const refreshed = dashCalls.findIndex((c, i) => i > postIndex && c.url.includes("/permit-checks/stale"));
  assert.ok(refreshed > postIndex,
    "the report is not re-read after a re-check, so the panel keeps showing a reading that has "
    + `just been cured: ${JSON.stringify(dashCalls.map((c) => c.url))}`);
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
  const them = publicCheckLabel("waiting", "In review", "permit");
  const us = publicCheckLabel("needs_human_review", "Action needed before review", "permit");
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
  for (const kind of ["permit", "nem"] as const) {
    assert.equal(publicCheckLabel("waiting", "Some legacy label we never emitted", kind), "Some legacy label we never emitted");
    assert.equal(publicCheckLabel("waiting", "", kind), "", "a blank label must stay blank so the page can fall back");
    assert.equal(publicCheckLabel("issued", "Permit issued", kind), "Permit issued");
  }
});

await check("A NEM FILING IS NOT REVIEWED BY A JURISDICTION — every branch, both kinds", () => {
  // "NEM/interconnection isnt an ahj" — the operator, and they are right. An interconnection
  // application is Pacific Power's queue; no city has ever seen it. Driving the real classifier
  // rather than restating its label list means a NEW branch is covered the day it is added, which
  // is the whole point: the map is keyed on the stored label and a new key with a
  // jurisdiction-flavoured wording would sail through a list written by hand.
  const samples = [IN_REVIEW, INTAKE_NEEDED, ISSUED,
    "Record Status: Approved. Plan review complete.",
    "Record Status: Ready for Issue. Fees due.",
    CORRECTION, NEM_APPROVED, ""];
  for (const raw of samples) {
    const c = classifyPermitStatusText(raw);
    const nem = publicCheckLabel(c.outcome, c.statusLabel, "nem");
    const permit = publicCheckLabel(c.outcome, c.statusLabel, "permit");
    assert.doesNotMatch(nem, /jurisdiction|\bAHJ\b/i,
      `an interconnection application reads "${nem}" — it is reviewed by the UTILITY, and no `
      + "jurisdiction is involved in it at all");
    assert.doesNotMatch(permit, /\butility\b/i,
      `a building permit reads "${permit}" — the utility does not review permits`);
    assert.ok(nem && permit, `${c.outcome}::${c.statusLabel} produced no wording at all`);
  }
  // The two states a stalled filing actually sits in, named explicitly: same stored key, two
  // reviewers.
  assert.equal(publicCheckLabel("waiting", "In review", "nem"), "In review by the utility");
  assert.equal(publicCheckLabel("waiting", "In review", "permit"), "In review by the jurisdiction");
  assert.match(publicCheckLabel("needs_human_review", "Action needed before review", "nem"), /\bus\b.*utility/i);
});

await check("THE TRACK KIND COMES FROM THE ROW, and a blank target_type still finds the NEM", () => {
  // trackLabel and publicCheckLabel must agree on what a filing IS. A legacy target with a blank
  // target_type and permit_type 'nem' is titled "Utility interconnection" by trackLabel; if
  // the wording asked a different question it would title the row for the utility and then say the
  // jurisdiction was reviewing it.
  assert.equal(trackKind("nem", ""), "nem");
  assert.equal(trackKind("", "nem"), "nem");
  assert.equal(trackKind("permit", "building"), "permit");
  assert.equal(trackKind("", ""), "permit", "an unknown track must not be guessed into the utility's queue");
  for (const [type, permitType] of [["nem", "nem"], ["", "nem"], ["NEM", ""]] as Array<[string, string]>) {
    assert.equal(trackLabel(type, permitType), "Utility interconnection");
    assert.doesNotMatch(publicCheckLabel("waiting", "In review", trackKind(type, permitType)), /jurisdiction/i,
      `trackLabel calls (${type}/${permitType}) an interconnection while the badge names a jurisdiction`);
  }
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
    for (const kind of ["permit", "nem"] as const) {
      const words = publicCheckLabel(c.outcome, c.statusLabel, kind);
      for (const [pattern, why] of JARGON) {
        assert.doesNotMatch(words, pattern,
          `"${c.statusLabel}" (${c.outcome}) reaches the client as "${words}" on a ${kind} track — ${why}`);
      }
    }
  }
  // And the fallback branch, which no sample text reaches.
  assert.doesNotMatch(publicCheckLabel("needs_human_review", "Needs human review", "permit"), /human review/i);
  assert.doesNotMatch(publicCheckLabel("needs_human_review", "Needs human review", "nem"), /human review/i);
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

// ═════════════════════════════════════════════════════════════════════════════════════════
// THE ROUTE ITSELF, OVER HTTP.
//
// The dashboard checks above prove the operator's page CALLS /api/projects/:id/permit-checks/stale.
// This proves the thing at the other end of that URL answers — through the real Express stack, the
// real scope guard and the real 404 gate, in a real server process. Same shape as reviewApi.test.ts
// (node + the tsx CLI directly: "npx" is not spawnable on Windows, and a shell wrapper would let
// kill() stop the shell while orphaning the server).
//
// READ-ONLY, and asserted as such: permit_status_checks is an audit trail with a foreign key
// pointing into it, and the row count is compared across the whole HTTP phase. A GET that edits
// history would be a worse bug than the one this route reports.
// ═════════════════════════════════════════════════════════════════════════════════════════
const PORT = 4930 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const serverEnv = {
  ...process.env,
  AUTOPILOT_DB_PATH: process.env.AUTOPILOT_DB_PATH,
  BACKUP_DIR: process.env.BACKUP_DIR,
  AUTOPILOT_AUTO_START: "0",
  PORT: String(PORT),
  SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "warn",
  ANTHROPIC_API_KEY: "",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  NO_PROXY: "*",
  no_proxy: "*",
};
for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
  delete (serverEnv as Record<string, string | undefined>)[key];
}
const httpServer = spawn(
  process.execPath, ["node_modules/tsx/dist/cli.mjs", "backend/src/server.ts"],
  { env: serverEnv as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: false },
);
let httpLog = "";
httpServer.stdout?.on("data", (d) => { httpLog += String(d); });
httpServer.stderr?.on("data", (d) => { httpLog += String(d); });

try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not listening yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }

  await check("THE ROUTE, OVER HTTP: it reports the stale filing and names the call that cures it", async () => {
    assert.ok(up, `the server never came up on ${PORT}. log tail:\n${httpLog.slice(-1500)}`);
    const rowsBefore = rowsForProject(driftProject.id);

    const res = await fetch(`${BASE}/api/projects/${driftProject.id}/permit-checks/stale`);
    const text = await res.text();
    assert.equal(res.status, 200, `the operator route the dashboard calls is not reachable: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as {
      projectId: string; checked: boolean;
      staleReadings: Array<{ targetId: string; applicationNumber: string; label: string;
        storedStatusLabel: string; currentStatusLabel: string; hasPortalUrl: boolean;
        recheck: { method: string; path: string; body: { targetId: string; source: string } } }>;
    };
    assert.equal(body.projectId, driftProject.id);
    assert.equal(body.checked, true, "the route reported the pass as failed when it ran fine");
    assert.equal(body.staleReadings.length, 1,
      `the stalled structural filing is not reported: ${text.slice(0, 400)}`);
    const only = body.staleReadings[0];
    assert.equal(only.targetId, driftStr.id, "the report names the wrong filing");
    assert.equal(only.applicationNumber, "187-26-000401-STR");
    assert.equal(only.storedStatusLabel, "In review");
    assert.equal(only.currentStatusLabel, "Action needed before review");
    assert.equal(only.hasPortalUrl, false);
    assert.match(only.label, /permit/i, `the row does not name its filing: ${only.label}`);
    // The cure, as a call the operator can actually make — and it points at the EXISTING POST.
    assert.equal(only.recheck.method, "POST");
    assert.equal(only.recheck.path, `/api/projects/${driftProject.id}/permit-checks`);
    assert.equal(only.recheck.body.targetId, driftStr.id);
    assert.equal(only.recheck.body.source, "manual", "a fetch was offered for a filing with no portal URL");
    // NO SCRAPED PROSE over the wire: raw_status_text carries homeowner names and examiners' lines.
    assert.doesNotMatch(text, /rawStatusText|raw_status_text|Submitted 09\/02/i, text.slice(0, 400));

    // 404, not 403, and not a leak: an unknown/out-of-scope project must be indistinguishable.
    const missing = await fetch(`${BASE}/api/projects/00000000-0000-0000-0000-000000000000/permit-checks/stale`);
    assert.equal(missing.status, 404, `an unknown project answered ${missing.status}: ${(await missing.text()).slice(0, 200)}`);

    assert.equal(rowsForProject(driftProject.id), rowsBefore,
      "the stale REPORT wrote to permit_status_checks — email_project_matches.status_check_id "
      + "points into that table and a GET must never edit what we believed at the time");
  });
} finally {
  httpServer.kill();
  await new Promise((r) => setTimeout(r, 300));
}

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* the killed server may still hold the file */ }
console.log(failures === 0
  ? "\nstatusHistoryTransitions: all checks passed."
  : `\nstatusHistoryTransitions: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
