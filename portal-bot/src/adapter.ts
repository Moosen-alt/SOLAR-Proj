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
}

export interface PortalStepResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
  // Set when the run must pause for human action (e.g. "mfa_captcha").
  // Propagated to the portal_runs record so the UI can show a specific banner.
  pauseReason?: string;
}

export interface PortalAdapter {
  portalName: string;
  login(context: PortalContext): Promise<PortalStepResult>;
  openSubmission(project: ProjectRecord): Promise<PortalStepResult>;
  fillApplication(project: ProjectRecord): Promise<PortalStepResult>;
  uploadFiles(project: ProjectRecord, files: string[]): Promise<PortalStepResult>;
  stopAtReview(project: ProjectRecord, reviewerReport?: ReviewerReport): Promise<PortalStepResult>;
  captureSubmissionConfirmation(): Promise<PortalStepResult>;
  /** Read-only status scrape — navigates to the portal's project status page and returns
   *  the raw status text for the given application/permit numbers.
   *  SAFETY: must never click submit, modify, or pay anything.
   *  Returns null if the adapter has no live scrape capability. */
  checkStatus?(applicationNumbers: string[]): Promise<string | null>;
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

  // The handle returned by openPortal(), stored so close() can tear it down.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected opened: any = null;

  async close(): Promise<void> {
    const opened = this.opened;
    this.opened = null;
    if (!opened) return;
    const { closePortal } = await import("./browser");
    await closePortal(opened);
  }
}

export const HUMAN_REVIEW_MESSAGE =
  "Human review required. Verify all fields and click submit manually.";
