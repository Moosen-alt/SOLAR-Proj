// THE NEXT STEP — one server-side answer to "what does this project need next, and from whom?"
//
// Before backend/src/nextStep.ts the answer was guessed in several places that disagreed (the
// dashboard's client-side nextStepFor/boardAttention, current_stage prose, the autopilot badge
// replaying an old job result). This file pins:
//
//   RULE TABLE   — decideNextStep over hand-built facts: first match wins, in the documented
//                  order, and each rule names who / urgency / the one button.
//   REGRESSIONS  — a FILED track that is not done is "waiting on the agency", never "unknown"
//                  (the first production run hit that on an issued project); a failed re-run on a
//                  filed track is not a staging failure.
//   BUTTON IDS   — every button / fixTarget the table can emit exists in the working-tree
//                  frontend/dashboard.html (a next step that points at nothing is a dead end).
//   READ-ONLY    — computeNextStep, getProjectList and getAutopilotState write nothing, and the
//                  code-research enqueue an un-profiled jurisdiction triggers is suppressed.
//   ONE ANSWER   — the list row's compact nextStep and the detail answer agree.
//   COST         — getProjectList with nextStep on 200 rows (measured, printed).
//
//   npx tsx backend/test/nextStep.test.ts
import { REPO } from "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ logs never land in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "next-step-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;
delete process.env.SKIP_CODE_RESEARCH;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { createProject, getProjectList, getProjectDetail } = await import("../src/repository");
const { getAutopilotState } = await import("../src/autopilot");
const nextStepModule = await import("../src/nextStep");
const { decideNextStep, computeNextStep, NEXT_STEP_BUTTON_IDS, NEXT_STEP_FIX_TARGETS } = nextStepModule;
type NextStepFacts = import("../src/nextStep").NextStepFacts;
type TrackFacts = import("../src/nextStep").TrackFacts;
type RunLite = import("../src/nextStep").RunLite;
type CorrectionRecord = import("../../shared/src/types").CorrectionRecord;

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 1 — THE RULE TABLE (pure)
// ═══════════════════════════════════════════════════════════════════════════════════════
let runSeq = 0;
const run = (status: string, over: Partial<RunLite> = {}): RunLite => ({
  id: `run-${status}-${runSeq++}`, status, permitType: "nem", startedAt: "2026-09-20T10:00:00.000Z", errorMessage: "", pauseReason: null, ...over,
});
const track = (t: TrackFacts["track"], over: Partial<TrackFacts> = {}): TrackFacts => ({
  track: t, filed: false, filedAt: null, done: false, latestRun: null, onPortal: false, stagedRun: null, gapFillMissing: [], feeDue: false, paymentDue: false, ...over,
});
const corr = (over: Partial<CorrectionRecord> = {}): CorrectionRecord => ({
  id: "c1", projectId: "p1", source: "manual", correctionText: "x", correctionBucket: "A_we_fix", rootCause: "", requiredAction: "",
  assignedTo: "", draftResponse: "", humanApproved: false, resubmitted: false, newRuleRecommended: false,
  createdAt: "2026-09-01T00:00:00.000Z", closedAt: null, dueAt: "2026-09-06", slaDays: 5, daysOpen: 3, isOverdue: false, ...over,
});
const facts = (over: Partial<NextStepFacts> = {}): NextStepFacts => ({
  projectId: "p1", status: "ready_to_stage", stageDetail: "", archived: false, ahj: "Portland", utility: "PGE",
  operatorHold: null, openCorrections: [], jobInFlight: null, tracks: [track("nem"), track("combo")], reopenPause: null,
  qcRan: true, qcFails: [], qcReview: [], portalReadings: 0, approvedRunIds: [], ...over,
});
const cleanGate = { decision: "ready_to_stage" as const, blockers: [] };
const emitted = new Set<string>();
const emittedTargets = new Set<string>();
const decide = (f: NextStepFacts) => {
  const step = decideNextStep(f);
  if (step.button) emitted.add(step.button.id);
  for (const w of step.why) if (w.fixTarget) emittedTargets.add(w.fixTarget);
  assert.ok(step.why.length <= 3, `why has ${step.why.length} entries (max 3)`);
  assert.ok(step.headline.length > 0 && !/undefined|null/.test(step.headline), `headline: ${step.headline}`);
  return step;
};

