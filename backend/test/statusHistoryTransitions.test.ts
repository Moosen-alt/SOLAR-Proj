// A TIMELINE OF CHECKS IS NOT A TIMELINE.
//
// The operator opened a live client status page and found twelve "Recent updates" entries, six
// pairs of them seconds apart, every one of them saying the same thing and none of them saying
// which of the project's two permits it was about:
//
//   In review    Sep 2      In review    Sep 2
//   In review    Sep 2      In review    Sep 2
//   ... eight more of the same ...
//
// Two separate defects produced that page.
//
//   1. permit_status_checks is written on every CHECK, not every CHANGE. A permit that sits in
//      "In review" for three weeks gets a row per sweep, and the pairs are one sweep's structural
//      target followed by its electrical target. The EMAIL side already had this right — the
//      client is notified only when the outcome moves — so the page showed the ladder the inbox
//      was deliberately spared.
//   2. No entry named its subject. The projection emitted date + statusLabel + outcome. The
//      discipline and the application number were both one join away and neither was carried, so
//      a project with a structural AND an electrical permit produced a timeline where nothing
//      distinguished the two filings.
//
// And one wording defect underneath both: "In review" never says WHO is reviewing, and "Action
// needed before review" — the label added when Coos Bay's real "Intake Requirements Needed" was
// found classified as review-in-progress — names an action without its owner. On a client's page
// that reads as THEIR action when it is ours.
//
//   MUST COLLAPSE  — consecutive identical states, PER TARGET. Two targets interleave; collapsing
//                    globally would call an STR row "a change" because an ELEC row sat between it
//                    and the identical STR row before it.
//   MUST KEEP      — the FIRST row of a run. A timeline entry dated today for a status that last
//                    moved in August is a wrong date, not a fresh update.
//   MUST RECORD    — a genuine transition, including one that changes only the LABEL and not the
//                    outcome ("In review" → "Action needed before review" is the single most
//                    important thing a client can be told, and it is not a new outcome).
//   MUST NOT LOSE  — audit fidelity. One audit_logs `permit_status.checked` row per CHECK stays,
//                    and permit_check_targets.last_checked_at still advances every time we look.
//   MUST EXEMPT    — email and manual sources. An inbound AHJ email is an event, not a poll, and
//                    email_project_matches.status_check_id is a foreign key onto the row written
//                    for it. An operator pasting status text expects a record of having done so.
//   MUST NAME      — every entry: which filing, and the jurisdiction's own reference for it.
//   MUST SAY       — who the next move belongs to, in the words themselves.
//
//   npx tsx backend/test/statusHistoryTransitions.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-history-transitions-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, createPermitCheckTarget, recordPermitStatusCheck } = await import("../src/repository");
const { projectStatusHistory, publicCheckLabel, trackLabel } = await import("../src/clientPortal");
const { shouldRecordStatusCheck, classifyPermitStatusText } = await import("../src/permitMonitor");
const { clientUpdateFor } = await import("../src/clientUpdates");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

// The two real status strings from the stalled Coos Bay permit and its sibling.
const IN_REVIEW = "Record Status: In Review. Application received and assigned to a plans examiner.";
const INTAKE_NEEDED = "Record Status: Intake Requirements Needed. Submitted 09/02/2026.";
const ISSUED = "Record Status: Issued. Permit issued 09/09/2026. Download permit card.";

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE POLICY, on its own. The persistence layer calls this; it must not re-derive it.
// ─────────────────────────────────────────────────────────────────────────────────────────

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
  // agency has stopped and is waiting on US — would be swallowed as "nothing happened".
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

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE WORDING: who owes the next move.
// ─────────────────────────────────────────────────────────────────────────────────────────

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
    "Corrections required. Revise and resubmit.",
    "Permission to operate granted.",
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
  const project = { id: "x", ahj: "City of Coos Bay", utility: "Pacific Power" };
  const ele = clientUpdateFor(db, project as never, "correction_flagged", { targetType: "permit", permitType: "electrical" })!;
  assert.match(ele.headline, /electrical permit application/,
    `with two permits outstanding the client cannot tell which came back: ${ele.headline}`);
  const unknown = clientUpdateFor(db, project as never, "correction_flagged", { targetType: "permit", permitType: "" })!;
  assert.match(unknown.headline, /sent the application back/, unknown.headline);
  assert.doesNotMatch(unknown.headline, /electrical|building/i,
    `a trade was asserted with no discipline on file: ${unknown.headline}`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE OPERATOR'S PAGE, driven through the REAL write path.
// ─────────────────────────────────────────────────────────────────────────────────────────

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
const rowsFor = (targetId: string): number => Number(
  db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_status_checks WHERE target_id = ?", [targetId])?.n ?? 0,
);
const auditChecks = (): number => Number(
  db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action = 'permit_status.checked'", [project.id],
  )?.n ?? 0,
);
const lastCheckedAt = (targetId: string): string => String(
  db.get<{ last_checked_at?: string }>("SELECT last_checked_at FROM permit_check_targets WHERE id = ?", [targetId])?.last_checked_at || "",
);

