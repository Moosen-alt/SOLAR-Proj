// ---------------------------------------------------------------------------
// Autopilot orchestrator — the autonomous pipeline that turns the manual
// "click each stage button" flow into a single hands-off run that stops at
// exactly ONE human-approval gate before the regulatory submission.
//
// The browser cannot be held paused for the hours/days a human approval may
// take, so autonomy is TWO automation segments separated by the existing
// `awaiting_human_submit` state, which IS the gate:
//
//   Segment A (pre-gate, fully automatic):
//     QC -> reviewer-gate -> prepareSubmission(autoSubmit=false). Reuses every
//     existing gate; lands the project in `awaiting_human_submit` with the
//     application staged to the portal review screen. Any gate (HttpError 409)
//     stops the run in `blocked` with the structured blocker payload.
//
//   Human gate:
//     `awaiting_human_submit` + zero reviewer blockers -> the Approve & Submit
//     button (auth-gated, audit-logged — the legal-compliance boundary).
//
//   Segment B (post-approval):
//     Re-open the staged application's review screen and click the allowlisted
//     final submit (never a fee-payment control), then capture confirmation.
//     Adapters that don't implement an autonomous submit fall back to "approved,
//     human completes in portal" — nothing is ever filed without explicit support.
// ---------------------------------------------------------------------------

import { performance } from "node:perf_hooks";
import type { AppDb, SqlParam } from "./db";
import { HttpError } from "./httpError";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
import { nowIso } from "./time";
import { getProjectDetail, rerunQc, captureConfirmation } from "./repository";
import { parseJson } from "./json";
import { buildReviewerReportFor } from "./repository";
import type { ProjectRecord, SubmittalTrackType } from "../../shared/src/types";
import { requiredTracks } from "./submittalTracks";

type Row = Record<string, SqlParam>;

export type AutopilotPhase =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "submitted"
  | "blocked"
  | "paused_for_human"
  | "failed";

export interface AutopilotBlocker {
  code: string;
  detail: string;
}

export interface ReviewMismatch {
  field: string;
  expected: string;
  found: string;
}

export interface AutopilotState {
  projectId: string;
  phase: AutopilotPhase;
  stage: string;
  message: string;
  blockers: AutopilotBlocker[];
  canApprove: boolean;
  pauseReason: string | null;
  portalRunId: string | null;
  updatedAt: string;
  // Review-screen comparison: fields the portal shows vs. the project record.
  reviewMismatches: ReviewMismatch[];
  reviewAccurate: boolean | null;
  // Required portal fields the LLM gap-fill could NOT fill (no backing project data — left
  // blank, never guessed). The operator should add this data to the project and re-stage.
  gapFillMissing: string[];
}

// UNTYPED string Set — it does NOT fail typecheck when a status is removed from the
// ProjectStatus union, so it has to be maintained BY NAME. `intake_uploaded` and
// `submit_staging` were dropped here alongside their removal from the union (2026-09-19);
// leaving them would have been harmless-but-dead, and the next reader would have taken
// them for live vocabulary.
//
// READ BY EXACTLY ONE CALLER: maybeResumeAutopilot (below). It is NOT a staging permission
// list — prepareSubmission has no project-status gate at all (its gates are payment, an
// already-filed submission, QC/human-review/reviewer/historical, document presence, permit
// path and client), and Segment A's execution-time guard is per-TRACK on portal_runs, not on
// project status. So "pre-stage" here means only: a status from which a blocker-clearing
// event may re-drive the automatic run.
//
// `ready_to_resubmit` is a member for that reason. Resolving the last correction on a project
// with NOTHING on file lands there, and it is reached from a route that immediately calls
// maybeResumeAutopilot ("a correction was resolved", server.ts). Leaving it out would strand
// the corrected project exactly the way correction_received/correction_triaged strand one:
// the resume fires, the Set says no, and nothing moves. Being in this Set does not skip a
// single gate — Segment A still re-runs QC first and prepareSubmission still throws every
// 409 it throws from `parsed`.
const PRE_STAGE_STATUSES = new Set([
  "parsed",
  "qc_failed",
  "qc_passed",
  "ready_to_stage",
  "ready_to_resubmit",
]);