await check("a clean pre-stage project: ready_to_stage, me, today, the Stage portals button", () => {
  const list = decide(facts());
  assert.equal(list.key, "ready_to_stage");
  assert.equal(list.who, "me");
  assert.equal(list.urgency, "today");
  assert.equal(list.button?.id, "startAutopilotBtn");
  assert.equal(list.gateChecked, false);
  assert.match(list.headline, /checks the submit gate/i, "the list tier must not assert the gate is clean");
  const full = decide(facts({ gate: cleanGate, reviewerBlockers: [] }));
  assert.equal(full.gateChecked, true);
  assert.match(full.headline, /press Stage portals/);
});

await check("operator block wins over everything, including an overdue correction", () => {
  const step = decide(facts({ status: "blocked", operatorHold: { reason: "waiting on the customer", since: "2026-09-10T00:00:00.000Z" }, openCorrections: [corr({ isOverdue: true })] }));
  assert.equal(step.key, "operator_blocked");
  assert.equal(step.button?.id, "applyStatusOverrideBtn");
  assert.equal(step.why[0].fixTarget, "statusOverrideWrap");
});

await check("an overdue correction is overdue urgency, owned by its triage bucket, and beats a portal pause", () => {
  const step = decide(facts({
    openCorrections: [corr({ isOverdue: true, correctionBucket: "B_designer_fix", dueAt: "2026-09-06" })],
    tracks: [track("nem", { latestRun: run("paused_for_human", { pauseReason: "mfa" }) })],
  }));
  assert.equal(step.key, "correction_overdue");
  assert.equal(step.urgency, "overdue");
  assert.equal(step.who, "designer");
  assert.match(step.headline, /2026-09-06/);
});

await check("a paused portal run (per track, or a paused correction reopen) needs a person", () => {
  const step = decide(facts({ tracks: [track("nem", { latestRun: run("paused_for_human", { pauseReason: "mfa_captcha" }), onPortal: true }), track("combo")] }));
  assert.equal(step.key, "portal_paused");
  assert.match(step.headline, /interconnection/);
  const reopen = decide(facts({ reopenPause: run("paused_for_human"), openCorrections: [corr()] }));
  assert.equal(reopen.key, "portal_paused");
});

await check("a job in flight: nobody, waiting", () => {
  const step = decide(facts({ jobInFlight: { jobType: "autopilot", since: "2026-09-20T00:00:00.000Z" } }));
  assert.equal(step.key, "automation_running");
  assert.equal(step.who, "nobody");
  assert.equal(step.urgency, "waiting");
});

await check("staging failed is PER TRACK and names only the failed track", () => {
  const step = decide(facts({
    tracks: [
      track("nem", { latestRun: run("awaiting_human_submit"), onPortal: true, stagedRun: run("awaiting_human_submit") }),
      track("building", { latestRun: run("failed", { permitType: "building", errorMessage: "login form not found" }) }),
    ],
  }));
  assert.equal(step.key, "staging_failed");
  assert.match(step.headline, /building permit/);
  assert.doesNotMatch(step.headline, /interconnection/);
  assert.match(step.why[0].text, /login form not found/);
});

await check("a failed re-run on a FILED track is not a staging failure (the issued-project shape)", () => {
  const step = decide(facts({
    status: "issued",
    tracks: [
      track("nem", { filed: true, filedAt: "2026-09-02T02:33:09.040Z", latestRun: run("failed") }),
      track("building", { filed: true, done: true, latestRun: run("submitted", { permitType: "building" }) }),
    ],
  }));
  assert.notEqual(step.key, "staging_failed");
  assert.equal(step.key, "waiting_on_agency");
});

await check("REGRESSION: filed-but-not-done tracks read waiting_on_agency, never unknown", () => {
  const step = decide(facts({
    status: "issued",
    tracks: [track("nem", { filed: true, filedAt: "2026-09-02T00:00:00.000Z" }), track("building", { filed: true }), track("electrical", { filed: true, done: true })],
  }));
  assert.equal(step.key, "waiting_on_agency");
  assert.equal(step.who, "ahj", "a permit still out → the AHJ has the ball");
  assert.equal(step.urgency, "waiting");
  const nemOnly = decide(facts({ status: "issued", tracks: [track("nem", { filed: true }), track("combo", { filed: true, done: true })] }));
  assert.equal(nemOnly.who, "utility");
});

