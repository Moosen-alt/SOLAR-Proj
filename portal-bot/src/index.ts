import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, ReviewerReport } from "../../shared/src/types";
import { MockPortalAdapter } from "./adapters/mock";
import { OregonEPermittingAdapter } from "./adapters/oregonEPermitting";
import { decryptStorageState } from "./cryptoStorage";

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

// Resolves the encrypted session state file for a portal profile, writes a
// temp plaintext file for Playwright to consume, and returns its path.
// The temp file is deleted after the portal run completes.
function resolveStorageStatePath(encryptedStatePath: string | null | undefined): string | undefined {
  if (!encryptedStatePath || !fs.existsSync(encryptedStatePath)) return undefined;
  const decrypted = decryptStorageState(fs.readFileSync(encryptedStatePath, "utf8"));
  const tmp = path.join(os.tmpdir(), `portal-session-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(decrypted), "utf8");
  return tmp;
}

export async function stageWithAccela(
  project: ProjectRecord,
  files: string[],
  options: {
    encryptedStorageStatePath?: string;
    headless?: boolean;
    reviewerReport?: ReviewerReport;
  } = {}
): Promise<Record<string, unknown>> {
  const adapter = new OregonEPermittingAdapter();
  let tmpStatePath: string | undefined;

  try {
    tmpStatePath = resolveStorageStatePath(options.encryptedStorageStatePath);

    const loginResult = await adapter.login({
      storageStatePath: tmpStatePath,
      headless: options.headless ?? false,
    });
    if (!loginResult.ok) return { portalName: adapter.portalName, finalSubmitClickedByAutomation: false, steps: [loginResult] };

    const openResult = await adapter.openSubmission(project);
    const fillResult = openResult.ok ? await adapter.fillApplication(project) : openResult;
    const uploadResult = fillResult.ok ? await adapter.uploadFiles(project, files) : fillResult;
    const reviewResult = await adapter.stopAtReview(project, options.reviewerReport);

    return {
      portalName: adapter.portalName,
      finalSubmitClickedByAutomation: false,
      internalFinalReviewPacketRequired: true,
      reviewerBlockerCount: options.reviewerReport?.findings.filter((f) => f.severity === "blocker").length ?? 0,
      steps: [loginResult, openResult, fillResult, uploadResult, reviewResult],
    };
  } finally {
    // Always delete the plaintext temp session file
    if (tmpStatePath && fs.existsSync(tmpStatePath)) {
      fs.unlinkSync(tmpStatePath);
    }
  }
}
