import type { ProjectRecord } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";

export class DevelopmentDirectAdapter extends BasePortalAdapter {
  portalName = "Development Direct";

  async login(_context: PortalContext): Promise<PortalStepResult> {
    return { ok: false, message: "Development Direct adapter is a skeleton. Human-supervised login is not implemented yet." };
  }

  async openSubmission(_project: ProjectRecord): Promise<PortalStepResult> {
    return { ok: false, message: "Development Direct new application navigation is not implemented yet." };
  }

  async fillApplication(_project: ProjectRecord): Promise<PortalStepResult> {
    return { ok: false, message: "Development Direct field mapping is not implemented yet." };
  }

  async uploadFiles(_project: ProjectRecord, _files: string[]): Promise<PortalStepResult> {
    return { ok: false, message: "Development Direct upload mapping is not implemented yet." };
  }

  async stopAtReview(_project: ProjectRecord): Promise<PortalStepResult> {
    return {
      ok: true,
      message: HUMAN_REVIEW_MESSAGE,
      data: {
        ahjPreviewVisibleRequired: true,
        finalSubmitButtonAloneIsEnough: false,
        nextHumanAction: "Leave the real portal browser on the final-review/preview page so a human can compare fields and uploads before manually submitting.",
      },
    };
  }

  async captureSubmissionConfirmation(): Promise<PortalStepResult> {
    return { ok: false, message: "Development Direct confirmation capture is not implemented yet." };
  }

  // Skeleton adapter opens no browser — close() is a no-op (base default).
}