await check("THE OPERATOR'S CASE: two targets, three sweeps, ONE entry each — not six", async () => {
  // Sweep 1: both targets read for the first time.
  await poll(strTarget.id, IN_REVIEW);
  await poll(eleTarget.id, IN_REVIEW);
  // Sweeps 2 and 3: nothing has moved. This is `check-permits-now --all` being run twice.
  await poll(strTarget.id, IN_REVIEW);
  await poll(eleTarget.id, IN_REVIEW);
  await poll(strTarget.id, IN_REVIEW);
  await poll(eleTarget.id, IN_REVIEW);

  const history = projectStatusHistory(db, project.id);
  assert.equal(history.length, 2,
    `the client is shown the ladder again: ${JSON.stringify(history.map((h) => [h.label, h.statusLabel, h.at]))}`);
  // One entry per FILING, and each entry dated when that filing actually reached this state.
  const labels = history.map((h) => h.label).sort();
  assert.deepEqual(labels, ["Building permit", "Electrical permit"],
    `the two filings are indistinguishable on the timeline: ${JSON.stringify(history)}`);
});

await check("EVERY ENTRY NAMES ITS FILING — discipline AND the jurisdiction's reference", () => {
  const history = projectStatusHistory(db, project.id);
  for (const h of history) {
    assert.ok(h.label, `a timeline entry with no subject: ${JSON.stringify(h)}`);
    assert.notEqual(h.label, "", "blank label");
    assert.ok(h.applicationNumber, `a timeline entry with no reference: ${JSON.stringify(h)}`);
  }
  const str = history.find((h) => h.applicationNumber === "187-26-000309-STR")!;
  const ele = history.find((h) => h.applicationNumber === "194-26-001482-ELEC")!;
  assert.ok(str && ele, `both filings must appear: ${JSON.stringify(history)}`);
  assert.equal(str.label, trackLabel("permit", "building"), "the STR filing is the building permit");
  assert.equal(ele.label, trackLabel("permit", "electrical"), "the ELEC filing is the electrical permit");
  assert.notEqual(str.label, ele.label, "both permits are still wearing one label");
  // The wording, not the operator's queue name.
  assert.match(str.statusLabel, /jurisdiction/i, str.statusLabel);
});

await check("THE TIMELINE CARRIES NO INTERNAL PROSE", () => {
  // raw_status_text and message are scraped portal prose / forwarded AHJ email. The status page is
  // public to anyone holding the link.
  const blob = JSON.stringify(projectStatusHistory(db, project.id));
  assert.doesNotMatch(blob, /assigned to a plans examiner/i, `raw portal text reached the client: ${blob}`);
  assert.doesNotMatch(blob, /rawStatusText|raw_status_text|message/i, blob);
});

await check("MUST NOT LOSE AUDIT FIDELITY: one audit row per CHECK, all six", () => {
  assert.equal(auditChecks(), 6,
    "the per-check evidence trail was collapsed along with the client timeline — audit_logs must "
    + "keep one permit_status.checked row for every time we looked");
});

