import path from "node:path";
import type { ProjectRecord, ReviewerReport } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { redactStatusText, smartWait, waitForElement } from "../safeAction";
import { performLogin } from "./loginFlow";

// DevelopmentDirect (citizenserve / Brightly DevelopmentDirect) adapter.
// Navigates the portal up to the review screen and stops — the human submits.
// SECURITY: Never clicks final submit, pays fees, solves CAPTCHA, or handles MFA.

function ok(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: true, message, data };
}
function fail(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: false, message, data };
}

export class DevelopmentDirectAdapter extends BasePortalAdapter {
  portalName = "Development Direct";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any = null;

  async login(context: PortalContext): Promise<PortalStepResult> {
    try {
      const opened = await openPortal({
        userDataDir: context.userDataDir,
        storageStatePath: context.storageStatePath,
        headless: context.headless,
      });
      this.opened = opened;
      this.page = opened.page;

      // Navigate to the portal entry URL when provided.
      if (context.startUrl) {
        await this.page.goto(context.startUrl);
        await smartWait(this.page);
      }

      const login = await performLogin(this.page, context.credential);
      if (login.status === "mfa_captcha") {
        return { ok: false, message: login.message, pauseReason: "mfa_captcha" };
      }
      if (login.status === "no_credential") {
        return fail(
          "Development Direct: a login page is showing but no stored credential was found for this client/portal. Add the portal login under the client's logins and re-stage.",
        );
      }
      if (!login.ok && login.status !== "already_authenticated") {
        return fail(`Development Direct: ${login.message}`);
      }
      return ok(`Opened Development Direct. ${login.message}`);
    } catch (err) {
      return fail(`Development Direct login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Navigation to the "new application" flow is portal-specific.
  // The recipe-based path or the auto-learn path handles this; this adapter
  // surfaces a human-guided mode where we just open the portal and let the
  // operator navigate to the right page.
  async openSubmission(_project: ProjectRecord): Promise<PortalStepResult> {
    if (!this.page) return fail("No browser open — call login() first.");
    return ok(
      "Development Direct portal is open. Navigate to the correct permit application type, then trigger the next step.",
    );
  }

  async fillApplication(_project: ProjectRecord): Promise<PortalStepResult> {
    if (!this.page) return fail("No browser open — call login() first.");
    return ok(
      "Development Direct: field filling must be handled via a recorded recipe or the auto-learn adapter. The browser is open for human guidance.",
    );
  }

  // Upload each file to the portal using a generic file input selector strategy.
  // DevelopmentDirect portals typically expose a standard <input type="file"> on
  // each document section. Tries common selectors in order.
  async uploadFiles(_project: ProjectRecord, files: string[]): Promise<PortalStepResult> {
    if (!this.page) return fail("No browser open — call login() first.");
    if (!files.length) return ok("No files to upload.");

    const uploaded: string[] = [];
    const failed: string[] = [];

    for (const filePath of files) {
      try {
        await smartWait(this.page);
        // Try the most common file-input selectors used by DevelopmentDirect (Brightly/citizenserve).
        const fileInput = this.page.locator("input[type='file']").first();
        await waitForElement(fileInput);
        await fileInput.setInputFiles(filePath);
        uploaded.push(path.basename(filePath));
      } catch (err) {
        failed.push(`${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (failed.length) {
      return fail(
        `Development Direct: uploaded ${uploaded.length} file(s) but ${failed.length} failed:\n${failed.join("\n")}`,
        { uploaded, failed },
      );
    }
    return ok(`Development Direct: uploaded ${uploaded.length} file(s).`, { uploaded });
  }

  async stopAtReview(_project: ProjectRecord, _reviewerReport?: ReviewerReport): Promise<PortalStepResult> {
    return ok(
      `${HUMAN_REVIEW_MESSAGE} The Development Direct portal is staged for human review. Verify all fields and documents, then submit manually.`,
      {
        ahjPreviewVisibleRequired: true,
        finalSubmitButtonAloneIsEnough: false,
        nextHumanAction:
          "Confirm every field and uploaded document on the Development Direct review page, then click submit manually. AUTOMATION HAS STOPPED.",
        finalSubmitClicked: false,
      },
    );
  }

  async captureSubmissionConfirmation(): Promise<PortalStepResult> {
    if (!this.page) return ok("No open page to capture confirmation from.", { permitNumber: "", recordLink: "" });
    try {
      await smartWait(this.page);
      const bodyText = String((await this.page.locator("body").innerText().catch(() => "")) || "");
      // DevelopmentDirect confirmation numbers are typically alphanumeric, e.g. "BP-2024-001234".
      const devDirect = bodyText.match(/\b(?:BP|BLD|BLDG|PER|PERMIT)-?\d{4}-\d{4,7}\b/i);
      // Generic fallback.
      const generic = bodyText.match(
        /\b(?:record|permit|application|confirmation)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,})\b/i,
      );
      const permitNumber = (devDirect?.[0] || generic?.[1] || "").trim();
      const recordLink = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
      const submitted = /successfully submitted|has been submitted|your application/i.test(bodyText);
      if (permitNumber || submitted) {
        return ok(`Captured submission confirmation${permitNumber ? `: ${permitNumber}` : ""}.`, {
          permitNumber,
          confirmationNumber: permitNumber,
          recordLink,
        });
      }
      return ok("Submitted; no record number found on the completion page yet.", { permitNumber: "", recordLink });
    } catch (err) {
      return ok(
        `Confirmation capture skipped: ${err instanceof Error ? err.message : String(err)}`,
        { permitNumber: "", recordLink: "" },
      );
    }
  }

  // Read-only status check: navigate to the portal, look for the application number.
  async checkStatus(applicationNumbers: string[]): Promise<string | null> {
    if (!this.page || !applicationNumbers.length) return null;
    try {
      await smartWait(this.page);
      const bodyText = await this.page.locator("body").innerText().catch(() => "");
      for (const num of applicationNumbers) {
        if (!num) continue;
        const idx = bodyText.indexOf(num);
        if (idx === -1) continue;
        const snippet = bodyText.slice(Math.max(0, idx - 80), idx + 320);
        const redacted = redactStatusText(snippet);
        if (redacted) return redacted;
      }
      return redactStatusText(bodyText.slice(0, 600));
    } catch {
      return null;
    }
  }
}
