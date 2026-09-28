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

/** What each step of the chain says it is doing while it runs (jobQueue.noteJobProgress → the
 *  project page's progress line). The forms step is the long one: a never-seen AHJ's search took
 *  six minutes on 2026-09-28 while the page read "blocked". */
export const STAGE_STEP_LABELS = {
  split: "Splitting the plan set into its sheets…",
  read_bill: "Reading the utility bill…",
  qc: "Running QC…",
  acquire_forms: "Checking the AHJ's required official forms…",
  build_docs: "Building the AHJ / NEM document package…",
  reviewer_gate: "Running the reviewer gate and the historical check…",
} as const;

export interface StageStepOptions {
  /** Called as each step starts, with its STAGE_STEP_LABELS sentence (the worker writes it to the
   *  job row; a test may collect it). Never awaited; a throw here does not stop the chain. */
  onStep?: (label: string) => void;
}

/**
 * Enqueue the auto chain for a project, deduped: a project with a PENDING stage_step job does
 * not get a second one (re-saving a project three times must not build the packet three times).
 * Called from the parser save/update routes — the two doors a project enters a stage through.
 *
 * PENDING ONLY — NEVER RUNNING (dry run 2026-09-28, B1). Evidence that arrives while a chain is
 * RUNNING must be seen by a chain that starts after it. The parser page creates the project (which
 * enqueues a chain, claimed ~5 ms later by the instant kick) and uploads the plan set a few hundred
 * ms after; the chain had already passed STEP 0 with no plan set on file, and the upload's enqueue
 * was dropped as a duplicate of the RUNNING job — so every project saved from the parser page sat
 * un-split behind "required documents missing" over sheets it already had. Counting 'running'
 * protected nothing: jobQueue's PROJECT_BUSY_SQL already keeps a second stage_step for the same
 * project PENDING until the running one finishes, so two chains never run at once. At most one
 * follow-up waits; later saves and uploads fold into it. It cannot loop: only HTTP routes call
 * this, never the chain's own steps.
 */
