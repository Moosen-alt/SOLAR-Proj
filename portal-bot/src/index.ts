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
      // Same track-scoped portal URL runAdapter passes — without it a multi-tenant
      // platform adapter (PowerClerk) would fall back to its hardcoded PGE default.
      startUrl: options.loginUrl,
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
  beforeUpload?: (docType: string, file: string) => void;
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
  // OPERATOR-DELEGATED FINAL SUBMIT. Distinct from autoSubmit, which is the RecipeAdapter
  // replaying a TRUSTED recipe through its own recorded submit step. This is the operator
  // saying "file it now, on my behalf" for a HAND-CODED adapter — the equivalent of them
  // clicking Submit in the CRM — and it is honoured only when the caller ALSO sets
  // PORTAL_ALLOW_FINAL_SUBMIT=1, so it can never be reached by a stray request body.
  // Fee payment is untouched by this: the adapter still refuses to pay and pauses instead.
  allowFinalSubmit?: boolean;
  // Who authorised it, for the audit row. Never a body-supplied name when auth is on.
  finalSubmitAuthorizedBy?: string;
  // LLM-assisted gap-fill: an injectable planner + the project's secret-free field values.
  // When both are present, hand-coded adapters fill any required field their fixed selectors
  // missed, from real project data only. Resolved server-side; secrets already stripped.
  gapFillPlanner?: import("./adapters/autoLearnAdapter").LearnPlanner;
  gapFillFields?: Record<string, string>;
  // THE OPERATOR SUBMITTED IN THE OPEN WINDOW — here is what the completion page said.
  // Fires only on a guided-manual run left open at review, when the human clicks the final
  // submit. portal-bot never writes to the database; it reports, and the caller decides
  // whether the read is good enough to record (a wrong record number is worse than none,
  // because permit tracking keys on it forever).
  onSubmitCaptured?: (capture: {
    recordNumber: string;
    confidence: "high" | "low";
    source: string;
    reason: string;
    recordLink: string;
  }) => void;
  // Track-scoped portal login URL (resolved server-side from portal_credentials/recipe/KB).
  // Lets platform adapters that host many tenants (PowerClerk: PGE, PacifiCorp…) land on
  // the right subdomain instead of a hardcoded default.
  loginUrl?: string;
}

// Headed, guided-manual staging leaves the browser OPEN at the review screen so the human
// can verify every field and click Submit themselves — closing it (as the old code always
// did) destroyed the very window they were meant to submit in. We track each left-open
// adapter by its per-client userDataDir so the NEXT stage for the same client+portal closes
// the prior window first, releasing the profile lock and preventing orphan browsers.
const openStagingAdapters = new Map<string, import("./adapter").PortalAdapter>();

// Track a left-open adapter AND watch for the human closing its window by hand — without
// the close listener the Map keeps a dead adapter forever (and the UI can't tell the
// review browser is gone). Best-effort: adapters expose their live Playwright page.
/**
 * Arm the left-open review window so the operator's own submit click is noticed, then read
 * the completion page and report what it said.
 *
 * WHY THIS IS NOT A RULE-1 PROBLEM: the human still clicks submit. Nothing here clicks,
 * pays, or solves a challenge — it watches a page we already own and reads text off it
 * afterwards. The value is that the record number stops being a typing job.
 *
 * WHY IT REPORTS INSTEAD OF WRITING: a wrong record number is worse than none, because
 * every downstream check keys on it. The read carries its own confidence and the caller
 * decides; an unconfident read leaves the operator's manual form exactly as it is today.
 */
async function armSubmitCapture(
  adapter: import("./adapter").PortalAdapter,
  options: StageOptions,
): Promise<void> {
  if (typeof options.onSubmitCaptured !== "function") return;
  try {
    if (typeof adapter.armSubmitWatch !== "function") return;
    await adapter.armSubmitWatch(() => {
      // The click has happened; the portal is now navigating. Read AFTER it settles —
      // reading immediately catches the review screen the operator just left, which is the
      // one page guaranteed not to carry a record number.
      void (async () => {
        try {
          await new Promise((r) => setTimeout(r, 4000));
          const capture = await adapter.captureSubmissionConfirmation();
          const data = (capture.data ?? {}) as Record<string, unknown>;
          const recordNumber = String(data.permitNumber ?? data.confirmationNumber ?? "");
          const read = recordNumber
            ? { confidence: "high" as const, source: "completion_page", reason: capture.message }
            : { confidence: "low" as const, source: "none", reason: capture.message };
          options.onSubmitCaptured?.({
            recordNumber,
            confidence: read.confidence,
            source: read.source,
            reason: read.reason,
            recordLink: String(data.recordLink ?? ""),
          });
        } catch (err) {
          options.onSubmitCaptured?.({
            recordNumber: "", confidence: "low", source: "error",
            reason: `Could not read the completion page: ${err instanceof Error ? err.message : String(err)}`,
            recordLink: "",
          });
        }
      })();
    });
  } catch { /* watching is best-effort — a run must never fail because of it */ }
}

