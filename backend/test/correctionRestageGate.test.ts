// THE RE-STAGE ENTRY IS NOT A SHORTCUT.
//
// Resolving the last correction on a project with NOTHING on file used to write `parsed`.
// That was a visual rewind to stage 0 — but the comment on the write site also named a
// property worth keeping: `parsed` is a PRE-STAGE status, so the corrected project re-entered
// the pipeline at the top and re-ran QC and every gate rather than jumping ahead of them.
// Round B1 moved the leg to `ready_to_resubmit` (the Submit stage, where a corrected job
// actually is). THIS FILE IS THE PROOF THAT NOTHING WAS TRADED AWAY.
//
// What it pins, through PRODUCTION entry points only:
//
//   1. THE GATE LADDER IS STATUS-BLIND. prepareSubmission — the real gate path, not a mirror
//      helper — is called on the SAME project as it moves through three statuses reached the
//      real way: `qc_failed` (createProject runs QC inline), `correction_triaged`
//      (addManualCorrection) and `ready_to_resubmit` (resolveCorrection with nothing on file).
//      The 409 payload it hands back must not get LOOSER. A newly reachable status must never
//      become a gate bypass.
//   2. THE SAME-DATA A/B. Segment A then re-runs QC — which must NOT relabel the project
//      (QC may not move a Submit-stage status: projectStage.qcMayMoveStatus) — and the operator
//      override (setProjectStatusByOperator, the real door) then moves it to `qc_failed` without
//      touching any gate input. Only the STATUS differs between the two prepareSubmission calls,
//      and the payload must be byte-identical.
//   3. NO STATUS BRANCH EXISTS TO SKIP. prepareSubmission's body is read off disk and asserted
//      to contain no project-status gate — the structural reason checks 1 and 2 hold for every
//      rung of the ladder, not just the first one a bare fixture reaches. Its gates key on
//      payment, a submitted SUBMISSION row, QC/review/reviewer/historical, document presence,
//      permit path and client — never on projects.status. The ONE exception is refusal-only:
//      an operator's `blocked` hold (operatorHoldReason) can stop staging and can never admit it.
//   4. QC REALLY RE-RUNS. The qc_results rows are DELETED before Segment A is driven from
//      `ready_to_resubmit`. They must come back, and the run must still block on the QC gate.
//   5. THE UNTYPED SET. PRE_STAGE_STATUSES (autopilot.ts) is a plain string Set: typecheck
//      cannot tell when a live status is missing from it, and a missing entry silently kills
//      the auto-resume the resolve route fires ("a correction was resolved"), stranding the
//      corrected project exactly the way correction_triaged strands one. A project at
//      `ready_to_resubmit` with a gate-blocked autopilot job must be re-enqueued; one still at
//      `correction_triaged` must not — that control is what proves the Set is consulted rather
//      than bypassed.
//
// NO LONGER RECORDED AS A WART: runQcForProject used to write projects.status unconditionally,
// so Segment A's own rerunQc relabelled the project away from `ready_to_resubmit` (to
// `qc_failed`) the moment it started. QC now leaves any status at or past the Submit stage alone
// (projectStage.qcMayMoveStatus), so the corrected project keeps reading `ready_to_resubmit` —
// and check 2 asserts THAT, while QC's verdict still reaches staging through qc_results.
//
// Browser-free. Run: tsx backend/test/correctionRestageGate.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-restage-gate-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = ""; // regex correction classifier only — no agent job
process.env.AUTOPILOT_AUTO_START = "0"; // lifted for section 5, which is ABOUT the auto-resume

const { openDatabase } = await import("../src/db");
const { createProject, addManualCorrection, resolveCorrection, prepareSubmission, setProjectStatusByOperator } = await import("../src/repository");
const { runAutopilotSegmentA, maybeResumeAutopilot } = await import("../src/autopilot");
const { persistTriage } = await import("../src/correctionAgent");
const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
};

const qcRows = (pid: string): number =>
  Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM qc_results WHERE project_id = ?", [pid])?.n ?? 0);
const statusOf = (pid: string): string =>
  String(db.get<{ status?: string }>("SELECT status FROM projects WHERE id = ?", [pid])?.status ?? "");

interface GateDetails {
  failCount?: number;
  pendingCount?: number;
  reviewerBlockerCount?: number;
  reviewerBlockers?: string[];
  historicalMissingCount?: number;
  historicalMissing?: string[];
}
interface Refusal { status: number; message: string; details: GateDetails }