await check("MUST KEEP LOOKING: last_checked_at STRICTLY advances on an unchanged poll", async () => {
  // The dedupe is about what the client is SHOWN, never about whether we looked. This is the one
  // assertion that stops the obvious wrong implementation of the write-time gate: putting the
  // permit_check_targets UPDATE inside the gated branch. Do that and last_checked_at freezes at
  // the last transition, and the operator's board reads "last checked three weeks ago" for a
  // target that is being polled nightly. "When did it move" and "when did we look" are two
  // different questions and both must keep an answer.
  for (const t of [strTarget, eleTarget]) {
    assert.ok(lastCheckedAt(t.id), `${t.applicationNumber} has no last_checked_at at all`);
    assert.ok(rowsFor(t.id) >= 1, "the first check must always be recorded");
  }
  const before = lastCheckedAt(strTarget.id);
  await new Promise((r) => setTimeout(r, 40)); // nowIso() is millisecond-precision
  await poll(strTarget.id, IN_REVIEW); // nothing has moved
  const after = lastCheckedAt(strTarget.id);
  assert.ok(after > before, // ISO-8601 sorts lexicographically
    `an unchanged poll left last_checked_at at ${before} — the target UPDATE must run whether or `
    + "not a row was written");
});

await check("A GENUINE TRANSITION WRITES A SECOND ENTRY", async () => {
  const before = projectStatusHistory(db, project.id).length;
  await poll(eleTarget.id, ISSUED);
  await new Promise((r) => setTimeout(r, 60)); // the client notify is fire-and-forget
  const after = projectStatusHistory(db, project.id);
  assert.equal(after.length, before + 1,
    `the move to issued never reached the timeline: ${JSON.stringify(after.map((h) => [h.label, h.statusLabel]))}`);
  assert.equal(after[0].label, "Electrical permit", "the newest entry must be the filing that moved");
  assert.match(after[0].statusLabel, /issued/i, after[0].statusLabel);
  // ...and the STRUCTURAL permit, which did not move, is still one entry and still "in review".
  const strEntries = after.filter((h) => h.applicationNumber === "187-26-000309-STR");
  assert.equal(strEntries.length, 1, `the untouched filing grew entries: ${JSON.stringify(strEntries)}`);
});

await check("A LABEL-ONLY TRANSITION IS A TRANSITION on the page too", async () => {
  // 187-26-000309-STR's real move: the city stopped reviewing and started waiting on us. The
  // outcome changes here (waiting → needs_human_review) AND so does the label; the policy test
  // above covers the outcome-identical case that only shouldRecordStatusCheck can see.
  const before = projectStatusHistory(db, project.id).length;
  await poll(strTarget.id, INTAKE_NEEDED);
  await poll(strTarget.id, INTAKE_NEEDED); // and the next sweep, which changed nothing
  const after = projectStatusHistory(db, project.id);
  assert.equal(after.length, before + 1,
    `the stall either never showed or showed twice: ${JSON.stringify(after.map((h) => [h.label, h.statusLabel]))}`);
  const newest = after[0];
  assert.equal(newest.label, "Building permit");
  assert.match(newest.statusLabel, /\bus\b/i,
    `the client is still not told the city is waiting on us: "${newest.statusLabel}"`);
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
  const before = projectStatusHistory(db, project.id, 50).length;
  await poll(strTarget.id, IN_REVIEW);
  await poll(eleTarget.id, ISSUED);
  await poll(strTarget.id, IN_REVIEW);
  await poll(eleTarget.id, ISSUED);
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

await check("A PROJECT WITH NO CHECKS AT ALL yields an empty timeline, not a crash", () => {
  const { project: fresh } = createProject(db, {
    clientId: client.id, owner: "Nothing Yet", street: "2 Empty Rd", city: "Coos Bay",
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "5", acKw: "4",
  });
  assert.deepEqual(projectStatusHistory(db, fresh.id), []);
  assert.deepEqual(projectStatusHistory(db, ""), []);
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nstatusHistoryTransitions: all checks passed."
  : `\nstatusHistoryTransitions: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