export function enqueueStageSteps(db: AppDb, projectId: string): boolean {
  if (!autoStageStepsEnabled()) return false;
  const pending = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'stage_step' AND project_id = ? AND status = 'pending'",
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
export async function processStageStep(db: AppDb, projectId: string, opts: StageStepOptions = {}): Promise<StageStepOutcome> {
  const ran: string[] = [];
  const status = (): string =>
    String(db.get<{ status?: string }>("SELECT status FROM projects WHERE id = ?", [projectId])?.status ?? "");
  const step = (key: keyof typeof STAGE_STEP_LABELS): void => {
    try { opts.onStep?.(STAGE_STEP_LABELS[key]); } catch { /* a progress note never stops the chain */ }
  };

  if (!autoStageStepsEnabled()) return { ran, stoppedAt: status(), reason: "AUTO_STAGE_STEPS is off." };

  // STEP 0 — SPLIT THE PLAN SET, before anything judges documents. The submit gate names the
  // sheets it wants BY TYPE (site plan, SLD, structural, specs), and every one of them usually
  // lives inside the uploaded plan set — Basson sat "Blocked: required documents" over sheets
  // she had already provided, until a human clicked split. Operator ruling (2026-09-21): "have
  // it auto split everything… once it splits its good, just have it auto do it then check
  // again." Deduped on recency: split rows newer than the newest plan set mean this plan set
  // is already split; a NEWLY uploaded plan set re-splits. Pure-local (pdf-lib page routing,
  // no browser, no LLM), and a failure is logged and stepped past — the doc gates downstream
  // still rule honestly on whatever exists.
  const chainOwned = ["parsed", "qc_failed", "qc_passed", "ready_to_stage"].includes(status());
  if (chainOwned) {
    const planSet = db.get<{ uploaded_at: string }>(
      "SELECT uploaded_at FROM project_documents WHERE project_id = ? AND doc_type = 'plan_set' ORDER BY uploaded_at DESC LIMIT 1",
      [projectId],
    );
    const splitNewer = planSet
      ? Number(db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND source = 'split' AND uploaded_at >= ?",
          [projectId, planSet.uploaded_at],
        )?.n ?? 0)
      : 0;
    if (planSet && splitNewer === 0) {
      step("split");
      try {
        const { buildUtilityPackage } = await import("./docSplitter");
        const pkg = await buildUtilityPackage(db, projectId, "all");
        ran.push(`split(${(pkg.parts || []).length})`);
        logger.info("stage-auto", "plan set split automatically", { project: projectId, parts: (pkg.parts || []).length });
      } catch (err) {
        logger.warn("stage-auto", "auto-split failed; document gates rule on what exists", {
          project: projectId, err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // STEP 0.5 — READ THE BILL INSTEAD OF ASKING A PERSON TO READ IT.
  //
  // The account number is the single most common QC blocker (5 of 19 live projects, one per
  // project, ~26 human interruptions per 100 — measured 2026-09-22). QC's own instruction is
  // right and stays right: "Enter the utility account number EXACTLY as printed on the bill —
  // never guess it." The point is that OCR of the bill image is READING it, not guessing it,
  // and the vision extractor that does exactly this already exists and already names these
  // fields (llm.extractProjectFieldsFromImages: "Account number -> accountNumber, Meter number
  // -> meterNumber, Password / SSN -> never fill"). It was only ever reachable from a button
  // in the parser, so when the bill arrived AFTER intake — which is what actually happens,
  // measured at 8 seconds to 17 minutes after the item was filed — nobody re-ran it and a
  // person transcribed the number by hand.
  //
  // Runs BEFORE QC on purpose: values written here are judged by the QC run below, and a
  // passing check auto-resolves the review item (resolvePendingReviewItem). Secrets are
  // untouched — the extractor refuses passwords and SSNs, and nothing here writes over a
  // value that is already present.
  if (chainOwned) {
    step("read_bill");
    try {
      const { fillAccountFieldsFromDocuments } = await import("./billVision");
      const { createLLMProvider } = await import("./llm");
      const filled = await fillAccountFieldsFromDocuments(db, createLLMProvider(), projectId);
      if (filled.length) {
        ran.push(`read_bill(${filled.join("+")})`);
        logger.info("stage-auto", "read utility account fields from the bill image", { project: projectId, fields: filled });
      }
    } catch (err) {
      logger.warn("stage-auto", "bill vision read failed; QC will ask a human as before", {
        project: projectId, err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // STEP 1 — QC, on a fresh parse OR a re-saved qc_failed project. The enqueue only ever
  // happens on a save, and a save means the inputs changed — so re-running QC here is judging
  // new evidence, not spinning on old. If the verdict is still qc_failed, the chain stops
  // right below and waits for the next human repair.
  //
  // AND WHENEVER THE DOCUMENTS CHANGED SINCE QC LAST JUDGED THEM (dry run 2026-09-28, B7). QC's
  // document rows ("Site plan is not attached … Staging will refuse without it") and its
  // bill-on-file wait are verdicts computed FROM the documents, stored as a snapshot. createProject
  // runs QC before any upload lands, and this chain splits the plan set at qc_passed /
  // ready_to_stage — so the rows kept saying "not attached" over sheets the split had just filed,
  // and the gate listed them under a document check that itself passed. A verdict that depends on
  // the documents is re-judged when the documents change (projectDocuments.documentsChangedAt —
  // uploads, splits, removals). QC never promotes past parsed/qc_failed and never demotes a pass.
  // The document-triggered re-judge refreshes the rows but does NOT demote when its only NEW fails
  // are the account / meter number (qc.QcRunOptions.holdStatusOnNewBillOnlyFails — converge
  // 2026-09-28, conservative until the operator rules): a PDF bill uploaded after intake flips those
  // rows to FAIL, and the bill reader reads images only. Any other new FAIL is real news and stops
  // the chain below, exactly as at parse.
  const docsNewerThanQc = async (): Promise<boolean> => {
    const { documentsChangedAt } = await import("./projectDocuments");
    const changed = documentsChangedAt(db, projectId);
    if (!changed) return false;
    const judged = String(db.get<{ t?: string }>("SELECT MAX(created_at) AS t FROM qc_results WHERE project_id = ?", [projectId])?.t ?? "");
    // Same millisecond is not proof QC saw it — re-judging is the safe direction.
    return !judged || changed >= judged;
  };
  const qcOwned = status() === "parsed" || status() === "qc_failed";
  if (qcOwned || (chainOwned && await docsNewerThanQc())) {
    step("qc");
    const { rerunQc } = await import("./repository");
    rerunQc(db, projectId, qcOwned ? {} : { holdStatusOnNewBillOnlyFails: true });
    ran.push("qc");
    logger.info("stage-auto", qcOwned ? "QC ran automatically on parse" : "QC re-judged: the documents changed since it last ran", { project: projectId, verdict: status() });
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
    step("acquire_forms");
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
    step("build_docs");
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
    step("reviewer_gate");
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