await check("QC work: not run → Run QC; failures → Re-run QC; pending QC items → review; none once everything is filed", () => {
  assert.equal(decide(facts({ status: "parsed", qcRan: false })).button?.id, "runQcBtn");
  const failed = decide(facts({ qcFails: [{ ruleName: "DC size", message: "missing" }] }));
  assert.equal(failed.key, "qc_failed");
  assert.equal(failed.button?.id, "runQcBtn");
  const review = decide(facts({ qcReview: [{ issueType: "Required locates", fieldName: "locates" }] }));
  assert.equal(review.key, "qc_review_pending");
  const filed = decide(facts({ status: "submitted", qcFails: [{ ruleName: "x", message: "y" }], tracks: [track("nem", { filed: true }), track("combo", { filed: true })] }));
  assert.notEqual(filed.key, "qc_failed", "QC on a fully-filed project is not the next step");
});

await check("gate blockers (detail tier): reviewer findings → designer + the correction packet; documents → me", () => {
  const designer = decide(facts({ gate: { decision: "blocked", blockers: [{ id: "permit-requirements", title: "PermitFlow reviewer and history check", nextAction: "Clear AHJ blocker callouts." }] } }));
  assert.equal(designer.key, "gate_blocked");
  assert.equal(designer.who, "designer");
  assert.equal(designer.button?.id, "openReviewerPacketBtn");
  const docs = decide(facts({ gate: { decision: "blocked", blockers: [{ id: "document-inventory", title: "Required documents attached", nextAction: "Attach or split out the missing document(s) before staging: SLD." }] } }));
  assert.equal(docs.who, "me");
  assert.match(docs.headline, /missing/);
  assert.match(docs.why[0].text, /SLD/);
});

await check("gap-fill missing on a staged draft outranks the staged draft itself", () => {
  const staged = run("awaiting_human_submit");
  const step = decide(facts({ status: "awaiting_human_submit", tracks: [track("nem", { stagedRun: staged, latestRun: staged, onPortal: true, gapFillMissing: ["Meter number"] }), track("combo", { onPortal: true, latestRun: run("awaiting_human_submit"), stagedRun: run("awaiting_human_submit") })] }));
  assert.equal(step.key, "gap_fill_missing");
  assert.match(step.why[0].text, /Meter number/);
});

await check("staged drafts: approve (unless the reviewer gate refuses), then file after approval", () => {
  const staged = run("awaiting_human_submit");
  const base = { status: "awaiting_human_submit" as const, tracks: [track("nem", { stagedRun: staged, latestRun: staged, onPortal: true }), track("combo", { filed: true })] };
  const step = decide(facts(base));
  assert.equal(step.key, "staged_awaiting_submit");
  assert.equal(step.button?.id, "approveSubmitBtn");
  assert.match(step.headline, /PGE/);
  // The staged draft renders in the PINNED card (#portalRunsPinned), not the folded run history.
  assert.equal(step.why[0].fixTarget, "portalRunsPinned", "the staged-draft 'why' points at the folded history, not the pinned draft card");
  assert.equal(decide(facts({ ...base, reviewerBlockers: [{ code: "x", detail: "y" }] })).button, null,
    "Approve would 409 on reviewer blockers — do not offer it");
  const approved = decide(facts({ ...base, approvedRunIds: [staged.id] }));
  assert.equal(approved.key, "approved_awaiting_filing");
  assert.equal(approved.why[0].fixTarget, "confirmationForm");
});

await check("a reopened correction waits for the human resubmit", () => {
  assert.equal(decide(facts({ status: "awaiting_human_resubmit", openCorrections: [corr()] })).key, "resubmit_awaiting_me");
});

await check("fee due, then open corrections by bucket (A → me today, B → designer waiting)", () => {
  const filed = [track("nem", { filed: true }), track("combo", { filed: true, feeDue: true })];
  assert.equal(decide(facts({ status: "ready_for_issue", tracks: filed })).key, "fee_due");
  const tracksFiled = [track("nem", { filed: true }), track("combo", { filed: true })];
  const a = decide(facts({ status: "correction_triaged", tracks: tracksFiled, openCorrections: [corr({ correctionBucket: "A_we_fix" })] }));
  assert.equal(a.key, "correction_open");
  assert.equal(a.who, "me");
  const b = decide(facts({ status: "waiting_on_designer", tracks: tracksFiled, openCorrections: [corr({ correctionBucket: "B_designer_fix" })] }));
  assert.equal(b.who, "designer");
  assert.equal(b.urgency, "waiting");
});

