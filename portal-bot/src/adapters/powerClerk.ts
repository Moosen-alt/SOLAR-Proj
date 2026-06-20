import type { ProjectRecord } from "../../../shared/src/types";
import { HUMAN_REVIEW_MESSAGE, type PortalAdapter, type PortalContext, type PortalStepResult } from "../adapter";

export class PowerClerkAdapter implements PortalAdapter {
  portalName = "PowerClerk";

  async login(_context: PortalContext): Promise<PortalStepResult> {
    return { ok: false, message: "PowerClerk adapter is a skeleton. Human-supervised login is not implemented yet." };
  }

  async openSubmission(_project: ProjectRecord): Promise<PortalStepResult> {
    return { ok: false, message: "PowerClerk application navigation is not implemented yet." };
  }

  async fillApplication(_project: ProjectRecord): Promise<PortalStepResult> {
    return { ok: false, message: "PowerClerk field mapping is not implemented yet." };
  }

  async uploadFiles(_project: ProjectRecord, _files: string[]): Promise<PortalStepResult> {
    return { ok: false, message: "PowerClerk upload mapping is not implemented yet." };
  }

  async stopAtReview(_project: ProjectRecord): Promise<PortalStepResult> {
    return {
      ok: true,
      message: HUMAN_REVIEW_MESSAGE,
      data: {
        ahjPreviewVisibleRequired: true,
        finalSubmitButtonAloneIsEnough: false,
        nextHumanAction: "Leave the real PowerClerk review page visible so a human can compare fields, attachments, acknowledgements, and fees before manually submitting.",
      },
    };
  }

  async captureSubmissionConfirmation(): Promise<PortalStepResult> {
    return { ok: false, message: "PowerClerk confirmation capture is not implemented yet." };
  }
}