function trackOpenAdapter(userDataDir: string, adapter: import("./adapter").PortalAdapter): void {
  openStagingAdapters.set(userDataDir, adapter);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = (adapter as any).page;
    const ctx = page && typeof page.context === "function" ? page.context() : null;
    if (ctx && typeof ctx.on === "function") {
      ctx.on("close", () => {
        if (openStagingAdapters.get(userDataDir) === adapter) openStagingAdapters.delete(userDataDir);
      });
    }
  } catch { /* tracking only — never fail the run */ }
}
async function closePriorStagingBrowser(userDataDir: string | undefined): Promise<void> {
  if (!userDataDir) return;
  const prior = openStagingAdapters.get(userDataDir);
  if (!prior) return;
  openStagingAdapters.delete(userDataDir);
  try { await prior.close(); } catch { /* best effort — the human may have closed it already */ }
}

// Close the left-open review browsers belonging to ONE track of a client's profile root —
// used when the operator finishes reviewing/patching a recording (recipe "finish"
// endpoint, mark-submitted). Scoped to the track's possible profile subdirs because the
// self-seed learner tracks under <clientId>/utility|AHJ while replay/hand-coded staging
// tracks under <clientId>/<portal_profiles type> — and a client can have BOTH tracks'
// review browsers open at once: marking the NEM track submitted must not destroy the
// permit track's in-progress review session (or vice versa). Safe if already closed.
export async function closeStagingBrowsersForTrack(
  clientRoot: string | undefined,
  scope: "utility" | "ahj",
): Promise<number> {
  if (!clientRoot) return 0;
  // "mock" appears in both lists: it's the portal_profiles fallback dir used only in
  // offline dev, where collateral closing is harmless.
  const subdirs = scope === "utility"
    ? ["utility", "powerclerk_pge", "mock"]
    : ["AHJ", "accela_oregon", "mock"];
  let closed = 0;
  for (const [dir, adapter] of [...openStagingAdapters]) {
    if (!subdirs.some((sub) => dir === path.join(clientRoot, sub) || dir.startsWith(path.join(clientRoot, sub) + path.sep))) continue;
    openStagingAdapters.delete(dir);
    try { await adapter.close(); } catch { /* best effort — the human may have closed it already */ }
    closed++;
  }
  return closed;
}