await check("a per-submission client's unpaid track: payment_due (the 402) before ready_to_stage", () => {
  const step = decide(facts({ tracks: [track("nem", { paymentDue: true }), track("combo")] }));
  assert.equal(step.key, "payment_due");
  assert.equal(step.who, "customer");
  assert.equal(step.why[0].fixTarget, "paymentPanel");
});

await check("past Submit, an unfiled track points at its track card, not the (disabled) Stage portals button", () => {
  const step = decide(facts({ status: "submitted", tracks: [track("nem", { filed: true }), track("combo")] }));
  assert.equal(step.key, "ready_to_stage");
  assert.equal(step.button, null);
  assert.equal(step.why[0].fixTarget, "submittalTracks");
});

await check("untracked filing, portal readings, handoff, done, archived, unknown", () => {
  const filed = [track("nem", { filed: true }), track("combo", { filed: true })];
  assert.equal(decide(facts({ status: "submitted", stageDetail: "submitted_untracked", tracks: filed })).button?.id, "addPermitTargetBtn");
  assert.equal(decide(facts({ status: "submitted", portalReadings: 3, tracks: filed })).key, "portal_readings");
  const handoff = decide(facts({ status: "handoff_ready", tracks: [track("nem", { done: true }), track("combo", { done: true })] }));
  assert.equal(handoff.key, "handoff_ready");
  assert.equal(handoff.button?.id, "copyHandoffPacketBtn");
  assert.equal(decide(facts({ status: "issued", tracks: [track("nem", { done: true }), track("combo", { done: true })] })).key, "done");
  assert.equal(decide(facts({ archived: true })).key, "archived");
  const unknown = decide(facts({ status: "submitted", tracks: [] }));
  assert.equal(unknown.key, "unknown");
  assert.equal(unknown.who, "me", "an unknown must not read as reassurance");
});

// THE CLIENT'S RULE COPIES, NOW ON THE ANSWER. dashboard.js kept its own key lists
// (NEXT_STEP_ALL_FILED_KEYS, NEXT_STEP_GATE_CAN_OVERRULE) and a status test for "draft staged";
// each is now one boolean derived in nextStep.ts.
await check("allFiled: true exactly when every required track is filed or done — whatever the key", () => {
  const filed = [track("nem", { filed: true }), track("combo", { filed: true })];
  for (const f of [
    facts({ status: "submitted", portalReadings: 2, tracks: filed }),
    facts({ status: "submitted", tracks: filed }),
    facts({ status: "ready_for_issue", tracks: [track("nem", { filed: true }), track("combo", { filed: true, feeDue: true })] }),
    facts({ status: "correction_triaged", tracks: filed, openCorrections: [corr()] }),
    facts({ status: "issued", tracks: [track("nem", { done: true }), track("combo", { done: true })] }),
  ]) {
    const step = decide(f);
    assert.equal(step.allFiled, true, `${step.key}: allFiled false with every track filed`);
  }
  // MUST NOT: one unfiled track (past Submit, or staged-not-filed) is not "all filed".
  assert.equal(decide(facts({ status: "submitted", tracks: [track("nem", { filed: true }), track("combo")] })).allFiled, false);
  const staged = run("awaiting_human_submit");
  assert.equal(decide(facts({ status: "awaiting_human_submit", tracks: [track("nem", { stagedRun: staged, latestRun: staged, onPortal: true }), track("combo", { filed: true })] })).allFiled, false);
  assert.equal(decide(facts({ status: "submitted", tracks: [] })).allFiled, false, "no tracks is an unknown, never 'all filed'");
});

