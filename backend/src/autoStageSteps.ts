/**
 * THE LOCAL PIPELINE RUNS ITSELF. STAGING STILL WAITS FOR A PERSON.
 *
 * The operator, watching the redesigned project page (2026-09-21): "I'm okay if we wanted to
 * make those auto, for like the build and verify stuff — they just trigger when we get to said
 * stage for us." And, of the Autopilot button: "open portals and fills them out, but nothing
 * else gets built along the way."
 *
 * Both observations are the same gap. The pipeline's LOCAL steps — QC, the AHJ/NEM document
 * package, the reviewer gate, the historical-failure check — were buttons, so a project sat at
 * `parsed` until somebody clicked four times, and Autopilot validated those gates without ever
 * producing their artifacts. This module runs the local steps automatically when a project
 * ENTERS the stage that owns them, through the exact functions the buttons call — no parallel
 * implementations, so the button and the automation cannot disagree about what a step does.
 *
 * WHAT IT WILL NEVER DO: touch a portal. The chain stops cold at `ready_to_stage`. Staging
 * opens a live browser under the operator's own credentials (Start Autopilot / Prepare
 * Submittal), and the final submit is a human's click on the portal itself — hard rule 1
 * twice over. This module contains no import that can reach a browser.
 *
 * Loop shape: one job, sequential steps, each re-reading live status before acting — a queued
 * job can be stale by the time it runs, and a stale job must no-op, not re-run a step on a
 * project that has already moved on (the Round B lesson: the monitor rewrites status under
 * you). `qc_failed` stops the chain — the repair is human (fix the intake, re-save), and the
 * re-save enqueues a fresh chain.
 */
import type { AppDb } from "./db";
import { enqueueJob } from "./jobQueue";
import { logger } from "./logger";

/** Kill switch. Default ON — the operator asked for this; "0"/"false" disables. */
export function autoStageStepsEnabled(): boolean {
  return !/^(0|false|off)$/i.test(String(process.env.AUTO_STAGE_STEPS ?? ""));
}

export interface StageStepOutcome {
  ran: string[];
  stoppedAt: string;
  reason: string;
}

/**
 * Enqueue the auto chain for a project, deduped: a project with a pending stage_step job does
 * not get a second one (re-saving a project three times must not build the packet three times).
 * Called from the parser save/update routes — the two doors a project enters a stage through.
 */
export function enqueueStageSteps(db: AppDb, projectId: string): boolean {
  if (!autoStageStepsEnabled()) return false;
  const pending = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'stage_step' AND project_id = ? AND status IN ('pending','running')",
    [projectId],
  );
  if (Number(pending?.n ?? 0) > 0) return false;
  // Static import is safe here and the SYNCHRONY is load-bearing: jobQueue reaches this module
  // only through the worker's dynamic import, so there is no load-time cycle — and an async
  // enqueue raced its own dedupe check (two saves both counted zero pending jobs, then both
  // inserted; measured in autoStageSteps.test.ts 4c before this was made synchronous).
  enqueueJob(db, "stage_step", { projectId }, { projectId, priority: 4 });
  return true;
}

/**
 * Run every LOCAL step the project's current stage calls for, in order, stopping the moment a
 * step fails to advance. The worker calls this; a test may call it directly.
 */
