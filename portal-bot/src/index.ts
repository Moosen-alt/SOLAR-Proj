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
  try {
    const steps = [
      await adapter.login({ portalProfileId: null }),
      await adapter.openSubmission(project),
      await adapter.fillApplication(project),
      await adapter.uploadFiles(project, files),
      await adapter.stopAtReview(project, reviewerReport),
    ];
    const allOk = steps.every((s) => s.ok);
    return {
      portalName: adapter.portalName,
      // Contract consumed by the backend: ok + finalSubmitClicked.
      ok: allOk,
      finalSubmitClicked: false,
      finalSubmitClickedByAutomation: false,
      ahjPreviewVisibleRequired: reviewerReport?.finalSubmitGate.mustShowAhjPreviewWindow ?? true,
      finalSubmitButtonAloneIsEnough: reviewerReport?.finalSubmitGate.finalSubmitButtonAloneIsEnough ?? false,
      internalFinalReviewPacketRequired: true,
      reviewerBlockerCount: reviewerReport?.findings.filter((finding) => finding.severity === "blocker").length ?? 0,
      steps,
    };
  } finally {
    // Mock opens no browser, but call close() for symmetry / future-proofing.
    await adapter.close();
  }
}

// Tracks every decrypted plaintext session file currently on disk so a crash exit
// handler can shred them even if a finally never runs. Paths only — never contents.
const activeTmpStateFiles = new Set<string>();

// Best-effort shred that unlinks the plaintext file, removes its private parent
// dir, and drops the path from the active set.
function shredTmpStateFile(tmp: string | undefined): void {
  if (!tmp) return;
  activeTmpStateFiles.delete(tmp);
  try {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch {
    // ignore — best effort
  }
  try {
    fs.rmdirSync(path.dirname(tmp));
  } catch {
    // ignore — dir may be shared or already gone
  }
}

// Crash safety (P0-6): on any abrupt exit, unlink every outstanding plaintext
// session file. Registered once. Never logs the (secret) contents.
let exitHandlerRegistered = false;
function registerTmpStateCleanup(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  const cleanupAll = () => {
    for (const tmp of [...activeTmpStateFiles]) shredTmpStateFile(tmp);
  };
  process.once("exit", cleanupAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      cleanupAll();
      // Re-raise default behaviour after cleanup.
      process.exit(130);
    });
  }
  process.once("uncaughtException", (err) => {
    cleanupAll();
    throw err;
  });
}

// Resolves the encrypted session state file for a portal profile, writes a
// PRIVATE temp plaintext file (0700 dir + 0600 file) for Playwright to consume,
// and returns its path. The decrypted contents are NEVER logged. The caller MUST
// shred the file on every exit path (runAdapter does so in finally; a crash handler
// is the backstop).
function resolveStorageStatePath(encryptedStatePath: string | null | undefined): string | undefined {
  if (!encryptedStatePath || !fs.existsSync(encryptedStatePath)) return undefined;
  registerTmpStateCleanup();
  const decrypted = decryptStorageState(fs.readFileSync(encryptedStatePath, "utf8"));
  // mkdtempSync creates a directory with 0700 perms (owner-only), so the filename is
  // unpredictable AND unreadable by other users even before we tighten the file mode.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-session-"));
  const tmp = path.join(dir, "state.json");
  // Owner read/write only (0600). Write via an explicit fd so perms apply atomically.
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(decrypted), "utf8");
  } finally {
    fs.closeSync(fd);
  }
  activeTmpStateFiles.add(tmp);
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
  // Hybrid auto-submit: when true AND the recipe is a trusted, operator-approved
  // portal, the recipe adapter may replay through the final application submit
  // (never fee payment). Default false = guided-manual (stop at review).
  autoSubmit?: boolean;
}

