import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PortalRecipe, ProjectRecord, ReviewerReport } from "../../shared/src/types";
import { MockPortalAdapter } from "./adapters/mock";
import { OregonEPermittingAdapter } from "./adapters/oregonEPermitting";
import { PowerClerkAdapter } from "./adapters/powerClerk";
import { RecipeAdapter } from "./adapters/recipeAdapter";
import pLimit from "p-limit";
import { decryptStorageState } from "./cryptoStorage";
import { resolveHeadless } from "./browser";
import { HUMAN_REVIEW_MESSAGE } from "./adapter";

// One shared cap across EVERY browser-launching path — recipe replay, hand-coded staging, AND the
// auto-learn self-seed. Each Playwright instance is ~200 MB; >2-3 concurrently OOMs/crashes Chromium.
// Previously only the auto-learn path was capped, so concurrent stages (autopilot fan-out) could
// launch unbounded browsers. The learner imports this same limiter so the cap is global, not per-path.
export const browserLimiter = pLimit(Number(process.env.MAX_CONCURRENT_PORTAL_RUNS ?? 2));

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

// POST-APPROVAL final submit (Segment B of the autopilot). Called ONLY after an
// authorized human has clicked Approve & Submit on an already-staged application. Re-opens
// the portal session, navigates back to the staged application's review screen, and asks
// the adapter to click the allowlisted final-submit control (never a fee-payment control).
// Returns the same backend contract as runAdapter so the caller can capture the permit /
// confirmation number. ALWAYS closes the browser and shreds the plaintext session file.
//
// Safety: when the adapter does not implement an autonomous submit (BasePortalAdapter
// default), this returns ok:false with finalSubmitClicked:false — the project stays
// awaiting_human_submit and a human completes the submit in the portal. Nothing is ever
// filed without an adapter that explicitly supports it.
export async function submitStagedRun(
  adapter: import("./adapter").PortalAdapter,
  project: ProjectRecord,
  options: StageOptions = {},
): Promise<Record<string, unknown>> {
  let tmpStatePath: string | undefined;
  // Close any browser left open by a prior guided-manual stage on this profile so the lock
  // is free and this submit re-opens cleanly.
  await closePriorStagingBrowser(options.userDataDir);
  try {
    tmpStatePath = resolveStorageStatePath(options.encryptedStorageStatePath);
    const loginResult = await adapter.login({
      storageStatePath: tmpStatePath,
      headless: options.headless,
      credential: options.credential,
      userDataDir: options.userDataDir,
    });
    if (!loginResult.ok) {
      return { portalName: adapter.portalName, ok: false, finalSubmitClicked: false, pauseReason: loginResult.pauseReason ?? null, steps: [loginResult] };
    }
    // Re-open the existing application and return to its review screen before submitting.
    const openResult = await adapter.openSubmission(project);
    if (!openResult.ok) {
      return { portalName: adapter.portalName, ok: false, finalSubmitClicked: false, pauseReason: openResult.pauseReason ?? null, steps: [loginResult, openResult] };
    }
    const reviewResult = await adapter.stopAtReview(project, options.reviewerReport);
    if (!reviewResult.ok) {
      return { portalName: adapter.portalName, ok: false, finalSubmitClicked: false, pauseReason: reviewResult.pauseReason ?? null, steps: [loginResult, openResult, reviewResult] };
    }
    const submitResult = adapter.submitFromReview
      ? await adapter.submitFromReview(project)
      : { ok: false, message: HUMAN_REVIEW_MESSAGE };
    const finalSubmitClicked = submitResult.ok && submitResult.data?.finalSubmitClicked === true;
    return {
      portalName: adapter.portalName,
      ok: submitResult.ok,
      finalSubmitClicked,
      finalSubmitClickedByAutomation: finalSubmitClicked,
      capturedPermitNumber: String(submitResult.data?.permitNumber ?? ""),
      capturedConfirmationNumber: String(submitResult.data?.confirmationNumber ?? ""),
      capturedRecordLink: String(submitResult.data?.recordLink ?? ""),
      pauseReason: submitResult.pauseReason ?? null,
      steps: [loginResult, openResult, reviewResult, submitResult],
    };
  } catch (err) {
    return {
      portalName: adapter.portalName,
      ok: false,
      finalSubmitClicked: false,
      pauseReason: null,
      steps: [{ ok: false, message: `Post-approval submit errored: ${err instanceof Error ? err.message : String(err)}` }],
    };
  } finally {
    await adapter.close();
    shredTmpStateFile(tmpStatePath);
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
  // Shred plaintext session files if the process is dying on an uncaught exception, but do
  // NOT re-throw: re-throwing inside an uncaughtException listener is a fatal error that
  // terminates the process, which would override the backend's deliberate log-and-stay-alive
  // handler (server.ts process.on("uncaughtException", …)). Cleanup only; let the single
  // owner of crash policy (the backend) decide whether to exit.
  process.once("uncaughtException", () => {
    cleanupAll();
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
  // LLM-assisted gap-fill: an injectable planner + the project's secret-free field values.
  // When both are present, hand-coded adapters fill any required field their fixed selectors
  // missed, from real project data only. Resolved server-side; secrets already stripped.
  gapFillPlanner?: import("./adapters/autoLearnAdapter").LearnPlanner;
  gapFillFields?: Record<string, string>;
}

// Headed, guided-manual staging leaves the browser OPEN at the review screen so the human
// can verify every field and click Submit themselves — closing it (as the old code always
// did) destroyed the very window they were meant to submit in. We track each left-open
// adapter by its per-client userDataDir so the NEXT stage for the same client+portal closes
// the prior window first, releasing the profile lock and preventing orphan browsers.
const openStagingAdapters = new Map<string, import("./adapter").PortalAdapter>();
async function closePriorStagingBrowser(userDataDir: string | undefined): Promise<void> {
  if (!userDataDir) return;
  const prior = openStagingAdapters.get(userDataDir);
  if (!prior) return;
  openStagingAdapters.delete(userDataDir);
  try { await prior.close(); } catch { /* best effort — the human may have closed it already */ }
}

// Close every browser left open for human submit (call on server shutdown).
export async function closeAllStagingBrowsers(): Promise<void> {
  for (const [dir, adapter] of [...openStagingAdapters]) {
    openStagingAdapters.delete(dir);
    try { await adapter.close(); } catch { /* best effort */ }
  }
}

// Generic adapter runner: decrypts the session into a temp file, drives the
// adapter through login → open → fill → upload → stopAtReview, then either CLOSES the
// browser (autosubmit / headless / failed run) or LEAVES IT OPEN at the review screen for
// the human to submit (guided-manual headed run). ALWAYS shreds the plaintext session file.
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
  // A headed, guided-manual run (stop at review, no autosubmit) leaves the browser open for
  // the human to submit. Set once we've staged cleanly to review; checked in finally.
  let leaveBrowserOpen = false;
  // Re-staging the same client+portal? Close the previously left-open window first so the
  // persistent-profile lock is free for this run to launch.
  await closePriorStagingBrowser(options.userDataDir);
  try {
    tmpStatePath = resolveStorageStatePath(options.encryptedStorageStatePath);

    // Enable LLM-assisted gap-fill when the runner provided a planner + project values, so the
    // adapter fills any required field its fixed selectors miss (from real data only).
    if (options.gapFillPlanner && options.gapFillFields && adapter.enableLlmGapFill) {
      adapter.enableLlmGapFill(options.gapFillPlanner, options.gapFillFields);
    }

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

    // Leave the browser OPEN for the human ONLY when: this is a guided-manual run (no
    // autosubmit), it's headed (the human is watching), it staged cleanly to review, and we
    // have a userDataDir to track/close it by later. Otherwise fall through to close().
    leaveBrowserOpen = !options.autoSubmit && options.headless === false && reviewResult.ok && !finalSubmitClicked && !!options.userDataDir;

    return {
      portalName: adapter.portalName,
      ok,
      finalSubmitClicked,
      // Legacy field kept for older consumers; mirrors finalSubmitClicked.
      finalSubmitClickedByAutomation: finalSubmitClicked,
      // True when the staged browser is left open at the review screen for the human to
      // submit (so the UI can say "the portal is open — verify and click Submit").
      browserLeftOpen: leaveBrowserOpen,
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
    // Guided-manual headed run that staged cleanly: KEEP the browser open at the review
    // screen so the human can submit, tracked by userDataDir so the next run closes it.
    // Every other path (autosubmit, headless, failed, errored) closes so the profile lock
    // is released and the next run can launch.
    if (leaveBrowserOpen && options.userDataDir) {
      openStagingAdapters.set(options.userDataDir, adapter);
    } else {
      await adapter.close();
    }
    // The plaintext session file is always shredded — it's already loaded into the open
    // context, so removing it from disk does not affect a left-open browser.
    shredTmpStateFile(tmpStatePath);
  }
}

export async function stageWithAccela(project: ProjectRecord, files: string[], options: StageOptions = {}): Promise<Record<string, unknown>> {
  return browserLimiter(() => runAdapter(new OregonEPermittingAdapter(), project, files, options));
}

export async function stageWithPowerClerk(project: ProjectRecord, files: string[], options: StageOptions = {}): Promise<Record<string, unknown>> {
  return browserLimiter(() => runAdapter(new PowerClerkAdapter(), project, files, options));
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
  return browserLimiter(() => runAdapter(new RecipeAdapter(recipe, fieldValues, docsByType, { autoSubmit: options.autoSubmit }), project, files, options));
}

// AUTONOMOUS LEARN: drive an unknown portal with an LLM planner, fill the form up to
// the review screen, record a reusable recipe, and STOP. Never clicks final submit/pay.
// Leaves a HEADED browser open at the review screen (tracked by userDataDir, released by the next
// stage) when the learn reached review so the human can verify + submit; otherwise closes the
// browser (releases the userDataDir lock). Always shreds the session file.
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
  // Optional live-progress sink so callers can drive a UI progress bar. Non-PII signals only.
  onProgress?: import("./adapters/autoLearnAdapter").LearnProgressFn;
}): Promise<import("./adapters/autoLearnAdapter").LearnResult> {
  const { AutoLearnAdapter } = await import("./adapters/autoLearnAdapter");
  const adapter = new AutoLearnAdapter(input.portalName, input.planner, { maxPages: input.maxPages, docsByType: input.docsByType, uploadMode: input.uploadMode, onProgress: input.onProgress });
  let tmpStatePath: string | undefined;
  let leaveOpen = false;
  // A browser left open by a prior guided-manual stage holds this profile's lock — close it
  // so the recorder can launch.
  await closePriorStagingBrowser(input.userDataDir);
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
      adapter.debug?.finalize({ outcome: "login_failed", ok: false, pauseReason: loginResult.pauseReason ?? null, message: loginResult.message });
      return {
        ok: false,
        portalName: input.portalName,
        steps: [],
        reviewScreen: { fields: [], bodyTextSnippet: "" },
        finalSubmitRecorded: false,
        pageCount: 0,
        pauseReason: loginResult.pauseReason ?? null,
        message: loginResult.message,
        debugDir: adapter.debug?.dir,
      };
    }
    input.onProgress?.({
      phase: "login",
      pageCount: 0,
      maxPages: input.maxPages ?? 18,
      message: "Logged in — opening the application…",
    });
    const learnResult = await adapter.learn(
      { storageStatePath: tmpStatePath, headless: input.headless, credential: input.credential, userDataDir: input.userDataDir, startUrl: input.portalUrl },
      input.project,
    );
    // Leave the headed browser OPEN at the review screen (tracked by userDataDir, released by the
    // next stage's closePriorStagingBrowser) so the human can verify + submit — mirroring the
    // guided-manual replay. Only when the learn actually REACHED review AND we're headed (the human
    // is watching); a headless/server run or a learn that never reached review still closes.
    leaveOpen = learnResult.reachedReview === true && !resolveHeadless(input.headless) && !!input.userDataDir;
    return learnResult;
  } catch (err) {
    // learn() already recorded the error + stack into the bundle and finalized it; make sure
    // the bundle path still reaches the backend so a thrown run is diagnosable.
    adapter.debug?.finalize({ outcome: "error", ok: false, message: err instanceof Error ? err.message : String(err) });
    return {
      ok: false,
      portalName: input.portalName,
      steps: [],
      reviewScreen: { fields: [], bodyTextSnippet: "" },
      finalSubmitRecorded: false,
      pageCount: 0,
      pauseReason: null,
      message: `Auto-learn errored: ${err instanceof Error ? err.message : String(err)}`,
      debugDir: adapter.debug?.dir,
    };
  } finally {
    // Keep a reached-review headed browser open for the human (tracked for cleanup); every other
    // path (login fail, headless/server, error, never-reached-review) closes to release the lock.
    if (leaveOpen && input.userDataDir) {
      openStagingAdapters.set(input.userDataDir, adapter);
    } else {
      await adapter.close();
    }
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
  // Release a left-open guided-manual browser on this profile before opening a status check.
  await closePriorStagingBrowser(options.userDataDir);
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