export async function processStageStep(db: AppDb, projectId: string): Promise<StageStepOutcome> {
  const ran: string[] = [];
  const status = (): string =>
    String(db.get<{ status?: string }>("SELECT status FROM projects WHERE id = ?", [projectId])?.status ?? "");

  if (!autoStageStepsEnabled()) return { ran, stoppedAt: status(), reason: "AUTO_STAGE_STEPS is off." };

  // STEP 1 — QC, on a fresh parse OR a re-saved qc_failed project. The enqueue only ever
  // happens on a save, and a save means the inputs changed — so re-running QC here is judging
  // new evidence, not spinning on old. If the verdict is still qc_failed, the chain stops
  // right below and waits for the next human repair.
  if (status() === "parsed" || status() === "qc_failed") {
    const { rerunQc } = await import("./repository");
    rerunQc(db, projectId);
    ran.push("qc");
    logger.info("stage-auto", "QC ran automatically on parse", { project: projectId, verdict: status() });
  }
  if (status() === "qc_failed") {
    return { ran, stoppedAt: "qc_failed", reason: "QC failed — a person fixes the intake; re-saving restarts the chain." };
  }

  // STEP 2 — the AHJ/NEM document package, WITH form acquisition first. The banner promised
  // "the docs are building automatically" and then a brand-new AHJ (Douglas County, first
  // contact 2026-09-21) sat at qc_passed forever: getApplicationDocumentPackage only ASSEMBLES
  // from templates on file, and acquisition — the cooldown-guarded fetch/research that staging
  // runs in prepareOfficialDocuments — never fired because nobody clicked toward staging. The
  // chain now runs the same acquisition seam, so a new AHJ's first project pulls its forms on
  // the way to ready_to_stage instead of waiting for a human to wonder why nothing built.
  if (status() === "qc_passed") {
    try {
      const { getProjectDetail } = await import("./repository");
      const { prepareOfficialDocuments } = await import("./prepareOfficialDocuments");
      await prepareOfficialDocuments(db, getProjectDetail(db, projectId).project);
      ran.push("acquire_forms");
    } catch (err) {
      // Acquisition failing must not stop the assembly attempt — stored templates may suffice.
      logger.warn("stage-auto", "form acquisition failed; assembling from stored templates", {
        project: projectId, err: err instanceof Error ? err.message : String(err),
      });
    }
    const { getApplicationDocumentPackage } = await import("./repository");
    const { addAuditLog } = await import("./audit");
    const pkg = getApplicationDocumentPackage(db, projectId);
    ran.push(`build_docs(${pkg.docs.length})`);
    logger.info("stage-auto", "AHJ/NEM document package built automatically", {
      project: projectId, docs: pkg.docs.length, missing: (pkg.missingDocuments || []).length,
    });
    // AN EMPTY PACKAGE IS A FACT WORTH RECORDING, not a silent stall. The status honestly
    // stays qc_passed (the builder's narrow edge refuses empty packages, and rightly), but
    // without this row the operator sees a banner promising motion and an audit trail
    // showing none — the unknown reading as reassurance, in stage form.
    if (pkg.docs.length === 0) {
      addAuditLog(db, projectId, "system", "stage autopilot", "stage_auto.docs_unbuildable", {
        reason: "No AHJ forms on file for this jurisdiction and acquisition produced none yet.",
        missingDocuments: (pkg.missingDocuments || []).map((d) => d.docType ?? d),
      });
    }
  }

  // STEP 3 — the verify pair, once, on entering ready_to_stage. The reviewer gate runs WITH
  // vision — the same call the button made — because a gate that skips the expensive half is a
  // gate that approves what it did not look at. Vision verdicts are cached per project, so
  // this spends once, not per render. The historical check is a local read that stores its
  // report. Neither writes projects.status: the reviewer verdict writer (repository) owns
  // stage_detail from here, exactly as it did when a human clicked.
  if (status() === "ready_to_stage") {
    const { getReviewerReportWithVision, getHistoricalFailureReport } = await import("./repository");
    await getReviewerReportWithVision(db, projectId);
    ran.push("reviewer_gate");
    getHistoricalFailureReport(db, projectId);
    ran.push("historical_check");
    logger.info("stage-auto", "reviewer gate + historical check ran automatically", { project: projectId });
    return { ran, stoppedAt: status(), reason: "Local pipeline complete. Staging a portal is a person's action — Start Autopilot when ready." };
  }

  return { ran, stoppedAt: status(), reason: ran.length ? "Chain stopped where the status stopped advancing." : "Nothing to do at this status." };
}