// Close every left-open browser whose profile dir sits UNDER the given prefix — used with
// a client's profile ROOT (<profileBase>/<clientId>) so "the operator is done reviewing"
// closes that client's review window regardless of which adapter opened it. The self-seed
// learner tracks under <clientId>/utility|AHJ while replay/hand-coded staging tracks under
// <clientId>/<portal_profiles type> ("mock" fallback) — an exact-dir close misses one side.
export async function closeStagingBrowsersUnder(dirPrefix: string | undefined): Promise<number> {
  if (!dirPrefix) return 0;
  let closed = 0;
  for (const [dir, adapter] of [...openStagingAdapters]) {
    if (dir !== dirPrefix && !dir.startsWith(dirPrefix + path.sep)) continue;
    openStagingAdapters.delete(dir);
    try { await adapter.close(); } catch { /* best effort — the human may have closed it already */ }
    closed++;
  }
  return closed;
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
      // Track-scoped portal login URL (portal_credentials / recipe / KB). Lets the
      // PowerClerk adapter land on the RIGHT utility's subdomain (PacifiCorp vs PGE)
      // instead of its hardcoded PGE default.
      startUrl: options.loginUrl,
    });
    if (!loginResult.ok) {
      // SAY IT OUT LOUD. This carried the login failure only inside steps[0], which nothing
      // reads: the replay self-test printed "recipe did not reach review on replay" for
      // every login failure in this project's history, and a caller comparing a replay
      // against a learn had no way to tell "the recipe is wrong" from "we never got in".
      return {
        portalName: adapter.portalName,
        ok: false,
        finalSubmitClicked: false,
        finalSubmitClickedByAutomation: false,
        pauseReason: loginResult.pauseReason ?? null,
        message: `Login failed before the recipe ran: ${String(loginResult.message ?? loginResult.pauseReason ?? "no reason given")}`.slice(0, 300),
        steps: [loginResult],
      };
    }

    const openResult = await adapter.openSubmission(project);
    const fillResult = openResult.ok ? await adapter.fillApplication(project) : openResult;
    const uploadResult = fillResult.ok ? await adapter.uploadFiles(project, files) : fillResult;
    const reviewResult = await adapter.stopAtReview(project, options.reviewerReport);

    // The delegated submit, once the application is staged cleanly at review. Two independent
    // switches must agree — the per-run flag and the environment — because this is the one
    // action in the system that cannot be undone. The adapter's own submitFromReview still
    // owns the safety it always had: it refuses to submit if it is not on the review page,
    // and it PAUSES rather than pay when the portal puts a fee gate before the submit.
    const submitAllowed = options.allowFinalSubmit === true && process.env.PORTAL_ALLOW_FINAL_SUBMIT === "1";
    let submitResult: import("./adapter").PortalStepResult | null = null;
    if (submitAllowed && reviewResult.ok && typeof adapter.submitFromReview === "function") {
      submitResult = await adapter.submitFromReview(project);
    } else if (options.allowFinalSubmit === true && !submitAllowed) {
      submitResult = {
        ok: false,
        message: "Final submit was requested but PORTAL_ALLOW_FINAL_SUBMIT=1 is not set — staged to review only.",
      };
    }

    const steps = [loginResult, openResult, fillResult, uploadResult, reviewResult, ...(submitResult ? [submitResult] : [])];
    // The adapter reports whether it actually clicked the allowlisted final submit.
    // Default false; only the RecipeAdapter sets it true on a clean autoSubmit click.
    const finalSubmitClicked =
      (submitResult?.ok === true && submitResult.data?.finalSubmitClicked !== false)
      || (reviewResult.ok && (reviewResult.data?.finalSubmitClicked === true
        || (adapter as { finalSubmitClicked?: boolean }).finalSubmitClicked === true));
    // ok: every step must have succeeded AND the review screen must have been reached.
    const ok = steps.every((s) => s.ok);
    // Surface a permit/record number + record link captured off the completion page
    // after an authorized final submit, so the backend can store them automatically.
    const captured = steps.map((s) => s.data).find((d) => d && (d.permitNumber || d.recordLink));
    // WHERE THE EVIDENCE OF THIS RUN LIVES. The replay photographs each finished page and,
    // now, the outcome — so an operator can see the completion page and its record number
    // rather than take the run's word for it. Reported here so the submission record can
    // point at the folder, and at the one shot that shows how the filing ended.
    const evidenceDir = steps.map((s) => String(s?.data?.pageShotDir ?? "")).filter(Boolean).pop() ?? "";
    const outcomeShotPath = steps.map((s) => String(s?.data?.outcomeShotPath ?? "")).filter(Boolean).pop() ?? "";

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
      evidenceDir,
      outcomeShotPath,
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
      trackOpenAdapter(options.userDataDir, adapter);
      // WATCH FOR THE OPERATOR'S SUBMIT. This is the window they file in, and the page that
      // comes back after their click carries the record number the whole product keys on —
      // which until now a person read off the screen and typed into a form (~258
      // interruptions per 100 projects, the largest avoidable cost measured). Hard rule 1
      // is untouched: the human clicks, we only read what appears afterwards. A failed or
      // unconfident read changes nothing and the manual form still works exactly as today.
      void armSubmitCapture(adapter, options);
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
  return browserLimiter(() => runAdapter(new RecipeAdapter(recipe, fieldValues, docsByType, { autoSubmit: options.autoSubmit, beforeUpload: options.beforeUpload }), project, files, options));
}

