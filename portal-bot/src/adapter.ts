import type { ProjectRecord, ReviewerReport } from "../../shared/src/types";

export interface PortalContext {
  portalProfileId?: string | null;
  storageStatePath?: string;
  headless?: boolean;
}

export interface PortalStepResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface PortalAdapter {
  portalName: string;
  login(context: PortalContext): Promise<PortalStepResult>;
  openSubmission(project: ProjectRecord): Promise<PortalStepResult>;
  fillApplication(project: ProjectRecord): Promise<PortalStepResult>;
  uploadFiles(project: ProjectRecord, files: string[]): Promise<PortalStepResult>;
  stopAtReview(project: ProjectRecord, reviewerReport?: ReviewerReport): Promise<PortalStepResult>;
  captureSubmissionConfirmation(): Promise<PortalStepResult>;
}

export const HUMAN_REVIEW_MESSAGE =
  "Human review required. Verify all fields and click submit manually.";
