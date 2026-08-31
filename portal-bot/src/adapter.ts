import type { ProjectRecord, ReviewerReport } from "../../shared/src/types";

export interface PortalContext {
  portalProfileId?: string | null;
  storageStatePath?: string;
  // Persistent browser profile directory — the most reliable session mode.
  // The bot reuses this directory across runs so logins persist exactly like
  // a normal Chrome profile. Create it once with `npm run portal:login`.
  userDataDir?: string;
  headless?: boolean;
  // Decrypted credential for auto-filling the login form when the persistent
  // session has expired. Passed in-memory only; never logged or persisted.
  credential?: { username: string; password: string };
  // Portal entry URL to navigate to after opening (used by the auto-learn adapter so
  // the learn loop starts on the actual application page).
  startUrl?: string;
}

export interface PortalStepResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
  // Set when the run must pause for human action (e.g. "mfa_captcha").
  // Propagated to the portal_runs record so the UI can show a specific banner.
  pauseReason?: string;
}

// Shared PortalStepResult constructors. Adapters route every step return through these
// instead of redefining identical local ok()/fail() helpers.
export function ok(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: true, message, data };
}

export function fail(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: false, message, data };
}

export interface PortalAdapter {
  portalName: string;
  login(context: PortalContext): Promise<PortalStepResult>;
  openSubmission(project: ProjectRecord): Promise<PortalStepResult>;
  fillApplication(project: ProjectRecord): Promise<PortalStepResult>;
  uploadFiles(project: ProjectRecord, files: string[]): Promise<PortalStepResult>;
  stopAtReview(project: ProjectRecord, reviewerReport?: ReviewerReport): Promise<PortalStepResult>;
  /** Post-approval final submit. Called ONLY after an authorized human has clicked
   *  Approve & Submit. Navigates to the ALREADY-STAGED application's review screen
   *  (never starts a new application) and clicks the allowlisted final-submit control.
   *  MUST never click a fee-payment / pay control. Returns a not-supported result by
   *  default; hand-coded + recipe adapters override it. On success, data should carry
   *  { finalSubmitClicked: true, permitNumber?, confirmationNumber?, recordLink? }. */
  submitFromReview?(project: ProjectRecord): Promise<PortalStepResult>;
  captureSubmissionConfirmation(): Promise<PortalStepResult>;
  /** Read-only status scrape — navigates to the portal's project status page and returns
   *  the raw status text for the given application/permit numbers.
   *  SAFETY: must never click submit, modify, or pay anything.
   *  Returns null if the adapter has no live scrape capability. */
  checkStatus?(applicationNumbers: string[]): Promise<string | null>;
  /** Enable LLM-assisted gap-fill: after the adapter's fixed fills on each page, an LLM
   *  planner fills any REQUIRED field the fixed selectors missed — from real project data
   *  only (never invented). Optional; a no-op for adapters that don't implement it. */
  enableLlmGapFill?(
    planner: import("./adapters/autoLearnAdapter").LearnPlanner,
    projectFields: Record<string, string>,
  ): void;
  /** Close the underlying browser/context and release the per-client userDataDir
   *  lock. MUST be called in a finally for every run/status-check so a second run
   *  for the same client+portal can launch. Always safe to call (idempotent, never
   *  throws); a no-op when nothing was opened. */
  close(): Promise<void>;
}

// Base class: provides a no-op close() default and a protected helper to store
// the opened browser handle so every concrete adapter shares the same teardown.
export abstract class BasePortalAdapter implements PortalAdapter {
  abstract portalName: string;
  abstract login(context: PortalContext): Promise<PortalStepResult>;
  abstract openSubmission(project: ProjectRecord): Promise<PortalStepResult>;
  abstract fillApplication(project: ProjectRecord): Promise<PortalStepResult>;
  abstract uploadFiles(project: ProjectRecord, files: string[]): Promise<PortalStepResult>;
  abstract stopAtReview(project: ProjectRecord, reviewerReport?: ReviewerReport): Promise<PortalStepResult>;
  abstract captureSubmissionConfirmation(): Promise<PortalStepResult>;

  /** Default: this adapter cannot finish the submission autonomously — a human must
   *  click submit in the portal. Hand-coded + recipe adapters override this. */
  async submitFromReview(_project: ProjectRecord): Promise<PortalStepResult> {
    return { ok: false, message: HUMAN_REVIEW_MESSAGE };
  }

  // The handle returned by openPortal(), stored so close() can tear it down.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected opened: any = null;

  // --- LLM-assisted gap-fill (hybrid staging) ------------------------------
  // A planner + the project's secret-free field values, injected by the staging runner.
  // When set, hand-coded adapters call runGapFill() after their fixed fills on each page to
  // fill any required field they missed — from real project data only. Off by default, so
  // nothing changes unless staging enables it.
  protected gapPlanner: import("./adapters/autoLearnAdapter").LearnPlanner | null = null;
  protected gapFields: Record<string, string> = {};
  protected gapFilledLabels: string[] = [];
  /** Accumulated across pages; surfaced in the run result so the operator can see what the
   *  LLM filled and which required fields had no backing data (left blank, not guessed). */
  public gapFillReport: { filled: string[]; skippedUngrounded: string[]; reportedMissing: string[] } = {
    filled: [],
    skippedUngrounded: [],
    reportedMissing: [],
  };

  enableLlmGapFill(
    planner: import("./adapters/autoLearnAdapter").LearnPlanner,
    projectFields: Record<string, string>,
  ): void {
    this.gapPlanner = planner;
    this.gapFields = projectFields ?? {};
  }

  /** Run the LLM gap-fill on the current page (best-effort, never throws). No-op when not
   *  enabled. Accumulates results into gapFillReport. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async runGapFill(page: any): Promise<void> {
    if (!this.gapPlanner) return;
    try {
      const { gapFillCurrentPage } = await import("./llmGapFill");
      const r = await gapFillCurrentPage(page, this.gapPlanner, this.gapFields, this.gapFilledLabels);
      this.gapFilledLabels.push(...r.filled);
      this.gapFillReport.filled.push(...r.filled);
      this.gapFillReport.skippedUngrounded.push(...r.skippedUngrounded);
      this.gapFillReport.reportedMissing.push(...r.reportedMissing);
    } catch {
      // gap-fill is best-effort; never let it break a staging run.
    }
  }

  async close(): Promise<void> {
    const opened = this.opened;
    this.opened = null;
    if (!opened) return;
    const { closePortal } = await import("./browser");
    await closePortal(opened);
  }

  /** Tear the browser down from OUTSIDE the run, to break a run that has hung.
   *  Whatever Playwright call is stuck then rejects and the run unwinds through its normal
   *  error path — which is the only way to end a hang, since the stuck call will never
   *  return on its own. Same teardown as close(), so the profile is released too; safe to
   *  call when nothing is open. */
  async forceClose(): Promise<void> {
    try { await this.close(); } catch { /* the point is to break the hang, not to succeed cleanly */ }
  }
}

export const HUMAN_REVIEW_MESSAGE =
  "Human review required. Verify all fields and click submit manually.";
