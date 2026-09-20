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
//   2. THE SAME-DATA A/B. Segment A then re-runs QC, which relabels the project `qc_failed`
//      without touching any gate input, and prepareSubmission is called once more. Now only
//      the STATUS differs between two runs, and the payload must be byte-identical.
//   3. NO STATUS BRANCH EXISTS TO SKIP. prepareSubmission's body is read off disk and asserted
//      to contain no project-status gate — the structural reason checks 1 and 2 hold for every
//      rung of the ladder, not just the first one a bare fixture reaches. Its gates key on
//      payment, a submitted SUBMISSION row, QC/review/reviewer/historical, document presence,
//      permit path and client — never on projects.status.
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
// RECORDED, NOT ASSERTED AS DESIRABLE: runQcForProject writes projects.status unconditionally
// (qc.ts — `nextStatus = failCount > 0 ? "qc_failed" : "qc_passed"`), so Segment A's own
// rerunQc RELABELS the project away from `ready_to_resubmit` the moment it starts. Check 2
// asserts that overwrite so the next reader meets it here instead of on the board. It is not
// new — `parsed` was overwritten the same way — but it does mean `ready_to_resubmit` is what
// the board shows until autopilot next runs, not a status autopilot preserves.
//
// Browser-free. Run: tsx backend/test/correctionRestageGate.test.ts
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
const { createProject, addManualCorrection, resolveCorrection, prepareSubmission } = await import("../src/repository");
const { runAutopilotSegmentA, maybeResumeAutopilot } = await import("../src/autopilot");
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

check("RECORDED: Segment A's rerunQc relabels the project away from 'ready_to_resubmit'", () => {
  // Not a wish — the behaviour, written down so B2/B3 and the board do not meet it by
  // surprise. runQcForProject writes status unconditionally; `parsed` was overwritten the
  // same way, so this is pre-existing, not something B1 introduced.
  assert.equal(statusOf(projectId), "qc_failed", "QC's own verdict wins once autopilot runs");
});

// Same project, same gate inputs, ONLY the status has moved (ready_to_resubmit → qc_failed).
const atQcAfter = await refusal(projectId);
check("with the data held still, the refusal is byte-identical across the two statuses", () => {
  assert.equal(atQcAfter.status, atRestage.status);
  assert.equal(atQcAfter.message, atRestage.message);
  assert.deepEqual(atQcAfter.details, atRestage.details, "every counter — including the learned-historical one — must match");
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
    for (const gate of ["assertSubmissionPaid", "status = 'submitted'", "failCount", "reviewerBlockers", "missingDocuments", "permitPathUnknown", "needsClient"]) {
      assert.ok(body.includes(gate), `prepareSubmission must still apply the \`${gate}\` gate`);
    }
  });
}

// ── 5: PRE_STAGE_STATUSES is untyped — the auto-resume is the only thing that notices ──
// maybeResumeAutopilot short-circuits on AUTOPILOT_AUTO_START=0 (set above so creating the
// fixture project did not kick a live run). This section is ABOUT that resume, so lift it.
delete process.env.AUTOPILOT_AUTO_START;

const now = new Date().toISOString();
const seedBlocked = (pid: string, status: string) => {
  db.run("INSERT INTO projects (id, status, parser_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)", [pid, status, now, now]);
  db.run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority, project_id, created_at, progress, progress_total, retry_count, max_retries, org_id, result)
     VALUES (?, 'autopilot', '{}', 'done', 5, ?, ?, 0, 0, 0, 0, 'default', ?)`,
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

try { db.close(); } catch { /* the instant-kicked worker may still hold the handle */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* leave to the OS */ }

if (failures) {
  console.error(`\ncorrectionRestageGate: ${failures} check(s) FAILED (${passed} passed).`);
  process.exit(1);
}
console.log(`\ncorrectionRestageGate: all ${passed} checks passed`);
// Hard exit: the resumed p-restage job may have instant-kicked the in-process worker.
process.exit(0);
