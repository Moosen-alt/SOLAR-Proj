import type { PortalRecipe, ProjectRecord, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { HUMAN_REVIEW_MESSAGE, type PortalAdapter, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";

// RecipeAdapter — replays a recorded portal recipe (see portal_recipes / the recorder).
// Works for ANY AHJ or utility portal an admin has taught by recording. It substitutes
// the project + assigned-client field values and uploads the right docs, then STOPS at
// the review screen.
//
// SECURITY (hybrid submit model):
//   - DEFAULT (guided manual): stops at the `stopForReview` marker and never clicks the
//     final application-submit — a human always submits.
//   - autoSubmit (opt-in per trusted portal, operator-approved): may proceed past the
//     review marker and click the recorded final APPLICATION submit. It still NEVER
//     clicks a fee-payment control (PAY_FEE below), and bails to a human if a
//     CAPTCHA/MFA challenge appears at the final step.
//
// PAY_FEE is matched first and is ALWAYS blocked, even in autoSubmit mode.

const PAY_FEE = /\b(pay fee|pay now|submit & pay|submit and pay|make payment|pay \$|add to cart|proceed to (payment|checkout)|checkout)\b/i;
const FINAL_SUBMIT = /\b(submit application|file application|finalize submission|^submit$|submit now)\b/i;
const FINAL_CHALLENGE = /captcha|i'?m not a robot|two.factor|authenticat|verify your|verification code/i;
const RETRY_BACKOFF_MS = [2000, 5000, 10000];

function ok(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: true, message, data };
}
function fail(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: false, message, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RecipeAdapter implements PortalAdapter {
  portalName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any = null;

  constructor(
    private recipe: PortalRecipe,
    private fieldValues: Record<string, string>,
    private docsByType: Record<string, string>,
    private options: { autoSubmit?: boolean } = {},
  ) {
    this.portalName = `Recipe: ${recipe.ahj || recipe.utility || recipe.profileKey} (${recipe.portalPlatform || "portal"})`;
  }

  async login(context: PortalContext): Promise<PortalStepResult> {
    try {
      const { page } = await openPortal({
        userDataDir: context.userDataDir,
        storageStatePath: context.storageStatePath,
        headless: context.headless ?? false,
      });
      this.page = page;
      if (this.recipe.portalUrl) {
        await this.page.goto(this.recipe.portalUrl);
        await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      }

      // If the recipe has a loginStep and a credential is available, auto-fill
      // the login form when the session has expired. Never logs credentials.
      if (context.credential && this.recipe.loginStep) {
        const loginStep = this.recipe.loginStep;
        try {
          if (loginStep.usernameSel) {
            const uLoc = this.locator(loginStep.usernameSel);
            if (uLoc && await uLoc.count() > 0) {
              await uLoc.fill(context.credential.username);
              if (loginStep.passwordSel) {
                const pLoc = this.locator(loginStep.passwordSel);
                if (pLoc) await pLoc.fill(context.credential.password);
              }
              if (loginStep.submitSel) {
                const sLoc = this.locator(loginStep.submitSel);
                if (sLoc) await sLoc.click();
              }
              await this.page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
              const mfaVisible = await this.page.getByText(/verify|two.factor|authenticat/i).count() > 0;
              if (mfaVisible) {
                return { ok: false, message: "MFA/2FA required after credential fill — pausing for human. Complete verification in the browser window, then retry the portal run.", pauseReason: "mfa_captcha" };
              }
            }
          }
        } catch (fillErr) {
          return fail(`Recipe credential auto-fill failed: ${fillErr instanceof Error ? fillErr.message : String(fillErr)}`);
        }
      }

      return ok(`Opened ${this.portalName}. Using the persistent login session (log in once with npm run portal:login if prompted).`);
    } catch (err) {
      return fail(`Recipe login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // openSubmission/uploadFiles are no-ops: the recipe replays as ONE ordered sequence
  // (navigation, fills, AND uploads interleaved exactly as recorded) inside
  // fillApplication, so multi-page portals stay in the right order.
  async openSubmission(_project: ProjectRecord): Promise<PortalStepResult> {
    return ok("Recipe replay runs as a single ordered sequence; see fill step.");
  }
  async fillApplication(_project: ProjectRecord): Promise<PortalStepResult> {
    return this.runAll();
  }
  async uploadFiles(_project: ProjectRecord, _files: string[]): Promise<PortalStepResult> {
    return ok("Uploads are replayed inline within the recorded sequence.");
  }
  async stopAtReview(): Promise<PortalStepResult> {
    return ok(
      `${HUMAN_REVIEW_MESSAGE} The recipe staged ${this.portalName} to the review screen. Verify every field and uploaded file, handle any MFA/fee, then click submit manually. AUTOMATION HAS STOPPED.`,
    );
  }
  async captureSubmissionConfirmation(): Promise<PortalStepResult> {
    return ok("Capture the application/confirmation number manually after the human submits.");
  }

  // Read-only status scrape: navigate to the portal URL, search the page body for
  // any of the known application/permit numbers, and return a status text snippet.
  // NEVER clicks submit, modifies, or pays anything.
  async checkStatus(applicationNumbers: string[]): Promise<string | null> {
    if (!this.page || !this.recipe.portalUrl || !applicationNumbers.length) return null;
    try {
      await this.page.goto(this.recipe.portalUrl);
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      const bodyText = await this.page.locator("body").innerText().catch(() => "");
      for (const num of applicationNumbers) {
        if (!num) continue;
        const idx = bodyText.indexOf(num);
        if (idx === -1) continue;
        const snippet = bodyText.slice(Math.max(0, idx - 80), idx + 320).replace(/\s+/g, " ").trim();
        if (snippet) return snippet;
      }
      return bodyText.slice(0, 3000).replace(/\s+/g, " ").trim() || null;
    } catch {
      return null;
    }
  }

  // Replay every recorded step IN ORDER (uploads inline), stopping permanently at the
  // first stopForReview marker so we never proceed to the final submit.
  private async runAll(): Promise<PortalStepResult> {
    if (!this.page) return fail("Recipe replay has no open page.");
    let executed = 0;
    const skipped: string[] = [];
    for (const step of this.recipe.steps) {
      // Guided-manual: stop at review. autoSubmit (trusted, approved): proceed past
      // the review marker to replay the recorded final application submit.
      if (step.action === "stopForReview") {
        if (!this.options.autoSubmit) break;
        continue;
      }
      let lastErr: unknown;
      let succeeded = false;
      for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
        try {
          const done = await this.executeStep(step);
          if (done) executed++;
          else skipped.push(step.note || step.action);
          succeeded = true;
          break;
        } catch (err) {
          lastErr = err;
          const isTimeout = err instanceof Error && /timeout|TimeoutError/i.test(err.message);
          if (!isTimeout || attempt >= RETRY_BACKOFF_MS.length) break;
          await sleep(RETRY_BACKOFF_MS[attempt]);
          // Reload on timeout retries to recover from stale page state.
          await this.page.reload({ waitUntil: "networkidle", timeout: 15000 }).catch(() => null);
        }
      }
      if (!succeeded) {
        if (step.optional) {
          skipped.push(`${step.note || step.action} (optional, skipped: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
          continue;
        }
        return fail(`Recipe step failed (${step.action}${step.note ? ` — ${step.note}` : ""}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`, { executed, skipped });
      }
    }
    return ok(`Replayed ${executed} recorded step(s); stopped at review.`, { executed, skipped });
  }

  private resolveValue(step: RecipeStep): string {
    if (step.field) return this.fieldValues[step.field] ?? "";
    return step.value ?? "";
  }

  // Returns true if the step performed an action, false if it was safely skipped.
  private async executeStep(step: RecipeStep): Promise<boolean> {
    const scoped = await this.resolveLocator(step.selector);
    switch (step.action) {
      case "goto":
        await this.page.goto(this.resolveValue(step));
        await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
        return true;
      case "click": {
        const name = step.selector?.name || step.selector?.text || "";
        // Fee payment is NEVER automated, even on a trusted auto-submit portal.
        if (PAY_FEE.test(name)) return false;
        if (FINAL_SUBMIT.test(name)) {
          // Guided-manual: stop before the final submit so a human clicks it.
          if (!this.options.autoSubmit) return false;
          // Trusted auto-submit: bail to a human if a CAPTCHA/MFA challenge is on the
          // final page — we never solve or bypass challenges.
          const challenge = await this.page.getByText(FINAL_CHALLENGE).count().catch(() => 0);
          if (challenge > 0) throw new Error("Final submit needs a human: CAPTCHA/MFA challenge detected.");
        }
        await scoped!.click();
        return true;
      }
      case "fill": {
        const v = this.resolveValue(step);
        if (!v) return false;
        await scoped!.fill(v);
        return true;
      }
      case "select": {
        const v = this.resolveValue(step);
        if (!v) return false;
        await scoped!.selectOption(v).catch(async () => scoped!.selectOption({ label: v }));
        return true;
      }
      case "check":
        await scoped!.check();
        return true;
      case "uncheck":
        await scoped!.uncheck();
        return true;
      case "press":
        await scoped!.press(step.value || "Enter");
        return true;
      case "waitFor":
        if (scoped) await scoped.waitFor({ timeout: 15000 });
        else await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
        return true;
      case "upload": {
        const file = step.docType ? this.docsByType[step.docType] : undefined;
        if (!file) return false;
        await scoped!.setInputFiles(file);
        return true;
      }
      default:
        return false;
    }
  }

  // Resolve a selector to a present locator: try the primary, and if it matches
  // nothing, walk the recorded fallbacks in order and use the first that exists.
  // Returns the primary locator unchanged when there are no fallbacks (so the
  // action/wait still fails or times out naturally and the retry loop applies).
  private async resolveLocator(sel?: RecipeSelector) {
    const primary = this.locator(sel);
    if (!sel || !sel.fallbacks?.length || !primary) return primary;
    try {
      if (await primary.count() > 0) return primary;
    } catch {
      // count() can throw on a malformed primary — fall through to fallbacks.
    }
    for (const fb of sel.fallbacks) {
      // Ignore a fallback's own nested fallbacks (one level deep).
      const loc = this.locator({ ...fb, fallbacks: undefined });
      if (!loc) continue;
      try {
        if (await loc.count() > 0) return loc;
      } catch {
        // Try the next fallback.
      }
    }
    return primary;
  }

  // Build a Playwright locator from a portable selector descriptor.
  private locator(sel?: RecipeSelector) {
    if (!sel) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scope: any = sel.frame ? this.page.frameLocator(`iframe[name="${sel.frame}"]`) : this.page;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let loc: any;
    if (sel.role && sel.name) loc = scope.getByRole(sel.role, { name: sel.name, exact: sel.exact });
    else if (sel.label) loc = scope.getByLabel(sel.label, { exact: sel.exact });
    else if (sel.placeholder) loc = scope.getByPlaceholder(sel.placeholder, { exact: sel.exact });
    else if (sel.testId) loc = scope.getByTestId(sel.testId);
    else if (sel.text) loc = scope.getByText(sel.text, { exact: sel.exact });
    else if (sel.css) loc = scope.locator(sel.css);
    else if (sel.role) loc = scope.getByRole(sel.role);
    else throw new Error("Recipe step has no usable selector.");
    return typeof sel.nth === "number" ? loc.nth(sel.nth) : loc.first();
  }
}
