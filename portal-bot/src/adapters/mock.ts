import type { ProjectRecord, ReviewerReport } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";

function result(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: true, message, data };
}

export class MockPortalAdapter extends BasePortalAdapter {
  portalName = "Mock Portal Adapter";

  async login(context: PortalContext): Promise<PortalStepResult> {
    return result("Mock login verified. No credentials or session secrets were used.", {
      portalProfileId: context.portalProfileId ?? null,
    });
  }

  async openSubmission(project: ProjectRecord): Promise<PortalStepResult> {
    // PII redaction: do not echo the project street address back into the result.
    return result("Mock new application flow opened.", {
      projectId: project.id,
    });
  }

  async fillApplication(project: ProjectRecord): Promise<PortalStepResult> {
    // PII redaction: drop homeownerName; keep only non-identifying system facts.
    return result("Mock portal fields filled from project JSON.", {
      utility: project.utility,
      ahj: project.ahj,
      dcKw: project.systemSizeDcKw,
      acKw: project.systemSizeAcKw,
    });
  }

  async uploadFiles(project: ProjectRecord, files: string[]): Promise<PortalStepResult> {
    return result("Mock file upload staged.", {
      projectId: project.id,
      fileCount: files.length,
    });
  }

  async stopAtReview(project: ProjectRecord, reviewerReport?: ReviewerReport): Promise<PortalStepResult> {
    return result(HUMAN_REVIEW_MESSAGE, {
      projectId: project.id,
      ahjPreviewVisibleRequired: reviewerReport?.finalSubmitGate.mustShowAhjPreviewWindow ?? true,
      finalSubmitButtonAloneIsEnough: reviewerReport?.finalSubmitGate.finalSubmitButtonAloneIsEnough ?? false,
      internalFinalReviewPacketRequired: true,
      finalReviewPacketUrl: `/api/projects/${project.id}/reviewer-report?format=html`,
      nextHumanAction: "Review portal fields, solve any MFA/CAPTCHA manually, pay fees manually, and click submit manually.",
    });
  }

  async captureSubmissionConfirmation(): Promise<PortalStepResult> {
    return result("Confirmation capture is a manual app action after the human submits.");
  }

  // Mock opens no browser — close() is a no-op (BasePortalAdapter default handles it).
}
