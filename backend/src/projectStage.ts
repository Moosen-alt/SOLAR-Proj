import type { ProjectStatus } from "../../shared/src/types";

// ---------------------------------------------------------------------------
// Project stage model — the SINGLE SOURCE OF TRUTH for the pipeline UI.
//
// Maps each of the canonical ProjectStatus values to one of six ordered,
// linear stages. The dashboard renders these as a vertical stepper: completed
// stages collapse with a check, the current stage is open, future stages are
// locked. The frontend is plain static JS (no shared-TS import), so the stage
// is computed here and shipped on the list/detail JSON payloads.
//
// Stage numbers align to the operator-facing action-button numbers already in
// the dashboard ("2 · Run QC", "3 · Build Docs", "4 · Reviewer Gate",
// "5 · Prepare Submittal") so the existing mental model is preserved.
// ---------------------------------------------------------------------------

export interface ProjectStage {
  key: string;
  index: number;
  label: string;
}

export const PROJECT_STAGES: readonly ProjectStage[] = [
  { key: "intake", index: 0, label: "Intake" }, //          1 · Parse
  { key: "qc", index: 1, label: "QC / Verify" }, //         2 · Run QC
  { key: "build", index: 2, label: "Build & Validate" }, // 3 · Build Docs + 4 · Reviewer Gate
  { key: "submit", index: 3, label: "Submit" }, //          5 · Prepare Submittal (+ corrections/resubmit loop)
  { key: "track", index: 4, label: "Track Approvals" }, //  6 · Permit + NEM tracking
  { key: "closeout", index: 5, label: "Closeout" }, //      Done
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
  intake_uploaded: "intake",
  parsed: "qc",
  qc_failed: "qc",
  qc_passed: "build",
  ready_to_stage: "build",
  submit_staging: "submit",
  awaiting_human_submit: "submit",
  correction_received: "submit",
  correction_triaged: "submit",
  waiting_on_designer: "submit",
  ready_to_resubmit: "submit",
  resubmit_staging: "submit",
  awaiting_human_resubmit: "submit",
  submitted: "track",
  ready_for_issue: "track",
  issued: "track",
  approved: "track",
  nem_approved: "track",
  handoff_ready: "closeout",
  // `blocked` carries no lifecycle position — it's rendered as a red overlay on
  // the active stage, not its own stage. We fall it back to `qc` (where most
  // blockers are cleared) only so stageForStatus always returns a real stage;
  // the UI reads the separate isBlocked flag to paint the overlay.
  blocked: "qc",
};

const STAGE_BY_KEY: Record<string, ProjectStage> = Object.fromEntries(PROJECT_STAGES.map((s) => [s.key, s]));

export function stageForStatus(status: ProjectStatus): ProjectStage {
  const key = STATUS_TO_STAGE[status] ?? "intake";
  return STAGE_BY_KEY[key] ?? PROJECT_STAGES[0];
}

export function isBlockedStatus(status: ProjectStatus): boolean {
  return status === "blocked";
}