// A track counts as STAGED once it has a portal run that reached the portal (awaiting a
// human submit, already submitted, or paused mid-flow for a human). Staging is NOT
// idempotent portal-side — a re-run creates a duplicate live application draft — so this
// is what stops autopilot re-staging work that is already sitting in the portal.
// Pure DB read; exported for tests.
export function trackAlreadyStaged(db: AppDb, projectId: string, track: SubmittalTrackType): boolean {
  const row = db.get<Row>(
    `SELECT id FROM portal_runs
      WHERE project_id = ? AND permit_type = ?
        AND status IN ('awaiting_human_submit', 'submitted', 'paused_for_human')
      LIMIT 1`,
    [projectId, track],
  );
  return Boolean(row);
}

// Which tracks THIS autopilot invocation should stage. An explicit track stages just
// that one; with no track we stage every track the project actually requires (NEM +
// the AHJ's permit structure). Before this, a track-less run made ONE untracked stage:
// the second permit discipline never filed at all, and the run was recorded against
// permit_type 'permit' so it showed on no track.
export function tracksToStage(db: AppDb, project: ProjectRecord, requested?: SubmittalTrackType): SubmittalTrackType[] {
  const wanted = requested ? [requested] : requiredTracks(project);
  return wanted.filter((t) => !trackAlreadyStaged(db, project.id, t));
}

// Reviewer-gate blockers for a project, in the same shape the dashboard already
// renders. Mirrors the check inside prepareSubmission so the gate is consistent.
function reviewerBlockerList(db: AppDb, project: ProjectRecord): AutopilotBlocker[] {
  const report = buildReviewerReportFor(db, project);
  return report.findings
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => ({ code: finding.id, detail: finding.title }));
}

// Translate an HttpError 409 blocker payload from prepareSubmission into the flat
// AutopilotBlocker list the UI shows.
function blockersFromHttpError(err: HttpError): AutopilotBlocker[] {
  const d = (err.details ?? {}) as Record<string, unknown>;
  const out: AutopilotBlocker[] = [];
  if (Number(d.failCount) > 0) out.push({ code: "qc_fail", detail: `${d.failCount} QC failure(s) must be resolved.` });
  if (Number(d.pendingCount) > 0) out.push({ code: "pending_review", detail: `${d.pendingCount} required human-review item(s) pending.` });
  for (const t of (Array.isArray(d.reviewerBlockers) ? d.reviewerBlockers : []) as string[]) out.push({ code: "reviewer_blocker", detail: String(t) });
  for (const t of (Array.isArray(d.historicalMissing) ? d.historicalMissing : []) as string[]) out.push({ code: "historical_missing", detail: String(t) });
  for (const m of (Array.isArray(d.missingDocuments) ? d.missingDocuments : []) as Array<{ label?: string }>) out.push({ code: "missing_document", detail: String(m.label ?? "Required document missing") });
  if (d.permitPathUnknown) out.push({ code: "permit_path", detail: "Confirm the permit path (prescriptive vs engineered)." });
  if (d.needsClient) out.push({ code: "needs_client", detail: "Assign the submitting client whose CCB/license belongs on the filing." });
  if (d.needsCcb) out.push({ code: "needs_ccb", detail: "Submitting client has no CCB license number on file." });
  if (out.length === 0) out.push({ code: "blocked", detail: err.message });
  return out;
}