await check("gateCanOverrule: only a list answer produced AFTER the gate rule, with something still to file", () => {
  const staged = run("awaiting_human_submit");
  const stagedTracks = [track("nem", { stagedRun: staged, latestRun: staged, onPortal: true }), track("combo")];
  // Past rule 7 on the list tier with work left → the full answer may differ.
  for (const f of [
    facts(),                                                                  // ready_to_stage
    facts({ tracks: [track("nem", { paymentDue: true }), track("combo")] }),  // payment_due
    facts({ status: "awaiting_human_submit", tracks: stagedTracks }),         // staged_awaiting_submit
    facts({ status: "awaiting_human_resubmit", openCorrections: [corr()] }),  // resubmit_awaiting_me (rule 9 < rule 7)
  ]) {
    const step = decide(f);
    assert.equal(step.gateCanOverrule, true, `${step.key}: list answer after the gate rule not marked overrulable`);
    assert.equal(decide({ ...f, gate: cleanGate, reviewerBlockers: [] }).gateCanOverrule, false, `${step.key}: the full answer ran the gate`);
  }
  // Rules BEFORE the gate cannot be pre-empted by it.
  for (const f of [
    facts({ qcFails: [{ ruleName: "x", message: "y" }] }),
    facts({ tracks: [track("nem", { latestRun: run("failed") }), track("combo")] }),
    facts({ status: "blocked", operatorHold: { reason: "r", since: null } }),
  ]) {
    const step = decide(f);
    assert.equal(step.gateCanOverrule, false, `${step.key}: comes before the gate rule`);
  }
  // Nothing left to file → rule 7 cannot fire (it needs an unfiled track).
  const filed = [track("nem", { filed: true }), track("combo", { filed: true })];
  const fee = decide(facts({ status: "ready_for_issue", tracks: [track("nem", { filed: true }), track("combo", { filed: true, feeDue: true })] }));
  assert.equal(fee.key, "fee_due");
  assert.equal(fee.gateCanOverrule, false);
  assert.equal(decide(facts({ status: "submitted", tracks: filed, openCorrections: [corr()] })).gateCanOverrule, false);
});

await check("hasStagedDraft: an unfiled track's draft awaits a person (or a reopened form), whatever the key says", () => {
  const staged = run("awaiting_human_submit");
  // The operator's misfile: a staged NEM draft behind a failed building run reads staging_failed.
  const behindFailure = decide(facts({ status: "awaiting_human_submit", tracks: [
    track("nem", { stagedRun: staged, latestRun: staged, onPortal: true }),
    track("building", { latestRun: run("failed", { permitType: "building" }) }),
  ] }));
  assert.equal(behindFailure.key, "staging_failed");
  assert.equal(behindFailure.hasStagedDraft, true);
  assert.equal(decide(facts({ status: "awaiting_human_resubmit", openCorrections: [corr()] })).hasStagedDraft, true);
  // The run is the evidence, not the status: a draft on the portal of a project whose status was
  // moved back (an operator override) is still a draft awaiting a person...
  assert.equal(decide(facts({ status: "ready_to_stage", tracks: [track("nem", { stagedRun: staged, latestRun: staged, onPortal: true }), track("combo")] })).hasStagedDraft, true);
  // ...and MUST NOT: a status that says awaiting with no draft of an unfiled track behind it (the
  // staged track has since been FILED), nothing staged at all, or an archived project.
  assert.equal(decide(facts({ status: "awaiting_human_submit", tracks: [track("nem", { filed: true, stagedRun: staged }), track("combo", { latestRun: run("failed") })] })).hasStagedDraft, false);
  assert.equal(decide(facts()).hasStagedDraft, false);
  assert.equal(decide(facts({ status: "submitted", tracks: [track("nem", { filed: true, stagedRun: staged }), track("combo", { filed: true })] })).hasStagedDraft, false);
  assert.equal(decide(facts({ archived: true, status: "awaiting_human_submit", tracks: [track("nem", { stagedRun: staged, onPortal: true })] })).hasStagedDraft, false);
});

