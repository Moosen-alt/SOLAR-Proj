// StagehandAdapter — AI-powered portal learning that uses natural language to interact
// with portals instead of recorded CSS/ARIA selectors. Used as a fallback when:
//   - autoLearnAdapter fails to locate elements (portal layout non-standard)
//   - A portal uses heavy JS rendering that defeats static selectors
//
// Uses Stagehand (Browserbase) in LOCAL mode with the project's Anthropic key —
// no Browserbase cloud account needed. Set STAGEHAND_VERBOSE=1 to enable debug logs.
//
// SAFETY (same as all adapters — non-negotiable):
//   - NEVER clicks final submit, fee payment, CAPTCHA, or MFA. The AI is explicitly
//     instructed to stop at the review/confirmation screen.
//   - Credentials are passed in-memory; never logged or written to disk.
//   - SESSION_ENCRYPTION_KEY from environment only.

import type { ProjectRecord } from "../../../shared/src/types";
import type { PortalContext, PortalStepResult } from "../adapter";
import { detectChallengeFrame, smartWait } from "../safeAction";

const PAY_FEE = /\b(pay fee|pay now|submit & pay|make payment|pay \$|add to cart|checkout|proceed to payment)\b/i;
const FINAL_SUBMIT = /\b(submit application|file application|confirm submission|finalize|place order|complete submission)\b/i;

export interface StagehandLearnResult {
  ok: boolean;
  message: string;
  steps: Array<{ action: string; description: string }>;
  reviewScreenText: string;
  reviewScreenshotBase64?: string;
  pauseReason?: string;
}

export class StagehandAdapter {
  private stagehand: unknown = null;
  private page: unknown = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get pg(): any { return this.page; }

  constructor(
    private portalName: string,
    private portalUrl: string,
  ) {}