// The refusal prepareSubmission hands back, captured as data. `details` IS the 409 payload
// every caller reads (autopilot's blockersFromHttpError, the dashboard's blocker list).
const refusal = async (pid: string): Promise<Refusal> => {
  try {
    await prepareSubmission(db, pid);
  } catch (err) {
    const e = err as { status?: number; message?: string; details?: GateDetails };
    return { status: Number(e.status ?? 0), message: String(e.message ?? ""), details: e.details ?? {} };
  }
  throw new Error("prepareSubmission did NOT refuse — the fixture proves nothing");
};
// Everything the gate ladder reports EXCEPT the learned-historical counters, which are the one
// part the correction cycle itself legitimately changes (see the section-1 note).
const withoutHistorical = (d: GateDetails) => ({
  failCount: d.failCount, pendingCount: d.pendingCount,
  reviewerBlockerCount: d.reviewerBlockerCount, reviewerBlockers: d.reviewerBlockers,
});

// ── 1: the gate ladder as the project walks three real lifecycle statuses ─────────────
const detail = createProject(db, {
  owner: "Restage Owner", address: "11 Restage Way", city: "Portland", state: "OR", zip: "97201",
  ahj: "City of Portland", utility: "PGE", dcKw: "6.0",
});
const projectId = detail.project.id;

// createProject runs QC inline, so the birth status `parsed` is gone before any caller can
// read it. That is the honest baseline: the status this leg USED to write was not a status
// staging ever actually saw either.
const bornAs = statusOf(projectId);
console.log(`     status after createProject: ${bornAs}`);
const atQcFailed = await refusal(projectId);
console.log(`     prepareSubmission @ ${bornAs}: ${atQcFailed.status} ${JSON.stringify(atQcFailed.details)}`);

check("the gate ladder actually refuses a bare project (the fixture proves something)", () => {
  assert.equal(bornAs, "qc_failed", "createProject runs QC inline");
  assert.equal(atQcFailed.status, 409, "staging a project that has not passed QC must be refused");
  assert.ok(Number(atQcFailed.details.failCount) > 0, "the QC gate is the rung this fixture reaches");
  assert.ok(Number(atQcFailed.details.reviewerBlockerCount) > 0, "the reviewer gate is in the same refusal");
});

const triaged = addManualCorrection(db, projectId, "Please revise the one-line diagram to show the AC disconnect location.");
assert.equal(triaged.project.status, "correction_triaged");
// The regex classifier cannot name this one (bucket C, "Unclassified correction"), and a C
// correction teaches no failure pattern; the learned title reads the CLASSIFICATION, never the raw
// sample (L4/L7). So the learning arrives with the triage verdict, as it does live — driven here
// through the agent's own persistence (persistTriage), since the fixture runs with no API key.
persistTriage(db, { correctionId: triaged.corrections[0].id, projectId }, {
  bucket: "B_designer_fix",
  rootCause: "One-line / SLD does not show the AC disconnect location",
  requiredAction: "Revise the SLD to show the AC disconnect location and resubmit.",
  actions: [],
  proposals: [],
});
const atTriaged = await refusal(projectId);

check("an open correction does not loosen what the gate ladder reports", () => {
  assert.equal(statusOf(projectId), "correction_triaged");
  assert.equal(atTriaged.status, atQcFailed.status);
  assert.deepEqual(
    withoutHistorical(atTriaged.details),
    withoutHistorical(atQcFailed.details),
    "a correction's own review item must not be counted as a pending gate, and nothing else may move",
  );
  // The ONE counter that legitimately moves, and it moves here — at RECORD time, not at
  // resolve time: classifying a correction teaches the knowledge base a historical failure
  // example for this AHJ/utility profile, and the learned-failure gate then wants evidence
  // against it. A gate getting STRICTER after a correction is the system working.
  assert.ok(
    Number(atTriaged.details.historicalMissingCount ?? 0) > Number(atQcFailed.details.historicalMissingCount ?? 0),
    "recording a correction must feed the learned-historical gate",
  );
});

// Reach `ready_to_resubmit` THROUGH THE REAL WRITE PATH. No submission row exists for this
// project, so resolveCorrection takes the nothing-on-file leg.
const openCorrection = triaged.corrections.filter((c) => !c.closedAt)[0];
resolveCorrection(db, openCorrection.id, { resubmitted: false });

check("resolving the last correction with nothing on file lands on 'ready_to_resubmit'", () => {
  assert.equal(statusOf(projectId), "ready_to_resubmit");
  assert.notEqual(statusOf(projectId), "parsed", "MUST-EXCLUDE: no stage-0 rewind on the resolve leg");
});

const atRestage = await refusal(projectId);
console.log(`     prepareSubmission @ ready_to_resubmit: ${atRestage.status} ${JSON.stringify(atRestage.details)}`);

