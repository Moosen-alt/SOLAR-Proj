import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PortalRecipe, ProjectRecord, ReviewerReport } from "../../shared/src/types";
import { MockPortalAdapter } from "./adapters/mock";
import { OregonEPermittingAdapter } from "./adapters/oregonEPermitting";
import { PowerClerkAdapter } from "./adapters/powerClerk";
import { RecipeAdapter } from "./adapters/recipeAdapter";
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

interface StageOptions {
  encryptedStorageStatePath?: string;
  headless?: boolean;
  reviewerReport?: ReviewerReport;
  // Decrypted credential for auto-filling expired sessions.
  // Resolved server-side from the encrypted portal_credentials store;
  // passed in-memory only and never logged.
  credential?: { username: string; password: string };
  // Per-client browser profile directory (profiles/{clientId}/{portalType}).
  userDataDir?: string;
}

// Generic adapter runner: decrypts the session into a temp file, drives the
// adapter through login → open → fill → upload → stopAtReview, and always
// cleans up the plaintext session file. Never clicks final submit.
async function runAdapter(
  adapter: import("./adapter").PortalAdapter,
  project: ProjectRecord,
  files: string[],
  options: StageOptions
): Promise<Record<string, unknown>> {
  let tmpStatePath: string | undefined;
  try {
    tmpStatePath = resolveStorageStatePath(options.encryptedStorageStatePath);

    const loginResult = await adapter.login({
      storageStatePath: tmpStatePath,
      headless: options.headless ?? false,
      credential: options.credential,
      userDataDir: options.userDataDir,
    });
    if (!loginResult.ok) return { portalName: adapter.portalName, finalSubmitClickedByAutomation: false, pauseReason: loginResult.pauseReason ?? null, steps: [loginResult] };

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
    if (tmpStatePath && fs.existsSync(tmpStatePath)) {
      fs.unlinkSync(tmpStatePath);
    }
  }
}

export async function stageWithAccela(project: ProjectRecord, files: string[], options: StageOptions = {}): Promise<Record<string, unknown>> {
  return runAdapter(new OregonEPermittingAdapter(), project, files, options);
}

export async function stageWithPowerClerk(project: ProjectRecord, files: string[], options: StageOptions = {}): Promise<Record<string, unknown>> {
  return runAdapter(new PowerClerkAdapter(), project, files, options);
}

// Replay an admin-recorded recipe for an AHJ/utility portal the bot wasn't hand-coded
// for. fieldValues + docsByType are resolved server-side (project + client overlay +
// split docs). Same runner, same guardrail — stops at review, never submits.
export async function stageWithRecipe(
  recipe: PortalRecipe,
  project: ProjectRecord,
  fieldValues: Record<string, string>,
  docsByType: Record<string, string>,
  files: string[],
  options: StageOptions = {},
): Promise<Record<string, unknown>> {
  return runAdapter(new RecipeAdapter(recipe, fieldValues, docsByType), project, files, options);
}

// Read-only portal status scrape. Opens a browser session for the given adapter type,
// calls checkStatus(), and returns the raw status text (or null on failure/not supported).
// SAFETY: only calls login() + checkStatus() — never fill, click-submit, or pay.
export async function checkStatusWithAdapter(
  adapterType: "accela" | "powerclerk" | "recipe",
  applicationNumbers: string[],
  options: StageOptions & { recipe?: PortalRecipe; fieldValues?: Record<string, string>; docsByType?: Record<string, string> },
): Promise<string | null> {
  let tmpStatePath: string | undefined;
  try {
    tmpStatePath = resolveStorageStatePath(options.encryptedStorageStatePath);
    const ctx = { storageStatePath: tmpStatePath, headless: options.headless ?? true, credential: options.credential, userDataDir: options.userDataDir };

    const adapter =
      adapterType === "accela" ? new OregonEPermittingAdapter() :
      adapterType === "powerclerk" ? new PowerClerkAdapter() :
      options.recipe ? new RecipeAdapter(options.recipe, options.fieldValues ?? {}, options.docsByType ?? {}) :
      null;

    if (!adapter || !adapter.checkStatus) return null;

    const loginResult = await adapter.login(ctx);
    if (!loginResult.ok) return null;

    return await adapter.checkStatus(applicationNumbers);
  } catch {
    return null;
  } finally {
    if (tmpStatePath && fs.existsSync(tmpStatePath)) fs.unlinkSync(tmpStatePath);
  }
}