// The staging outcome the portal_runs row recorded — prepareSubmission RESOLVES (returns
// ProjectDetail) even when the adapter itself failed or paused mid-run, so "no exception"
// must never be reported as "staged to review". The portal_runs row is authoritative.
// Returns null when the run genuinely staged (awaiting_human_submit / submitted).
// Pure + exported so the mapping is unit-tested without a browser or a live stage.
export function segmentAOutcomeFromRun(
  run: { status?: unknown; error_message?: unknown; pause_reason?: unknown } | null | undefined,
): AutopilotBlocker | null {
  const status = run ? String(run.status ?? "") : "";
  if (status === "failed") {
    const detail = String(run?.error_message ?? "").trim()
      || "The portal stage failed before reaching the review screen — see the run's debug bundle.";
    return { code: "stage_failed", detail };
  }
  if (status === "paused_for_human") {
    const why = String(run?.pause_reason ?? "").trim() || "human input required";
    return { code: "paused_for_human", detail: `The portal run paused for a human (${why}). Complete the challenge and resume from the portal panel.` };
  }
  return null;
}

function latestPortalRun(db: AppDb, projectId: string, track?: SubmittalTrackType): Row | null {
  if (track) {
    const scoped = db.get<Row>(
      "SELECT * FROM portal_runs WHERE project_id = ? AND permit_type = ? ORDER BY started_at DESC LIMIT 1",
      [projectId, track],
    );
    if (scoped) return scoped;
  }
  return db.get<Row>("SELECT * FROM portal_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 1", [projectId]);
}

function awaitingPortalRun(db: AppDb, projectId: string, track?: SubmittalTrackType): Row | null {
  const params: SqlParam[] = [projectId];
  let sql = "SELECT * FROM portal_runs WHERE project_id = ? AND status = 'awaiting_human_submit'";
  if (track) { sql += " AND permit_type = ?"; params.push(track); }
  sql += " ORDER BY started_at DESC LIMIT 1";
  return db.get<Row>(sql, params);
}

// Extract review-screen mismatches from a portal_run's result_json. The adapter stores
// reviewMismatches + reviewAccurate in the stopAtReview step's data payload.
function gapMissingFrom(data: Record<string, unknown> | undefined): string[] {
  const gf = data?.gapFill as { reportedMissing?: unknown } | undefined;
  const list = gf && Array.isArray(gf.reportedMissing) ? gf.reportedMissing.map((x) => String(x)) : [];
  return Array.from(new Set(list)).slice(0, 20);
}

function reviewInfoFromRun(run: Row | null): { reviewMismatches: ReviewMismatch[]; reviewAccurate: boolean | null; gapFillMissing: string[] } {
  const empty = { reviewMismatches: [], reviewAccurate: null, gapFillMissing: [] };
  if (!run?.result_json) return empty;
  try {
    const result = JSON.parse(String(run.result_json)) as Record<string, unknown>;
    // result_json shape: { steps: [{ok, data: {reviewMismatches, reviewAccurate, gapFill}}] }
    const steps = Array.isArray(result.steps) ? result.steps as Array<Record<string, unknown>> : [];
    // gapFill and reviewMismatches live on DIFFERENT steps for different adapters:
    // PowerClerk puts both on the review step, the RecipeAdapter reports gapFill on the
    // fill step and never emits reviewMismatches. Collect each wherever it appears so
    // the "required fields left blank" advisory fires for every adapter.
    let reviewMismatches: ReviewMismatch[] = [];
    let reviewAccurate: boolean | null = null;
    const gapMissing = new Set<string>(gapMissingFrom(result));
    for (const step of steps) {
      const data = step.data as Record<string, unknown> | undefined;
      if (!data) continue;
      if (!reviewMismatches.length && Array.isArray(data.reviewMismatches)) {
        reviewMismatches = data.reviewMismatches as ReviewMismatch[];
        reviewAccurate = typeof data.reviewAccurate === "boolean" ? data.reviewAccurate : null;
      }
      for (const f of gapMissingFrom(data)) gapMissing.add(f);
    }
    // Top-level mismatches (some portal results flatten the step data).
    if (!reviewMismatches.length && Array.isArray(result.reviewMismatches)) {
      reviewMismatches = result.reviewMismatches as ReviewMismatch[];
      reviewAccurate = typeof result.reviewAccurate === "boolean" ? result.reviewAccurate : null;
    }
    return { reviewMismatches, reviewAccurate, gapFillMissing: Array.from(gapMissing).slice(0, 20) };
  } catch { /* ignore parse errors */ }
  return empty;
}