// Generic adapter runner: decrypts the session into a temp file, drives the
// adapter through login → open → fill → upload → stopAtReview, ALWAYS closes the
// browser (releasing the per-client userDataDir lock so the next run can launch),
// and ALWAYS shreds the plaintext session file.
//
// Returns the backend contract { ...details, ok, finalSubmitClicked } where:
//   - ok: false if any step failed, the run errored, or the review screen was not
//         reached; true only when the adapter staged cleanly through review.
//   - finalSubmitClicked: true ONLY when the automation actually clicked an approved
//         (allowlisted) final-submit step in autoSubmit mode AND the portal accepted it.
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
      // Pass headless through so resolveHeadless picks the server-correct default
      // (headless unless PORTAL_HEADLESS=false). A hard `?? false` crashes on a server.
      headless: options.headless,
      credential: options.credential,
      userDataDir: options.userDataDir,
    });
    if (!loginResult.ok) {
      return {
        portalName: adapter.portalName,
        ok: false,
        finalSubmitClicked: false,
        finalSubmitClickedByAutomation: false,
        pauseReason: loginResult.pauseReason ?? null,
        steps: [loginResult],
      };
    }

    const openResult = await adapter.openSubmission(project);
    const fillResult = openResult.ok ? await adapter.fillApplication(project) : openResult;
    const uploadResult = fillResult.ok ? await adapter.uploadFiles(project, files) : fillResult;
    const reviewResult = await adapter.stopAtReview(project, options.reviewerReport);

    const steps = [loginResult, openResult, fillResult, uploadResult, reviewResult];
    // The adapter reports whether it actually clicked the allowlisted final submit.
    // Default false; only the RecipeAdapter sets it true on a clean autoSubmit click.
    const finalSubmitClicked =
      reviewResult.ok && (reviewResult.data?.finalSubmitClicked === true
        || (adapter as { finalSubmitClicked?: boolean }).finalSubmitClicked === true);
    // ok: every step must have succeeded AND the review screen must have been reached.
    const ok = steps.every((s) => s.ok);
    // Surface a permit/record number + record link captured off the completion page
    // after an authorized final submit, so the backend can store them automatically.
    const captured = steps.map((s) => s.data).find((d) => d && (d.permitNumber || d.recordLink));

    return {
      portalName: adapter.portalName,
      ok,
      finalSubmitClicked,
      // Legacy field kept for older consumers; mirrors finalSubmitClicked.
      finalSubmitClickedByAutomation: finalSubmitClicked,
      capturedPermitNumber: captured?.permitNumber || "",
      capturedConfirmationNumber: captured?.confirmationNumber || "",
      capturedRecordLink: captured?.recordLink || "",
      pauseReason: reviewResult.pauseReason ?? null,
      internalFinalReviewPacketRequired: true,
      reviewerBlockerCount: options.reviewerReport?.findings.filter((f) => f.severity === "blocker").length ?? 0,
      steps,
    };
  } catch (err) {
    // Any thrown error → ok:false (never let an exception read as success).
    return {
      portalName: adapter.portalName,
      ok: false,
      finalSubmitClicked: false,
      finalSubmitClickedByAutomation: false,
      pauseReason: null,
      steps: [{ ok: false, message: `Portal run errored: ${err instanceof Error ? err.message : String(err)}` }],
    };
  } finally {
    // P0-1: ALWAYS close the browser/context so the userDataDir lock is released and
    // the second run for the same client+portal can launch.
    await adapter.close();
    shredTmpStateFile(tmpStatePath);
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
  return runAdapter(new RecipeAdapter(recipe, fieldValues, docsByType, { autoSubmit: options.autoSubmit }), project, files, options);
}

// AUTONOMOUS LEARN: drive an unknown portal with an LLM planner, fill the form up to
// the review screen, record a reusable recipe, and STOP. Never clicks final submit/pay.
// ALWAYS closes the browser (releases the userDataDir lock) and shreds the session file.
export async function learnPortal(input: {
  portalName: string;
  portalUrl: string;
  project: ProjectRecord;
  planner: import("./adapters/autoLearnAdapter").LearnPlanner;
  credential?: { username: string; password: string };
  userDataDir?: string;
  encryptedStorageStatePath?: string;
  headless?: boolean;
  maxPages?: number;
  // docType → upload-ready file path (from the doc-splitting tools). Lets the learner
  // attach the right split document at each portal upload control while learning.
  docsByType?: Record<string, string>;
  // "combined" (AHJ/Accela) attaches the full plan-set PDF to every upload control;
  // "split" (utility/PowerClerk) attaches the matching split sheet per control. Default split.
  uploadMode?: "split" | "combined";
}): Promise<import("./adapters/autoLearnAdapter").LearnResult> {
  const { AutoLearnAdapter } = await import("./adapters/autoLearnAdapter");
  const adapter = new AutoLearnAdapter(input.portalName, input.planner, { maxPages: input.maxPages, docsByType: input.docsByType, uploadMode: input.uploadMode });
  let tmpStatePath: string | undefined;
  try {
    tmpStatePath = resolveStorageStatePath(input.encryptedStorageStatePath);
    const loginResult = await adapter.login({
      storageStatePath: tmpStatePath,
      headless: input.headless,
      credential: input.credential,
      userDataDir: input.userDataDir,
      startUrl: input.portalUrl,
    });
    if (!loginResult.ok) {
      return {
        ok: false,
        portalName: input.portalName,
        steps: [],
        reviewScreen: { fields: [], bodyTextSnippet: "" },
        finalSubmitRecorded: false,
        pageCount: 0,
        pauseReason: loginResult.pauseReason ?? null,
        message: loginResult.message,
      };
    }
    return await adapter.learn(
      { storageStatePath: tmpStatePath, headless: input.headless, credential: input.credential, userDataDir: input.userDataDir, startUrl: input.portalUrl },
      input.project,
    );
  } catch (err) {
    return {
      ok: false,
      portalName: input.portalName,
      steps: [],
      reviewScreen: { fields: [], bodyTextSnippet: "" },
      finalSubmitRecorded: false,
      pageCount: 0,
      pauseReason: null,
      message: `Auto-learn errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await adapter.close();
    shredTmpStateFile(tmpStatePath);
  }
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
  let adapter: import("./adapter").PortalAdapter | null = null;
  try {
    tmpStatePath = resolveStorageStatePath(options.encryptedStorageStatePath);
    const ctx = { storageStatePath: tmpStatePath, headless: options.headless ?? true, credential: options.credential, userDataDir: options.userDataDir };

    adapter =
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
    // P0-1: always close the browser (release the userDataDir lock) and shred the
    // plaintext session file, even on the status-check path.
    if (adapter) await adapter.close();
    shredTmpStateFile(tmpStatePath);
  }
}