check("staging from 'ready_to_resubmit' is refused by the same gates, never waved through", () => {
  assert.equal(atRestage.status, 409, "a corrected project is not staged just because its correction closed");
  assert.equal(atRestage.message, atQcFailed.message, "same refusal, word for word");
  assert.deepEqual(
    withoutHistorical(atRestage.details),
    withoutHistorical(atQcFailed.details),
    "QC, human review and the reviewer gate must read exactly as they did from a pre-stage status",
  );
  // The learned-historical counter carries forward from the record-time learning above and
  // must not relax when the correction closes — a resolved correction does not un-teach the
  // failure it came from.
  assert.deepEqual(
    atRestage.details.historicalMissing,
    atTriaged.details.historicalMissing,
    "the learned-historical gate must never relax when a correction closes",
  );
});

// ── 2/4: Segment A from 'ready_to_resubmit' — re-runs QC, then the same-data A/B ──────
assert.equal(statusOf(projectId), "ready_to_resubmit", "fixture precondition: still at the corrected status");
db.run("DELETE FROM qc_results WHERE project_id = ?", [projectId]);
assert.equal(qcRows(projectId), 0, "fixture precondition: QC verdicts cleared");

const segmentA = await runAutopilotSegmentA(db, projectId);
console.log(`     segment A from ready_to_resubmit: blocked=${segmentA.blocked} blockers=${segmentA.blockers.map((b) => b.code).join(",")} qcRows=${qcRows(projectId)} status=${statusOf(projectId)}`);

check("Segment A entered from 'ready_to_resubmit' re-runs QC and still blocks on it", () => {
  assert.ok(qcRows(projectId) > 0, "the cleared qc_results were repopulated by Segment A's own rerunQc");
  assert.equal(segmentA.blocked, true, "a corrected project is not staged just because its correction closed");
  for (const code of ["qc_fail", "pending_review", "reviewer_blocker", "historical_missing"]) {
    assert.ok(
      segmentA.blockers.some((b) => b.code === code),
      `the ${code} gate must still be reported (got: ${[...new Set(segmentA.blockers.map((b) => b.code))].join(",")})`,
    );
  }
});

check("Segment A's rerunQc leaves the corrected project at 'ready_to_resubmit' (QC may not move a Submit-stage status)", () => {
  // It used to relabel it qc_failed — QC's verdict overwrote the lifecycle. The verdict still
  // reaches staging (the qc_fail blocker above came from the rows this very run wrote); only
  // the status column is left to the correction flow that owns it.
  assert.equal(statusOf(projectId), "ready_to_resubmit");
});

// THE SAME-DATA A/B, now with a status move that really happens: the operator override (the
// production door, audited) moves the project to `qc_failed` without touching a gate input.
// Only the status differs between the two calls. (The old version of this check compared the
// refusal "across" a relabel QC no longer performs — both calls ran at qc_failed, so it would
// have passed with any status gate at all.)
const atRestageNow = await refusal(projectId);
setProjectStatusByOperator(db, projectId, "qc_failed", "restage-gate test: same data, different status", "test");
assert.equal(statusOf(projectId), "qc_failed", "fixture precondition: the override moved the status");
const atQcAfter = await refusal(projectId);
check("with the data held still, the refusal is byte-identical across two different statuses", () => {
  assert.notEqual("ready_to_resubmit", statusOf(projectId), "the two calls must really run at different statuses");
  assert.equal(atQcAfter.status, atRestageNow.status);
  assert.equal(atQcAfter.message, atRestageNow.message);
  assert.deepEqual(atQcAfter.details, atRestageNow.details, "every counter — including the learned-historical one — must match");
});