await check("compactNextStep carries the three flags unchanged", () => {
  const staged = run("awaiting_human_submit");
  const full = decide(facts({ status: "awaiting_human_submit", tracks: [track("nem", { stagedRun: staged, latestRun: staged, onPortal: true }), track("combo")] }));
  const c = nextStepModule.compactNextStep(full);
  assert.deepEqual([c.allFiled, c.gateCanOverrule, c.hasStagedDraft], [full.allFiled, full.gateCanOverrule, full.hasStagedDraft]);
  assert.deepEqual([c.allFiled, c.gateCanOverrule, c.hasStagedDraft], [false, true, true]);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 2 — every id the table can emit exists in the working-tree dashboard
// ═══════════════════════════════════════════════════════════════════════════════════════
await check("every emittable button is a <button> in frontend/dashboard.html, every fixTarget an element id", () => {
  const html = fs.readFileSync(path.join(REPO, "frontend", "dashboard.html"), "utf8");
  for (const id of NEXT_STEP_BUTTON_IDS) {
    assert.ok(new RegExp(`<button[^>]*\\bid="${id}"`).test(html), `button #${id} is not a <button> in dashboard.html`);
  }
  for (const id of NEXT_STEP_FIX_TARGETS) {
    assert.ok(html.includes(`id="${id}"`), `fixTarget #${id} is not an element in dashboard.html`);
  }
  for (const id of emitted) assert.ok((NEXT_STEP_BUTTON_IDS as readonly string[]).includes(id), `rule table emitted #${id}, which is not in NEXT_STEP_BUTTON_IDS`);
  for (const id of emittedTargets) assert.ok((NEXT_STEP_FIX_TARGETS as readonly string[]).includes(id), `rule table emitted fixTarget #${id}, not in NEXT_STEP_FIX_TARGETS`);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 3 — the real database: read-only, one answer, cost
// ═══════════════════════════════════════════════════════════════════════════════════════
const db = await openDatabase();
const createdIds: string[] = [];
const client = createClient(db, {
  companyName: "Next Step Solar LLC", legalBusinessName: "Next Step Solar LLC", ccbLicenseNumber: "240135",
  electricalLicenseNumber: "C1234", businessEmail: "ops@nextstep.test", businessPhone: "(503) 555-0142",
});
// The smoke's own fixture (backend/src/smoke.ts): proven to clear QC, the document gate and the reviewer gate.
const FIXTURE = {
  owner: "Next Step Owner", street: "123 Solar Way", city: "Portland", state: "OR", zip: "97201", ahj: "Portland", utility: "PGE",
  account: "1234567890", meter: "987654321", dcKw: "8.6", acKw: "6.5", exportKw: "6.5", moduleMake: "Qcells",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20", invModel: "IQ8M", invQty: "20", invOutputW: "325",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40", permitPath: "PRESCRIPTIVE",
  roofRafterSpacing: "24", roofRafterSpan: "10", snow: "25", deadLoad: "3.2", wind: "B",
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
const passing = createProject(db, { clientId: client.id, ...FIXTURE });
const passingId = passing.project.id;
createdIds.push(passingId);
saveProjectDocument(db, passingId, {
  docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n% next step plan set\n", "utf8"), source: "upload",
});

// A write trap: every write the AppDb can make goes through run / exec / transaction.
const trapWrites = <T>(fn: () => T): { value: T; writes: string[] } => {
  const writes: string[] = [];
  const orig = { run: db.run, exec: db.exec, transaction: db.transaction };
  db.run = ((sql: string) => { writes.push(sql.trim().slice(0, 60)); }) as typeof db.run;
  db.exec = ((sql: string) => { writes.push(sql.trim().slice(0, 60)); }) as typeof db.exec;
  db.transaction = (<R>(f: () => R): R => { writes.push("transaction"); return f(); }) as typeof db.transaction;
  try {
    return { value: fn(), writes };
  } finally {
    db.run = orig.run; db.exec = orig.exec; db.transaction = orig.transaction;
  }
};

await check("computeNextStep, getProjectList and getAutopilotState write NOTHING", () => {
  const a = trapWrites(() => computeNextStep(db, passingId));
  assert.deepEqual(a.writes, [], `computeNextStep wrote: ${a.writes.join(" | ")}`);
  const b = trapWrites(() => getProjectList(db, { limit: 50 }));
  assert.deepEqual(b.writes, [], `getProjectList wrote: ${b.writes.join(" | ")}`);
  const c = trapWrites(() => getAutopilotState(db, passingId));
  assert.deepEqual(c.writes, [], `getAutopilotState wrote: ${c.writes.join(" | ")}`);
});

await check("the fixture project reads ready_to_stage on BOTH tiers, and the list row agrees with the detail", () => {
  const detail = computeNextStep(db, passingId);
  assert.equal(detail.gateChecked, true);
  assert.equal(detail.key, "ready_to_stage", `detail says ${detail.key}: ${detail.headline} // ${detail.why.map((w) => w.text).join(" | ")}`);
  const row = getProjectList(db, { limit: 50 }).projects.find((p) => p.id === passingId)!;
  assert.equal(row.nextStep.key, detail.key);
  assert.equal(row.nextStep.who, detail.who);
  assert.equal(row.nextStep.buttonId, detail.button?.id ?? null);
  assert.equal(row.nextStep.gateChecked, false);
  // The client's three flags ride on the list row (the board reads them, never a key list).
  assert.equal(row.nextStep.allFiled, false);
  assert.equal(row.nextStep.hasStagedDraft, false);
  assert.equal(row.nextStep.gateCanOverrule, true, "a list-tier ready_to_stage is one the gate can overrule");
  assert.equal(detail.gateCanOverrule, false, "the full answer ran the gate — nothing left to overrule it");
});

await check("an un-profiled jurisdiction: reading the next step does NOT enqueue code research (a write)", async () => {
  // Created with research suppressed, so nothing is in flight or recent for this jurisdiction.
  process.env.SKIP_CODE_RESEARCH = "1";
  const remote = createProject(db, { clientId: client.id, ...FIXTURE, owner: "Remote Owner", city: "Nowhereville", state: "ZZ", ahj: "Nowhereville Building Division", utility: "Remote Power Co" });
  delete process.env.SKIP_CODE_RESEARCH;
  createdIds.push(remote.project.id);
  const researchJobs = () => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'code_research'")?.n ?? 0);
  const before = researchJobs();
  computeNextStep(db, remote.project.id);
  await new Promise((r) => setTimeout(r, 300)); // the enqueue is a void import().then
  assert.equal(researchJobs(), before, "computeNextStep queued jurisdiction code research — a read wrote a job row");
  assert.equal(process.env.SKIP_CODE_RESEARCH, undefined, "the suppression leaked out of the read");
});

await check("COST: getProjectList with nextStep on 200 rows (printed; loose bound)", () => {
  // Clone the fixture row 200 times with the child rows the facts loader reads — a staged run,
  // a failed run, a filed submission, a tracking target and a pending review item each.
  const cols = db.query<{ name: string }>("PRAGMA table_info(projects)").map((c) => c.name).filter((c) => c !== "id");
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let i = 0; i < 200; i++) {
      const cid = `cost-${String(i).padStart(4, "0")}`;
      db.run(`INSERT INTO projects (id, ${cols.join(", ")}) SELECT ?, ${cols.join(", ")} FROM projects WHERE id = ?`, [cid, passingId]);
      db.run(`INSERT INTO portal_runs (id, project_id, run_type, status, started_at, permit_type, result_json) VALUES (?, ?, 'prepare_submit', 'awaiting_human_submit', ?, 'nem', '{"steps":[]}')`, [`${cid}-r1`, cid, now]);
      db.run(`INSERT INTO portal_runs (id, project_id, run_type, status, started_at, permit_type) VALUES (?, ?, 'prepare_submit', 'failed', ?, 'combo')`, [`${cid}-r2`, cid, now]);
      db.run(`INSERT INTO submissions (id, project_id, submission_type, status, permit_type, created_at) VALUES (?, ?, 'permit', 'submitted', 'combo', ?)`, [`${cid}-s1`, cid, now]);
      db.run(`INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, application_number, active, latest_outcome, created_at, updated_at) VALUES (?, ?, 'permit', 'combo', ?, 1, 'waiting', ?, ?)`, [`${cid}-t1`, cid, `APP-${i}`, now, now]);
      db.run(`INSERT INTO human_review_items (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at) VALUES (?, ?, 'Permit monitor status review', 'permit_status', '', '', '', 'pending', '', ?, ?)`, [`${cid}-h1`, cid, now, now]);
    }
  });
  getProjectList(db, { limit: 200 }); // warm
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const { projects } = getProjectList(db, { limit: 200 });
    times.push(performance.now() - t0);
    assert.equal(projects.length, 200);
    assert.ok(projects.every((p) => p.nextStep && p.nextStep.key), "every row carries a nextStep");
  }
  const best = Math.min(...times);
  console.log(`         getProjectList(limit 200) with nextStep: best ${best.toFixed(0)}ms of ${times.map((t) => t.toFixed(0)).join("/")}ms`);
  assert.ok(best < 2000, `200 rows took ${best.toFixed(0)}ms`);
  db.transaction(() => {
    for (const table of ["portal_runs", "submissions", "permit_check_targets", "human_review_items"]) db.run(`DELETE FROM ${table} WHERE project_id LIKE 'cost-%'`);
    db.run("DELETE FROM projects WHERE id LIKE 'cost-%'");
  });
});

// Created projects write backend/data/filled/<id>/ under the cwd — remove ours.
for (const pid of createdIds) {
  try { getProjectDetail(db, pid); } catch { /* ignore */ }
  fs.rmSync(path.resolve("backend/data/filled", pid), { recursive: true, force: true });
}

if (failures) {
  console.error(`\nnextStep: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nnextStep: all checks passed");
