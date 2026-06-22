import type { PortalRecipe, ProjectRecord, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { HUMAN_REVIEW_MESSAGE, type PortalAdapter, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";

// RecipeAdapter — replays a recorded portal recipe (see portal_recipes / the recorder).
// Works for ANY AHJ or utility portal an admin has taught by recording. It substitutes
// the project + assigned-client field values and uploads the right docs, then STOPS at
// the review screen. SECURITY: it never clicks a final-submit / pay step (terminal
// `stopForReview` marker + a denylist guard below) — a human always submits manually.

const FINAL_SUBMIT = /\b(submit application|submit & pay|submit and pay|pay fee|pay now|file application|finalize submission|^submit$)\b/i;
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

  // Replay every recorded step IN ORDER (uploads inline), stopping permanently at the
  // first stopForReview marker so we never proceed to the final submit.
  private async runAll(): Promise<PortalStepResult> {
    if (!this.page) return fail("Recipe replay has no open page.");
    let executed = 0;
    const skipped: string[] = [];
    for (const step of this.recipe.steps) {
      if (step.action === "stopForReview") break;
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
    const scoped = this.locator(step.selector);
    switch (step.action) {
      case "goto":
        await this.page.goto(this.resolveValue(step));
        await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
        return true;
      case "click": {
        // GUARD: never click a final-submit / pay control.
        const name = step.selector?.name || step.selector?.text || "";
        if (FINAL_SUBMIT.test(name)) return false;
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
