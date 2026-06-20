import type { ProjectRecord } from "../../../shared/src/types";
import { HUMAN_REVIEW_MESSAGE, type PortalAdapter, type PortalContext, type PortalStepResult } from "../adapter";

export class OregonEPermittingAdapter implements PortalAdapter {
  portalName = "Oregon ePermitting";

  async login(_context: PortalContext): Promise<PortalStepResult> {
    return { ok: false, message: "Oregon ePermitting adapter is a skeleton. Human-supervised login is not implemented yet." };
  }

  async openSubmission(_project: ProjectRecord): Promise<PortalStepResult> {
    return { ok: false, message: "Oregon ePermitting application navigation is not implemented yet." };
  }

  async fillApplication(_project: ProjectRecord): Promise<PortalStepResult> {
    return { ok: false, message: "Oregon ePermitting field mapping is not implemented yet." };
  }

  async uploadFiles(_project: ProjectRecord, _files: string[]): Promise<PortalStepResult> {
    return { ok: false, message: "Oregon ePermitting upload mapping is not implemented yet." };
  }

  async stopAtReview(_project: ProjectRecord): Promise<PortalStepResult> {
    return {
      ok: true,
      message: HUMAN_REVIEW_MESSAGE,
      data: {
        ahjPreviewVisibleRequired: true,
        finalSubmitButtonAloneIsEnough: false,
        nextHumanAction: "Leave the real Oregon ePermitting final-review page visible so a human can compare fields and uploads before manually submitting.",
      },
    };
  }

  async captureSubmissionConfirmation(): Promise<PortalStepResult> {
    return { ok: false, message: "Oregon ePermitting confirmation capture is not implemented yet." };
  }
}