// Derive the current autopilot snapshot for the UI from the project status, the
// latest portal run, and the latest autopilot job result. No dedicated table —
// the state machine is a pure function of state we already persist.
export function getAutopilotState(db: AppDb, projectId: string): AutopilotState {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  const ts = project.updatedAt || nowIso();
  const run = latestPortalRun(db, projectId);
  // A pause is only CURRENT while the run itself still sits at paused_for_human AND the
  // project hasn't since moved past it (manual track submit / captureConfirmation update
  // the project, not the run row) — otherwise the panel pins "paused for MFA" forever
  // after the moment has passed, on the strength of a historical pause_reason.
  const projectMovedOn = ["submitted", "ready_for_issue", "issued", "nem_approved", "handoff_ready", "awaiting_human_submit"].includes(project.status);
  const pauseReason = run && String(run.status) === "paused_for_human" && !projectMovedOn
    && typeof run.pause_reason === "string" && run.pause_reason ? String(run.pause_reason) : null;
  const noReview = { reviewMismatches: [] as ReviewMismatch[], reviewAccurate: null as boolean | null, gapFillMissing: [] as string[] };

  // A run that paused mid-fill for MFA/CAPTCHA needs a human at the browser.
  if (pauseReason) {
    return {
      projectId, phase: "paused_for_human", stage: "Portal paused for human",
      message: "Portal run paused for MFA/CAPTCHA. A human must complete the challenge.",
      blockers: [], canApprove: false, pauseReason, portalRunId: run ? String(run.id) : null, updatedAt: ts,
      ...noReview,
    };
  }

  if (project.status === "submitted" || project.status === "ready_for_issue" || project.status === "issued" || project.status === "nem_approved" || project.status === "handoff_ready") {
    return { projectId, phase: "submitted", stage: "Submitted", message: "Filing submitted; tracking approval.", blockers: [], canApprove: false, pauseReason: null, portalRunId: run ? String(run.id) : null, updatedAt: ts, ...noReview };
  }

  if (project.status === "awaiting_human_submit") {
    const blockers = reviewerBlockerList(db, project);
    const reviewInfo = reviewInfoFromRun(run);
    // If the gap-fill left required portal fields blank (no project data to fill them from),
    // advise the operator to add the data and re-stage rather than submit an incomplete app.
    const gapAdvisory = reviewInfo.gapFillMissing.length
      ? ` ${reviewInfo.gapFillMissing.length} required portal field(s) had no project data and were left blank — add them to the project and re-stage before submitting: ${reviewInfo.gapFillMissing.join(", ")}.`
      : "";
    const baseMsg = blockers.length
      ? "Staged, but reviewer blockers must be cleared before approval."
      : "Staged to portal review. Click Approve & Submit to file.";
    return {
      projectId, phase: "awaiting_approval", stage: "Awaiting approval",
      message: baseMsg + gapAdvisory,
      blockers, canApprove: blockers.length === 0, pauseReason: null, portalRunId: run ? String(run.id) : null, updatedAt: ts,
      ...reviewInfo,
    };
  }

  // A finished autopilot job that ended blocked carries the blocker payload.
  const job = db.get<Row>(
    "SELECT * FROM job_queue WHERE project_id = ? AND job_type = 'autopilot' ORDER BY created_at DESC LIMIT 1",
    [projectId],
  );
  if (job) {
    const status = String(job.status);
    if (status === "pending" || status === "running") {
      return { projectId, phase: "running", stage: "Autopilot running", message: "Running QC → build → reviewer gate → stage.", blockers: [], canApprove: false, pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview };
    }
    // Guard the parse: a corrupt/truncated job_queue.result must not 500 the autopilot panel.
    const result = parseJson<{ blocked?: boolean; blockers?: AutopilotBlocker[]; message?: string } | null>(job.result == null ? null : String(job.result), null);
    if (result?.blocked) {
      return { projectId, phase: "blocked", stage: "Blocked", message: result.message ?? "Autopilot stopped on a gate.", blockers: result.blockers ?? [], canApprove: false, pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview };
    }
    if (status === "failed") {
      return { projectId, phase: "failed", stage: "Failed", message: job.error ? String(job.error) : "Autopilot run failed.", blockers: [], canApprove: false, pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview };
    }
  }

  return { projectId, phase: "idle", stage: "Idle", message: "Autopilot has not been started for this project.", blockers: [], canApprove: false, pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview };
}