// ── 3: the structural reason — prepareSubmission has no project-status gate ───────────
// A source assertion, deliberately: the checks above can only exercise the FIRST rung a bare
// fixture reaches. This is what says the rest of the ladder cannot branch on status either.
{
  const repoSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "repository.ts"),
    "utf8",
  );
  const start = repoSrc.indexOf("export async function prepareSubmission(");
  assert.ok(start > 0, "prepareSubmission must still be findable in repository.ts");
  const end = repoSrc.indexOf("\nfunction filesFromProject(", start);
  assert.ok(end > start, "prepareSubmission's end must still be findable");
  const body = repoSrc.slice(start, end);
  check("prepareSubmission gates on evidence, never on projects.status", () => {
    // It WRITES the status at its tail (`UPDATE projects SET status = ?`); that is not a gate.
    // What must not exist is a READ of the project's status used to admit or refuse staging —
    // which would be the place a newly reachable status could silently skip the ladder.
    for (const forbidden of ["detail.project.status ===", "project.status ===", "PRE_STAGE_STATUSES", "STATUSES.has("]) {
      assert.ok(!body.includes(forbidden), `prepareSubmission must not gate on \`${forbidden}\``);
    }
    // And the gates it DOES apply are all still there — "no status gate" must never become
    // "no gates".
    // The filed-track guard reads submitted AND submitted_unconfirmed (an automation click the portal
    // did not confirm is still a filing — replayOutcome.test.ts).
    for (const gate of ["assertSubmissionPaid", "status IN ('submitted', 'submitted_unconfirmed')", "failCount", "reviewerBlockers", "missingDocuments", "permitPathUnknown", "needsClient"]) {
      assert.ok(body.includes(gate), `prepareSubmission must still apply the \`${gate}\` gate`);
    }
  });
  // THE ONE STATUS READ, AND IT CAN ONLY SAY NO. An operator's `blocked` hold refuses staging
  // (LNK-5): it is read through operatorHoldReason, which returns null for every status except
  // `blocked`, and prepareSubmission only ever THROWS on a non-null answer. Pinned so the
  // exception cannot quietly grow into an admitting status gate.
  check("the only project-status read in prepareSubmission is the refusal-only operator hold", () => {
    assert.ok(body.includes("operatorHoldReason(db, projectId)"), "prepareSubmission must refuse an operator-blocked project");
    assert.match(body, /const hold = operatorHoldReason\(db, projectId\);\s*if \(hold !== null\) \{\s*throw new HttpError\(409,/,
      "the hold may only throw");
    const hs = repoSrc.indexOf("export function operatorHoldReason(");
    assert.ok(hs > 0, "operatorHoldReason must be findable");
    const helper = repoSrc.slice(hs, repoSrc.indexOf("\n}\n", hs));
    assert.match(helper, /if \(status !== "blocked"\) return null;/, "the helper answers null for every status but blocked");
  });
}

// ── 5: PRE_STAGE_STATUSES is untyped — the auto-resume is the only thing that notices ──
// maybeResumeAutopilot short-circuits on AUTOPILOT_AUTO_START=0 (set above so creating the
// fixture project did not kick a live run). This section is ABOUT that resume, so lift it.
delete process.env.AUTOPILOT_AUTO_START;

const now = new Date().toISOString();
// The seeded run is one an OPERATOR started (payload.origin) — the only kind of chain a
// clearing event may re-drive now that auto-start is opt-in.
const seedBlocked = (pid: string, status: string) => {
  db.run("INSERT INTO projects (id, status, parser_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)", [pid, status, now, now]);
  db.run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority, project_id, created_at, progress, progress_total, retry_count, max_retries, org_id, result)
     VALUES (?, 'autopilot', '{"origin":"operator"}', 'done', 5, ?, ?, 0, 0, 0, 0, 'default', ?)`,
    [`job-${pid}`, pid, now, JSON.stringify({ blocked: true, blockers: [{ code: "missing_document", detail: "x" }] })],
  );
};
const autopilotJobs = (pid: string): number =>
  Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE project_id = ? AND job_type = 'autopilot'", [pid])?.n ?? 0);
// The enqueue happens behind a dynamic import — give the microtask/macrotask chain time.
const flush = () => new Promise((r) => setTimeout(r, 400));

seedBlocked("p-restage", "ready_to_resubmit");
maybeResumeAutopilot(db, "p-restage", "a correction was resolved");
seedBlocked("p-triaged", "correction_triaged");
maybeResumeAutopilot(db, "p-triaged", "a correction was resolved");
await flush();

check("a corrected project at 'ready_to_resubmit' is re-driven by the resolve route's auto-resume", () => {
  assert.equal(autopilotJobs("p-restage"), 2, "PRE_STAGE_STATUSES must contain ready_to_resubmit or the corrected project strands");
});
check("a project still holding an open correction is NOT re-driven (the Set is really consulted)", () => {
  assert.equal(autopilotJobs("p-triaged"), 1, "correction_triaged is not a pre-stage status");
});

// Segment A builds the packet en route, and filled forms land under the cwd-relative
// backend/data/filled/<projectId> (ahjForms FILLED_DIR). Let the resumed run settle, then
// remove every folder this file's projects produced so nothing is left in the repo.
{
  const settleBy = Date.now() + 20_000;
  while (Date.now() < settleBy && Number(db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'autopilot' AND status IN ('pending','running')",
  )?.n ?? 0) > 0) await new Promise((r) => setTimeout(r, 250));
  for (const pid of [projectId, "p-restage", "p-triaged"]) {
    try { fs.rmSync(path.resolve(process.cwd(), "backend/data/filled", pid), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
try { db.close(); } catch { /* the instant-kicked worker may still hold the handle */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* leave to the OS */ }

if (failures) {
  console.error(`\ncorrectionRestageGate: ${failures} check(s) FAILED (${passed} passed).`);
  process.exit(1);
}
console.log(`\ncorrectionRestageGate: all ${passed} checks passed`);
// Hard exit: the resumed p-restage job may have instant-kicked the in-process worker.
process.exit(0);
