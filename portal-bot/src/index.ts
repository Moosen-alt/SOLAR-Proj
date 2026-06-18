import type { ProjectRecord, ReviewerReport } from "../../shared/src/types";
import { MockPortalAdapter } from "./adapters/mock";

export async function stageWithMockPortal(project: ProjectRecord, files: string[] = [], reviewerReport?: ReviewerReport): Promise<Record<string, unknown>> {
  const adapter = new MockPortalAdapter();
  const steps = [
    await adapter.login({ portalProfileId: null }),
    await adapter.openSubmission(project),
    await adapter.fillApplication(project),
    await adapter.uploadFiles(project, files),
    await adapter.stopAtReview(project, reviewerReport),
  ];
  return {
    portalName: adapter.portalName,
    finalSubmitClickedByAutomation: false,
    ahjPreviewVisibleRequired: reviewerReport?.finalSubmitGate.mustShowAhjPreviewWindow ?? true,
    finalSubmitButtonAloneIsEnough: reviewerReport?.finalSubmitGate.finalSubmitButtonAloneIsEnough ?? false,
    internalFinalReviewPacketRequired: true,
    reviewerBlockerCount: reviewerReport?.findings.filter((finding) => finding.severity === "blocker").length ?? 0,
    steps,
  };
}