// AUTO-RESUME — called (fire-and-forget) from every route that can CLEAR a
// blocker: human-review verify, document upload, payment mark-paid/waive,
// client assignment, correction apply/resolve, and intake submission. If the
// latest autopilot run ended blocked and the project is still pre-stage, a
// fresh Segment A is enqueued so the project re-drives itself to the gate the
// moment the blocker is fixed. Premature resumes are harmless — Segment A
// re-evaluates every gate and simply re-blocks. It can NEVER cross the human
// approval gate: awaiting_human_submit is not in PRE_STAGE_STATUSES, and
// approval still requires the explicit POST /autopilot/approve.
export function maybeResumeAutopilot(db: AppDb, projectId: string, trigger = "a blocker-clearing change"): void {
  try {
    if (process.env.AUTOPILOT_AUTO_START === "0") return;
    const project = db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId]);
    if (!project || !PRE_STAGE_STATUSES.has(String(project.status))) return;
    const job = db.get<Row>(
      "SELECT status, result, payload FROM job_queue WHERE project_id = ? AND job_type = 'autopilot' ORDER BY created_at DESC LIMIT 1",
      [projectId],
    );
    if (!job) return; // never started — nothing to resume
    const status = String(job.status);
    if (status === "pending" || status === "running") return; // already in flight
    // Resume ONLY runs that ended blocked on a gate. A FAILED run is an error —
    // it is escalated to the operator (job_failed SSE + review item) and must
    // not be silently relaunched by an unrelated clearing event (that would let
    // e.g. a public intake link repeatedly trigger live browser runs).
    const result = parseJson<{ blocked?: boolean; blockers?: Array<{ code?: string }> } | null>(job.result == null ? null : String(job.result), null);
    if (!result?.blocked) return;
    // PORTAL-RUN OUTCOMES ARE NOT GATES. Segment A also reports blocked:true when the
    // stage itself failed or paused mid-run (stage_failed / paused_for_human, from the
    // portal_runs row). No clearing event fixes those — relaunching would drive an
    // unattended live browser run (and, on a pause, a SECOND browser while the paused
    // one still sits at its MFA/CAPTCHA challenge). Same no-relaunch invariant as a
    // failed job: the operator resumes explicitly.
    if ((result.blockers ?? []).some((b) => b?.code === "stage_failed" || b?.code === "paused_for_human")) return;
    // Carry the original run's track — a resume of an NEM-track run must not
    // restage the default track.
    const payload = parseJson<{ track?: string } | null>((job as { payload?: unknown }).payload == null ? null : String((job as { payload?: unknown }).payload), null);
    const track = payload?.track;
    void import("./jobQueue")
      .then(({ enqueueJob }) => {
        // maxRetries 0: staging drives a live portal and is not idempotent —
        // recovery happens through THIS event-driven resume path, never a timer.
        enqueueJob(db, "autopilot", track ? { track, resumeTrigger: trigger } : { resumeTrigger: trigger }, { projectId, priority: 6, maxRetries: 0 });
        logger.info("autopilot", `auto-resume enqueued (${trigger})`, { project: projectId });
        // SAY WHY IT STARTED. This resume is correct — it only ever relaunches a run the
        // operator started that then blocked on a gate, and it can never cross the approval
        // gate. But it left no trace an operator could read, so the first time it fired the
        // report was "I never clicked the autopilot button", and it took a code read to
        // explain a run that was working as designed. An unexplained autonomous run is
        // indistinguishable from a bug; the audit trail now names the trigger.
        addAuditLog(db, projectId, "system", "autopilot", "autopilot.auto_resumed", {
          trigger,
          because: "an earlier autopilot run stopped on a gate, and this change may have cleared it",
          track: track ?? null,
        });
      })
      .catch(() => null);
  } catch { /* auto-resume is best-effort — never break the clearing action */ }
}