  async open(context: PortalContext): Promise<PortalStepResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, message: "ANTHROPIC_API_KEY not set — Stagehand requires it for local AI element finding." };

    try {
      // OPTIONAL dependency — not in the default install (it pulls in the whole
      // @ai-sdk/* tree). To enable the AI fallback: `npm install @browserbasehq/stagehand`.
      // The @ts-ignore lets the project typecheck/run without the package present.
      // @ts-ignore — optional peer dependency, resolved at runtime only when installed
      const mod: any = await import("@browserbasehq/stagehand").catch(() => null);
      if (!mod?.Stagehand) {
        return { ok: false, message: "Stagehand is not installed. To enable the AI portal fallback, run: npm install @browserbasehq/stagehand" };
      }
      const Stagehand = mod.Stagehand;
      const sh = new Stagehand({
        env: "LOCAL",
        verbose: process.env.STAGEHAND_VERBOSE === "1" ? 1 : 0,
        // Use the project's Anthropic key; never Browserbase cloud unless BB_API_KEY is set.
        apiKey,
        model: "claude-opus-4-8",
        localBrowserLaunchOptions: { headless: context.headless ?? (process.env.PORTAL_HEADLESS !== "false") },
      });
      await sh.init();
      this.stagehand = sh;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.page = (sh as any).page;

      await this.pg.goto(this.portalUrl);
      await smartWait(this.pg);
      return { ok: true, message: `Stagehand opened ${this.portalName}` };
    } catch (err) {
      return { ok: false, message: `Stagehand open failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Learn a portal form by describing each action in plain English to the AI.
  // Stops at the review screen; never clicks submit or pay.
  async learn(
    project: ProjectRecord,
    fieldValues: Record<string, string>,
  ): Promise<StagehandLearnResult> {
    if (!this.page) return { ok: false, message: "Call open() first.", steps: [], reviewScreenText: "" };

    const steps: Array<{ action: string; description: string }> = [];
    let reviewScreenText = "";
    let reviewScreenshotBase64: string | undefined;
    const maxPages = 15;

    for (let page = 0; page < maxPages; page++) {
      // Safety: detect challenge frames before any AI action.
      const challenge = await detectChallengeFrame(this.pg);
      if (challenge) {
        return { ok: false, message: `Stagehand paused: ${challenge}. Complete verification in the browser, then retry.`, steps, reviewScreenText, pauseReason: "mfa_captcha" };
      }

      // Ask the AI to describe what's on the current page and what to fill next.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sh = this.stagehand as any;
      let pageObservation: string;
      try {
        const obs = await sh.page.extract({
          instruction: "Describe the form fields visible on this page. Are we on a review/confirmation page (no fillable fields, just a summary)? List: fieldLabels[], isReviewPage (bool), hasSubmitButton (bool), hasPaymentButton (bool).",
          schema: {
            type: "object",
            properties: {
              fieldLabels: { type: "array", items: { type: "string" } },
              isReviewPage: { type: "boolean" },
              hasSubmitButton: { type: "boolean" },
              hasPaymentButton: { type: "boolean" },
            },
          },
        });
        pageObservation = JSON.stringify(obs);

        // Stop at review/confirmation — record the state, never click submit.
        if (obs?.isReviewPage) {
          reviewScreenText = await this.pg.locator("body").innerText().catch(() => "");
          try {
            const screenshot = await this.pg.screenshot({ type: "png" });
            reviewScreenshotBase64 = Buffer.from(screenshot).toString("base64");
          } catch { /* non-fatal */ }
          steps.push({ action: "stopForReview", description: "Review screen reached — automation stopped. Human submits." });
          return { ok: true, message: `Stagehand reached review screen after ${steps.length} step(s).`, steps, reviewScreenText, reviewScreenshotBase64 };
        }

        // Hard block: payment buttons — even if AI sees one, stop.
        if (obs?.hasPaymentButton) {
          return { ok: false, message: "Stagehand detected a payment button — stopping. Automation never pays fees.", steps, reviewScreenText };
        }

        const labels: string[] = obs?.fieldLabels ?? [];

        // Fill each field by mapping its label to a known project value.
        for (const label of labels) {
          const lLow = label.toLowerCase();
          const value =
            fieldValues[label] ||
            fieldValues[lLow] ||
            Object.entries(fieldValues).find(([k]) => k.toLowerCase() === lLow)?.[1] ||
            "";
          if (!value) continue;
          // Never fill password/account/meter fields via Stagehand — sensitive fields
          // must only be filled by the credential injection path, never by AI.
          if (/password|account.*(number|no|#)|meter.*(number|no|#)|ssn|tax.?id/i.test(label)) continue;
          try {
            await sh.page.act({ action: `Fill the "${label}" field with the value "${value}"` });
            steps.push({ action: "fill", description: `${label} → [value]` });
          } catch { /* field may not be fillable */ }
        }

        // Advance to the next page — but NEVER click submit or pay.
        if (!obs?.isReviewPage && !obs?.hasSubmitButton) {
          try {
            await sh.page.act({ action: "Click the Next, Continue, or Save and Continue button to advance to the next page. Do NOT click Submit, File, Finalize, or any payment button." });
            steps.push({ action: "click", description: "advance to next page" });
            await smartWait(this.pg);
          } catch { break; }
        } else if (obs?.hasSubmitButton && !obs?.isReviewPage) {
          // Submit button visible but not on review page — stop and let human advance.
          steps.push({ action: "stopForReview", description: "Submit visible but not confirmed review page — stopping for human." });
          break;
        }

      } catch (err) {
        return { ok: false, message: `Stagehand AI step failed (page ${page}): ${err instanceof Error ? err.message : String(err)}`, steps, reviewScreenText };
      }

      pageObservation; // suppress unused warning
    }

    return { ok: true, message: `Stagehand completed ${steps.length} step(s); stopped before review.`, steps, reviewScreenText, reviewScreenshotBase64 };
  }

  async close(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.stagehand as any)?.close?.();
    } catch { /* ignore */ }
    this.page = null;
    this.stagehand = null;
  }
}
