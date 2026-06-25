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

import type { AppDb, SqlParam } from "./db";
import { HttpError } from "./httpError";
import { addAuditLog } from "./audit";
import { nowIso } from "./time";
import { getProjectDetail, rerunQc, captureConfirmation } from "./repository";
import { buildReviewerReport } from "./reviewerEngine";
import type { ProjectRecord, SubmittalTrackType } from "../../shared/src/types";

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

const PRE_STAGE_STATUSES = new Set([
  "intake_uploaded",
  "parsed",
  "qc_failed",
  "qc_passed",
  "ready_to_stage",
  "submit_staging",
]);

// Reviewer-gate blockers for a project, in the same shape the dashboard already
// renders. Mirrors the check inside prepareSubmission so the gate is consistent.
function reviewerBlockerList(project: ProjectRecord): AutopilotBlocker[] {
  const report = buildReviewerReport(project);
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
    for (const step of steps) {
      const data = step.data as Record<string, unknown> | undefined;
      if (data && Array.isArray(data.reviewMismatches)) {
        return {
          reviewMismatches: data.reviewMismatches as ReviewMismatch[],
          reviewAccurate: typeof data.reviewAccurate === "boolean" ? data.reviewAccurate : null,
          gapFillMissing: gapMissingFrom(data),
        };
      }
    }
    // Also check top-level (some portal results flatten the step data).
    if (Array.isArray(result.reviewMismatches)) {
      return {
        reviewMismatches: result.reviewMismatches as ReviewMismatch[],
        reviewAccurate: typeof result.reviewAccurate === "boolean" ? result.reviewAccurate : null,
        gapFillMissing: gapMissingFrom(result),
      };
    }
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
  const pauseReason = run && typeof run.pause_reason === "string" && run.pause_reason ? String(run.pause_reason) : null;
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
    const blockers = reviewerBlockerList(project);
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
    const result = job.result ? (JSON.parse(String(job.result)) as { blocked?: boolean; blockers?: AutopilotBlocker[]; message?: string }) : null;
    if (result?.blocked) {
      return { projectId, phase: "blocked", stage: "Blocked", message: result.message ?? "Autopilot stopped on a gate.", blockers: result.blockers ?? [], canApprove: false, pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview };
    }
    if (status === "failed") {
      return { projectId, phase: "failed", stage: "Failed", message: job.error ? String(job.error) : "Autopilot run failed.", blockers: [], canApprove: false, pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview };
    }
  }

  return { projectId, phase: "idle", stage: "Idle", message: "Autopilot has not been started for this project.", blockers: [], canApprove: false, pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview };
}

// SEGMENT A — drive the project automatically to the approval gate. Reuses the
// existing stage functions; prepareSubmission enforces every gate and throws
// HttpError 409 with a structured blocker payload, which we surface as `blocked`.
export async function runAutopilotSegmentA(
  db: AppDb,
  projectId: string,
  track?: SubmittalTrackType,
): Promise<{ blocked: boolean; blockers: AutopilotBlocker[]; message: string; state: AutopilotState }> {
  // Re-run QC so the project's gate state is fresh before staging.
  rerunQc(db, projectId);
  addAuditLog(db, projectId, "system", "autopilot", "autopilot.segment_a_started", { track: track ?? "all" });

  // prepareSubmission is imported lazily to avoid a module cycle (repository imports
  // are heavy and this module is imported by the job worker).
  const { prepareSubmission } = await import("./repository");
  try {
    await prepareSubmission(db, projectId, track, /* autoSubmit */ false);
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      const blockers = blockersFromHttpError(err);
      addAuditLog(db, projectId, "system", "autopilot", "autopilot.blocked", { blockers });
      return { blocked: true, blockers, message: err.message, state: getAutopilotState(db, projectId) };
    }
    throw err;
  }
  return { blocked: false, blockers: [], message: "Staged to portal review; awaiting human approval.", state: getAutopilotState(db, projectId) };
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
  const blockers = reviewerBlockerList(project);
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

  // Mock runs (no real portal profile) submit autonomously so the full approval loop
  // is exercisable in tests/rehearsals. Real hand-coded portals do not yet implement
  // an audited autonomous submitFromReview — for those the approval is recorded and a
  // human completes the click in the portal (the safe default).
  const isMockRun = portalProfileId == null;
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
    }
    return getAutopilotState(db, projectId);
  }

  // Real portal: approval is recorded; a human completes the final submit in the portal
  // until a live-verified autonomous submitFromReview exists for the hand-coded adapter.
  addAuditLog(db, projectId, "human", options.approverName, "autopilot.approved_manual_submit", {
    portalRunId: runId,
    note: "Approval authorized. Adapter has no audited autonomous submit; human completes the final submit in the portal.",
  });
  return getAutopilotState(db, projectId);
}