// SEGMENT A — drive the project automatically to the approval gate. Reuses the
// existing stage functions; prepareSubmission enforces every gate and throws
// HttpError 409 with a structured blocker payload, which we surface as `blocked`.
export async function runAutopilotSegmentA(
  db: AppDb,
  projectId: string,
  track?: SubmittalTrackType,
): Promise<{ blocked: boolean; blockers: AutopilotBlocker[]; message: string; state: AutopilotState }> {
  const t0 = performance.now();
  // EXECUTION-TIME GUARD, PER TRACK. A queued autopilot job may be stale by the time it
  // runs, and staging is NOT idempotent portal-side — a re-run creates a duplicate live
  // application draft. This used to be a PROJECT-status check, which also meant that once
  // the first track staged, the project left the pre-stage statuses and every remaining
  // track was refused: a separate-permit AHJ filed its structural permit and never its
  // electrical one. The check is now "has THIS track already reached the portal", which
  // keeps the anti-duplicate guarantee while letting the other tracks run.
  const currentStatus = String(db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId])?.status ?? "");
  const pendingTracks = tracksToStage(db, getProjectDetail(db, projectId).project, track);
  if (pendingTracks.length === 0) {
    const msg = track
      ? `The ${track} track is already staged to the portal, so autopilot will not re-stage it. Use the explicit Stage action if a re-stage is intended.`
      : `Every required track is already staged to the portal (project status '${currentStatus || "unknown"}'), so autopilot has nothing to stage. Use the explicit Stage action if a re-stage is intended.`;
    logger.info("autopilot", "Segment A skipped — nothing left to stage", { project: projectId, status: currentStatus, track: track ?? "all" });
    return { blocked: true, blockers: [{ code: "not_pre_stage", detail: msg }], message: msg, state: getAutopilotState(db, projectId) };
  }
  logger.info("autopilot", "Segment A started — QC → build → reviewer gate → stage", { project: projectId, tracks: pendingTracks.join(", ") });
  // Re-run QC ONCE so the project's gate state is fresh before staging (it is
  // project-wide, not per track).
  rerunQc(db, projectId);
  addAuditLog(db, projectId, "system", "autopilot", "autopilot.segment_a_started", { tracks: pendingTracks });

  // prepareSubmission is imported lazily to avoid a module cycle (repository imports
  // are heavy and this module is imported by the job worker).
  const { prepareSubmission } = await import("./repository");
  // Stage each required track IN SEQUENCE. Sequential, never parallel: each stage drives
  // a live browser on the same per-client persistent profile, and two Chromium instances
  // on one profile directory collide.
  const staged: SubmittalTrackType[] = [];
  const trackBlockers: AutopilotBlocker[] = [];
  for (const t of pendingTracks) {
    try {
      await prepareSubmission(db, projectId, t, /* autoSubmit */ false);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        const blockers = blockersFromHttpError(err).map((b) => ({ ...b, detail: `${t}: ${b.detail}` }));
        addAuditLog(db, projectId, "system", "autopilot", "autopilot.blocked", { track: t, blockers });
        logger.warn("autopilot", "Segment A blocked at a gate", { project: projectId, track: t, ms: `${Math.round(performance.now() - t0)}ms`, blockers: blockers.length, reasons: blockers.map((b) => b.code).slice(0, 5) });
        // A project-wide gate (QC, reviewer, documents) blocks every remaining track
        // too — stop rather than re-running the same refusal per track.
        return { blocked: true, blockers: [...trackBlockers, ...blockers], message: err.message, state: getAutopilotState(db, projectId) };
      }
      // The per-submission payment gate throws 402 (assertSubmissionPaid runs first
      // in prepareSubmission). That's a GATE, not a failure — surface it as blocked
      // with a structured blocker so mark-paid/waive can auto-resume the run.
      if (err instanceof HttpError && err.status === 402) {
        const blockers: AutopilotBlocker[] = [{ code: "payment_required", detail: err.message }];
        addAuditLog(db, projectId, "system", "autopilot", "autopilot.blocked", { track: t, blockers });
        logger.warn("autopilot", "Segment A blocked on the payment gate", { project: projectId, track: t, ms: `${Math.round(performance.now() - t0)}ms` });
        return { blocked: true, blockers: [...trackBlockers, ...blockers], message: err.message, state: getAutopilotState(db, projectId) };
      }
      logger.error("autopilot", "Segment A failed", { project: projectId, track: t, ms: `${Math.round(performance.now() - t0)}ms`, err: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    // prepareSubmission resolved — but that only means the DISPATCH ran to completion.
    // The stage itself may have failed or paused; the portal_runs row it just wrote is
    // the authoritative outcome. Report it honestly instead of logging "complete" for a
    // run that never reached the portal's review screen.
    const stageOutcome = segmentAOutcomeFromRun(latestPortalRun(db, projectId, t));
    if (stageOutcome) {
      // One track failing does not invalidate the others — record it and keep going, so a
      // structural permit that staged is not thrown away because the electrical one broke.
      trackBlockers.push({ ...stageOutcome, detail: `${t}: ${stageOutcome.detail}` });
      addAuditLog(db, projectId, "system", "autopilot", "autopilot.blocked", { track: t, blockers: [stageOutcome] });
      logger.warn("autopilot", "Segment A stage did not complete — the portal run reports it", {
        project: projectId, track: t, ms: `${Math.round(performance.now() - t0)}ms`, code: stageOutcome.code,
      });
      continue;
    }
    staged.push(t);
  }
  if (trackBlockers.length) {
    const msg = staged.length
      ? `Staged ${staged.join(", ")} to portal review. ${trackBlockers.length} track(s) did not: ${trackBlockers.map((b) => b.detail).join("; ")}`
      : trackBlockers.map((b) => b.detail).join("; ");
    return { blocked: true, blockers: trackBlockers, message: msg, state: getAutopilotState(db, projectId) };
  }
  logger.info("autopilot", "Segment A complete — staged to portal review, awaiting human approval", { project: projectId, tracks: staged.join(", "), ms: `${Math.round(performance.now() - t0)}ms` });
  return { blocked: false, blockers: [], message: `Staged ${staged.join(", ")} to portal review; awaiting human approval.`, state: getAutopilotState(db, projectId) };
}

// SEGMENT B — the human-approval action. Authorizes and audit-logs WHO approved
// (a regulatory requirement), then attempts the autonomous final submit. Adapters
// without an autonomous submit leave the project awaiting_human_submit so a human
// finishes in the portal — the approval authorization is recorded either way.
export async function runAutopilotApproval(
  db: AppDb,
  projectId: string,
  options: { approverUserId?: string | null; approverName: string; track?: SubmittalTrackType },
): Promise<AutopilotState> {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  if (project.status !== "awaiting_human_submit") {
    throw new HttpError(409, `Project is not awaiting approval (status: ${project.status}). Only a staged project can be approved.`);
  }
  const blockers = reviewerBlockerList(db, project);
  if (blockers.length > 0) {
    throw new HttpError(409, "Cannot approve: reviewer gate still has blockers.", { blockers });
  }
  const run = awaitingPortalRun(db, projectId, options.track);
  if (!run) {
    throw new HttpError(409, "No staged portal run is awaiting submission for this project/track.");
  }
  const runId = String(run.id);
  const portalProfileId = run.portal_profile_id == null ? null : String(run.portal_profile_id);

  // The regulatory authorization — recorded before any submit attempt, with the
  // approver's identity, so the audit trail shows exactly who authorized the filing.
  addAuditLog(db, projectId, "human", options.approverName, "autopilot.approved", {
    portalRunId: runId, approverUserId: options.approverUserId ?? null, track: options.track ?? "permit",
  });
  logger.info("autopilot", "Segment B — human approval authorized, attempting final submit", { project: projectId, portalRun: runId, approver: options.approverName, track: options.track ?? "permit" });

  // Mock runs submit autonomously so the full approval loop is exercisable in
  // tests/rehearsals. STRICT gate: a run is mock ONLY when the run itself recorded that
  // MockPortalAdapter staged it (result_json.actor, stamped at insert). No inference
  // fallbacks: "no portal profile" describes every universal-path run, and "offline mode
  // at APPROVAL time" says nothing about how the run was STAGED — a real run approved
  // while PORTAL_AUTOSEED=0 must not receive a fabricated MOCK-/CONF- confirmation. A
  // legacy pre-actor mock run simply falls to the approved-manual path (harmless in dev).
  const runResult = parseJson<Record<string, unknown>>(String(run.result_json || "{}"), {});
  const isMockRun = String(runResult.actor ?? "") === "MockPortalAdapter";
  if (isMockRun) {
    const { submitStagedRun } = await import("../../portal-bot/src/index");
    const { MockPortalAdapter } = await import("../../portal-bot/src/adapters/mock");
    const result = await submitStagedRun(new MockPortalAdapter(), project as unknown as ProjectRecord, {});
    if (result.ok === true && result.finalSubmitClicked === true) {
      captureConfirmation(db, runId, {
        permitNumber: String(result.capturedPermitNumber ?? ""),
        confirmationNumber: String(result.capturedConfirmationNumber ?? ""),
        submittedBy: `${options.approverName} (approved autopilot)`,
        notes: "Autopilot final submit after human approval (mock portal — no fee paid).",
      });
      addAuditLog(db, projectId, "portal_bot", "MockPortalAdapter", "autopilot.submitted", {
        portalRunId: runId, finalSubmitClickedByAutomation: true, feePaymentAutomated: false,
      });
      logger.info("autopilot", "Segment B — autonomous final submit captured confirmation (mock portal)", { project: projectId, portalRun: runId });
    } else {
      logger.warn("autopilot", "Segment B — mock submit did not complete", { project: projectId, portalRun: runId, ok: result.ok, finalSubmitClicked: result.finalSubmitClicked });
    }
    return getAutopilotState(db, projectId);
  }

  // Real portal: approval is recorded; a human completes the final submit in the portal
  // until a live-verified autonomous submitFromReview exists for the hand-coded adapter.
  addAuditLog(db, projectId, "human", options.approverName, "autopilot.approved_manual_submit", {
    portalRunId: runId,
    note: "Approval authorized. Adapter has no audited autonomous submit; human completes the final submit in the portal.",
  });
  logger.info("autopilot", "Segment B — approval recorded; real portal has no autonomous submit, human completes final click", { project: projectId, portalRun: runId });
  return getAutopilotState(db, projectId);
}
