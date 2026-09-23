import type { ProjectStatus } from "../../shared/src/types";

// ---------------------------------------------------------------------------
// Project stage model — the SINGLE SOURCE OF TRUTH for the pipeline UI.
//
// Maps each of the canonical ProjectStatus values to one of FIVE ordered,
// linear stages. The dashboard renders these as a vertical stepper: completed
// stages collapse with a check, the current stage is open, future stages are
// locked. The frontend is plain static JS (no shared-TS import), so the stage
// is computed here and shipped on the list/detail JSON payloads.
//
// WHY FIVE AND NOT SIX (operator ruling, 2026-09-19): there used to be a
// leading "Intake" stage, and it was permanently complete the instant a project
// existed. Upload and parse happen together in the parser, so a project is BORN
// `parsed` — nothing ever sat in Intake, and its only status (`intake_uploaded`)
// had zero writers. A stage that is always already done is not a step in a
// pipeline; it is a decoration that makes the remaining work look shorter than
// it is. Intake was REMOVED rather than left empty, and QC / Verify — the first
// real gate — became stage 0.
//
// Stage numbers align to the operator-facing action-button numbers already in
// the dashboard ("Run QC", "Build Docs", "Reviewer Gate", "Prepare Submittal")
// so the existing mental model is preserved, shifted down one.
// ---------------------------------------------------------------------------

export interface ProjectStage {
  key: string;
  index: number;
  label: string;
}

export const PROJECT_STAGES: readonly ProjectStage[] = [
  { key: "qc", index: 0, label: "QC / Verify" }, //         1 · Run QC
  { key: "build", index: 1, label: "Build & Validate" }, // 2 · Build Docs + 3 · Reviewer Gate
  { key: "submit", index: 2, label: "Submit" }, //          4 · Prepare Submittal (+ corrections/resubmit loop)
  { key: "track", index: 3, label: "Track Approvals" }, //  5 · Permit + NEM tracking
  { key: "closeout", index: 4, label: "Closeout" }, //      Done
] as const;

export const STAGE_COUNT = PROJECT_STAGES.length;

// Status → stage key. Follows the dashboard's "what to do NOW" semantics: the
// active stage is the work remaining, so a status that means "step N is done"
// maps to step N+1. A correction pulls the project BACK to Submit (fix/resubmit).
//
// PARALLEL PERMIT + NEM — no divergence logic needed: the backend only sets
// `handoff_ready` when BOTH the permit is issued AND NEM is approved
// (triggerHandoffIfReady). Every single-track "approved" sub-status (issued,
// nem_approved, …) stays at `track`, so this single field is already the
// conservative "earlier track wins" — nothing reads done prematurely. The Track
// stage shows the two real track positions side-by-side from the process map.
//
// Using a Record<ProjectStatus, …> makes a future status with no mapping a
// COMPILE ERROR — the safety net that keeps this invariant honest.
const STATUS_TO_STAGE: Record<ProjectStatus, string> = {
  // BIRTH STATUS. `parsed` means "the plan set has been read, nothing has been
  // checked yet" — the work remaining is the QC gate, so it maps to stage 0 (the
  // FIRST stage) and not to a completed one. A freshly created project therefore
  // opens on QC / Verify with nothing behind it, which is the literal truth: the
  // parse is an input to the pipeline, not a step the operator completed inside it.
  parsed: "qc",
  qc_failed: "qc",
  qc_passed: "build",
  ready_to_stage: "build",
  awaiting_human_submit: "submit",
  correction_received: "submit",
  correction_triaged: "submit",
  waiting_on_designer: "submit",
  ready_to_resubmit: "submit",
  awaiting_human_resubmit: "submit",
  submitted: "track",
  ready_for_issue: "track",
  issued: "track",
  approved: "track",
  nem_approved: "track",
  handoff_ready: "closeout",
  // `blocked` carries no lifecycle position — it's rendered as a red overlay on
  // the active stage, not its own stage. We fall it back to `qc` (now stage 0,
  // where most blockers are cleared) only so stageForStatus always returns a real
  // stage; the UI reads the separate isBlocked flag to paint the overlay.
  blocked: "qc",
};

const STAGE_BY_KEY: Record<string, ProjectStage> = Object.fromEntries(PROJECT_STAGES.map((s) => [s.key, s]));

export function stageForStatus(status: ProjectStatus): ProjectStage {
  // Both fallbacks are unreachable for a typed caller (the Record above is
  // exhaustive) and exist only for a legacy raw-SQL status read straight off the
  // row. "qc" is the first stage now that Intake is gone — an unrecognised status
  // must land at the START of the pipeline, never partway through it.
  const key = STATUS_TO_STAGE[status] ?? "qc";
  return STAGE_BY_KEY[key] ?? PROJECT_STAGES[0];
}

/**
 * Does this project need a HUMAN before it can move? Drives the red board chip and the
 * stage overlay — a display signal only; nothing gates on it.
 *
 * `blocked` is the explicit form. A correction is the other form of the same fact: an AHJ
 * or utility has stopped the filing and only a person can restart it. That case was
 * invisible — PacifiCorp suspended David Simmons' interconnection (APP-111681) with a
 * ten-business-day withdrawal clock, and because the status was correction_triaged rather
 * than "blocked" the board card showed no chip at all. The most urgent state in the system
 * looked identical to a project ticking along.
 *
 * Deliberately not "any non-terminal status": these two mean an outside party has ALREADY
 * bounced the filing, which is exactly what an operator scanning the board needs to see.
 */
export function isBlockedStatus(status: ProjectStatus): boolean {
  return status === "blocked" || status === "correction_received" || status === "correction_triaged";
}

/**
 * MAY A QC RUN MOVE THIS PROJECT'S STATUS? The one answer runQcForProject asks (qc.ts).
 *
 * QC may JUDGE at any status — its qc_results rows are what every staging gate reads. It may
 * MOVE only a project that is still inside the pipeline's local, pre-stage leg, and never:
 *
 *  - `blocked`: the operator's hold. It has no automatic writer by design (only
 *    setProjectStatusByOperator writes it or lifts it), and QC re-runs from five doors that do
 *    not care where the project is — an edit, a verify, Run QC, the workflow view, Segment A.
 *    A hold erased by a field edit resumed the pipeline with nothing on the audit trail.
 *  - anything at or after the Submit stage (awaiting_human_submit, the correction states,
 *    ready_to_resubmit, submitted … handoff_ready): a filed or filing project rewritten to
 *    qc_passed dropped back to "ready to stage" while its tracks still read filed.
 *
 * "At or after Submit" is the stage model's own answer, not a second status list.
 */
export function qcMayMoveStatus(status: ProjectStatus): boolean {
  if (status === "blocked") return false;
  return stageForStatus(status).index < stageForStatus("awaiting_human_submit").index;
}