// CORRECTION CONTINUATION: reopen a SUSPENDED filing's correction form on the live portal.
//
// Binds the ORIGINAL application number (from the project's tracking target) and drives
// login → open THAT filing → choose the named correction form (correctionForm.ts — the
// cancellation form beside it is refused by name, ambiguity is refused outright) → stage
// revised documents through the attach-time gate → STOP for operator review. It never
// creates a new application and never clicks any submit/withdraw/cancel control; the
// resubmit confirmation is the human's click in the browser this run leaves open (headed).
//
// Returns the backend contract { ok, finalSubmitClicked:false, needsHuman?, offeredForms?,
// reopenedForm?, ... } — a refusal or ambiguity comes back needsHuman with the candidate
// forms listed, so the operator sees what was offered rather than a silent no-op.
export async function runCorrectionReopen(
  recipe: PortalRecipe,
  applicationNumber: string,
  docsByType: Record<string, string>,
  options: StageOptions = {},
): Promise<Record<string, unknown>> {
  return browserLimiter(async () => {
    const adapter = new RecipeAdapter(recipe, {}, docsByType, { beforeUpload: options.beforeUpload });
    let tmpStatePath: string | undefined;
    let leaveBrowserOpen = false;
    // Release the profile lock a prior guided-manual review browser may still hold.
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
        return {
          portalName: adapter.portalName,
          ok: false,
          finalSubmitClicked: false,
          finalSubmitClickedByAutomation: false,
          needsHuman: false,
          pauseReason: loginResult.pauseReason ?? null,
          message: `Login failed before the correction reopen ran: ${String(loginResult.message ?? loginResult.pauseReason ?? "no reason given")}`.slice(0, 300),
          steps: [loginResult],
        };
      }

      const reopenResult = await adapter.reopenSuspendedFiling(applicationNumber);
      const data = (reopenResult.data ?? {}) as Record<string, unknown>;
      // Leave the headed browser OPEN at the reopened form so the operator finishes and
      // resubmits in it (same guided-manual contract as staging); headless/server closes.
      leaveBrowserOpen = reopenResult.ok && options.headless === false && !!options.userDataDir;
      return {
        portalName: adapter.portalName,
        ok: reopenResult.ok,
        finalSubmitClicked: false,
        finalSubmitClickedByAutomation: false,
        needsHuman: data.needsHuman === true,
        offeredForms: Array.isArray(data.offeredForms) ? data.offeredForms.map((f) => String(f)) : [],
        reopenedForm: String(data.reopenedForm ?? ""),
        reopenWhy: String(data.reopenWhy ?? ""),
        attachedDocs: Number(data.attachedDocs ?? 0),
        attachGateStopped: data.attachGateStopped === true,
        applicationNumber: String(applicationNumber ?? ""),
        browserLeftOpen: leaveBrowserOpen,
        pauseReason: reopenResult.pauseReason ?? null,
        message: reopenResult.message,
        steps: [loginResult, reopenResult],
      };
    } catch (err) {
      return {
        portalName: adapter.portalName,
        ok: false,
        finalSubmitClicked: false,
        finalSubmitClickedByAutomation: false,
        needsHuman: true,
        pauseReason: null,
        message: `Correction reopen errored: ${err instanceof Error ? err.message : String(err)}`,
        steps: [{ ok: false, message: `Correction reopen errored: ${err instanceof Error ? err.message : String(err)}` }],
      };
    } finally {
      if (leaveBrowserOpen && options.userDataDir) {
        trackOpenAdapter(options.userDataDir, adapter);
      } else {
        await adapter.close();
      }
      shredTmpStateFile(tmpStatePath);
    }
  });
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
  /** Wall-clock cap for the page walk; the run stops itself rather than being abandoned. */
  budgetMs?: number;
  // docType → upload-ready file path (from the doc-splitting tools). Lets the learner
  // attach the right split document at each portal upload control while learning.
  docsByType?: Record<string, string>;
  beforeUpload?: (docType: string, file: string) => void;
  // "combined" (AHJ/Accela) attaches the full plan-set PDF to every upload control;
  // "split" (utility/PowerClerk) attaches the matching split sheet per control. Default split.
  uploadMode?: "split" | "combined";
  // Which deterministic policy-answer set the learner may apply ("residential_nem" for
  // utility NEM portals, "none" for AHJ/permit portals). See AutoLearnAdapter options.
  policyProfile?: "residential_nem" | "none";
  // Field keys a REPLAY can resolve. Passed through so the learner refuses to record a
  // binding that could never fill on a future project.
  bindableFields?: string[];
  // Optional live-progress sink so callers can drive a UI progress bar. Non-PII signals only.
  onProgress?: import("./adapters/autoLearnAdapter").LearnProgressFn;
  // PATCH-BY-DEMONSTRATION sink: when the headed browser is left open at review, every
  // hand-made fix (fill/select/check/upload/click) is captured and streamed here as a
  // RecipeStep so the backend can merge it into the learned recipe. Sensitive values are
  // never included; final-submit/pay clicks are never captured.
  onHumanStep?: (step: import("../../shared/src/types").RecipeStep) => void;
  // Equipment identity (inverterMake/inverterModel/moduleMake/moduleModel) for the
  // adapter's deterministic PV-spec combobox pass.
  equipment?: Record<string, string>;
  certifiedAliases?: Record<string, string[]>;
  contactIdentity?: import("./adapters/autoLearnAdapter").ContactIdentity;
  siteContactIdentity?: import("./adapters/autoLearnAdapter").ContactIdentity;
  /** City/ZIP/owner + discipline, so an address-disambiguation grid can refuse a row that
   *  belongs to another property rather than guessing between them. */
  siteIdentity?: { city?: string; zip?: string; homeownerName?: string; isElectrical?: boolean };
  /** Operator delegation: click the recorded final submit rather than leaving it for a human.
   *  Honoured only alongside PORTAL_ALLOW_FINAL_SUBMIT=1, checked at the click itself. */
  allowFinalSubmit?: boolean;
  /** Whether the project says a battery exists; false guards against declaring one. */
  hasBattery?: boolean;
  /** Accept a cookie banner offering nothing but an acceptance; decline is always tried first. */
  allowConsentAccept?: boolean;
}): Promise<import("./adapters/autoLearnAdapter").LearnResult> {
  const { AutoLearnAdapter } = await import("./adapters/autoLearnAdapter");
  const adapter = new AutoLearnAdapter(input.portalName, input.planner, { maxPages: input.maxPages, budgetMs: input.budgetMs, docsByType: input.docsByType, beforeUpload: input.beforeUpload, uploadMode: input.uploadMode, policyProfile: input.policyProfile, bindableFields: input.bindableFields, onProgress: input.onProgress, equipment: input.equipment, certifiedAliases: input.certifiedAliases, contactIdentity: input.contactIdentity, siteContactIdentity: input.siteContactIdentity, siteIdentity: input.siteIdentity, allowFinalSubmit: input.allowFinalSubmit, hasBattery: input.hasBattery, allowConsentAccept: input.allowConsentAccept });
  let tmpStatePath: string | undefined;
  let leaveOpen = false;
  // A browser left open by a prior guided-manual stage holds this profile's lock — close it
  // so the recorder can launch.
  await closePriorStagingBrowser(input.userDataDir);

  // HARD WALL-CLOCK CEILING. A learn could previously hang forever: measured live on
  // 2026-08-31, an Accela run went silent mid-wizard for 13+ minutes, still holding a
  // browser and a portal session, with no timeout anywhere to end it. The job-level
  // watchdog does not help — the in-flight guard exists precisely to stop it reclaiming a
  // long portal run, so a hung run is indistinguishable from a slow one and simply sits
  // there. On a workstation you notice; on an unattended server it is a wedged worker and,
  // now that profiles queue, everything behind it for that portal waits too.
  //
  // Force-closing the browser is what actually breaks the hang: whatever Playwright call is
  // stuck rejects, and the run unwinds through its normal error path into a failed job with
  // a real message. Generous by default — a legitimate LLM-driven learn takes minutes.
  const runCeilingMs = Math.max(60_000, Number(process.env.PORTAL_RUN_MAX_MS ?? 25 * 60_000));
  let ceiling: NodeJS.Timeout | undefined = setTimeout(() => {
    try {
      adapter.debug?.event({ type: "run_ceiling_exceeded", ms: runCeilingMs });
    } catch { /* diagnostics are best-effort */ }
    // Close the context out from under the stuck call; the run fails rather than hanging.
    void adapter.forceClose?.();
  }, runCeilingMs);
  const clearCeiling = () => { if (ceiling) { clearTimeout(ceiling); ceiling = undefined; } };

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
    // Arm patch-by-demonstration on the browser being left open: the human finishing the
    // missed fields at review teaches the recipe those fields for every future project.
    if (leaveOpen && input.onHumanStep) {
      try { await adapter.armHumanCapture(input.onHumanStep); } catch { /* capture is best-effort */ }
    }
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
    // Disarm the ceiling first: a run that finished must never have its browser closed out
    // from under a human who is being handed it at review.
    clearCeiling();
    // Keep a reached-review headed browser open for the human (tracked for cleanup); every other
    // path (login fail, headless/server, error, never-reached-review) closes to release the lock.
    if (leaveOpen && input.userDataDir) {
      trackOpenAdapter(input.userDataDir, adapter);
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
    const ctx = { storageStatePath: tmpStatePath, headless: options.headless ?? true, credential: options.credential, userDataDir: options.userDataDir, startUrl: options.loginUrl };

    adapter =
      adapterType === "accela" ? new OregonEPermittingAdapter() :
      adapterType === "powerclerk" ? new PowerClerkAdapter() :
      options.recipe ? new RecipeAdapter(options.recipe, options.fieldValues ?? {}, options.docsByType ?? {}, { beforeUpload: options.beforeUpload }) :
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
