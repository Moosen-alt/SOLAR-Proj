import path from "node:path";
import type { ProjectRecord, ReviewerReport } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { redactStatusText, safeAction } from "../safeAction";

// Oregon ePermitting (Accela ACA) adapter
// Codegen recording captured by operator up to the review page.
// SECURITY: This adapter NEVER clicks final submit, pays fees, solves CAPTCHA, or handles MFA.
// The human must perform those actions after reviewing the staged package.

const BASE_URL = "https://aca-oregon.accela.com/oregon";

function ok(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: true, message, data };
}

function fail(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: false, message, data };
}

// Fields like moduleQuantity, inverterModel etc. live in parserSnapshot, not the top-level record
function snap(project: ProjectRecord): Record<string, unknown> {
  return (project.parserSnapshot ?? {}) as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number | null {
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function buildDescriptionOfWork(project: ProjectRecord): string {
  const s = snap(project);
  const parts: string[] = [];

  const moduleQty = num(s["moduleQuantity"] ?? s["module_quantity"]);
  const moduleModel = str(s["moduleModel"] ?? s["module_model"]);
  const moduleWatts = num(s["moduleWatts"] ?? s["module_watts"]);
  const dcKw = project.systemSizeDcKw;
  const acKw = project.systemSizeAcKw;
  const inverterQty = num(s["inverterQuantity"] ?? s["inverter_quantity"]);
  const inverterModel = str(s["inverterModel"] ?? s["inverter_model"]);
  const batteryQty = num(s["batteryQuantity"] ?? s["battery_quantity"]);
  const batteryModel = str(s["batteryModel"] ?? s["battery_model"]);
  const essKwh = num(s["essKwh"] ?? s["ess_kwh"] ?? s["battery_kwh"]);

  const modules = moduleQty && moduleModel
    ? `${moduleQty} modules (${moduleModel})${moduleWatts ? ` at ${moduleWatts}W` : ""}`
    : null;
  const kw = [dcKw ? `${dcKw} kW DC` : null, acKw ? `${acKw} kW AC` : null].filter(Boolean).join(" / ");
  const inverter = inverterModel
    ? `${inverterQty ? inverterQty + " " : ""}${inverterModel} inverter${(inverterQty ?? 1) > 1 ? "s" : ""}`
    : null;

  if (modules || kw) {
    parts.push(`Install roof-mounted photovoltaic solar system${modules ? ": " + modules : ""}${kw ? ", " + kw : ""}${inverter ? ", with " + inverter : ""}.`);
  }

  if (project.interconnectionMethod) {
    parts.push(`Interconnection method: ${project.interconnectionMethod}.`);
  }

  if (batteryModel || essKwh) {
    const battery = [batteryQty ? `${batteryQty} ` : "", batteryModel, essKwh ? `(${essKwh} kWh)` : ""].filter(Boolean).join(" ");
    parts.push(`Battery / ESS scope includes ${battery}.`);
  }

  return parts.join("\n") || "Solar PV system installation.";
}

function buildProjectName(project: ProjectRecord): string {
  return project.homeownerName || project.projectAddress || "Solar PV Project";
}

function parseStreetNumber(address: string): string {
  return address.trim().split(/\s+/)[0] ?? "";
}

function parseStreetName(address: string): string {
  const parts = address.trim().split(/\s+/);
  parts.shift(); // remove street number
  // Strip unit designators from the end
  const unitKeywords = new Set(["apt", "unit", "ste", "suite", "#"]);
  const unitIdx = parts.findIndex((p) => unitKeywords.has(p.toLowerCase()));
  return (unitIdx === -1 ? parts : parts.slice(0, unitIdx)).join(" ");
}

export class OregonEPermittingAdapter extends BasePortalAdapter {
  portalName = "Oregon ePermitting (Accela ACA)";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any = null;

  // ---------------------------------------------------------------------------
  // login — uses a persistent browser profile so the login survives across runs
  // ---------------------------------------------------------------------------
  async login(context: PortalContext): Promise<PortalStepResult> {
    try {
      const opened = await openPortal({
        userDataDir: context.userDataDir,
        storageStatePath: context.storageStatePath,
        // Pass headless through so resolveHeadless picks the server-correct default.
        headless: context.headless,
      });
      this.opened = opened;
      this.page = opened.page;

      await this.page.goto(`${BASE_URL}/Default.aspx`);
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

      const isLoggedIn = await this.page.locator('a[href*="Dashboard"]').count() > 0
        || (await this.page.title()).toLowerCase().includes("dashboard");

      if (!isLoggedIn) {
        if (context.credential) {
          // Session expired — auto-fill the login form with stored credentials.
          // Never logs the credential; stops if MFA is detected after submit.
          try {
            await this.page.getByLabel("Email").fill(context.credential.username);
            await this.page.getByLabel("Password").fill(context.credential.password);
            await this.page.getByRole("button", { name: /log in|sign in/i }).click();
            await this.page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);

            const mfaVisible = await this.page.getByText(/verify|two.factor|authenticat/i).count() > 0;
            if (mfaVisible) {
              return { ok: false, message: "MFA/2FA required after credential fill — pausing for human. Complete verification in the browser window, then retry the portal run.", pauseReason: "mfa_captcha" };
            }
            const loggedInAfterFill = await this.page.locator('a[href*="Dashboard"]').count() > 0
              || (await this.page.title()).toLowerCase().includes("dashboard");
            if (!loggedInAfterFill) {
              return fail("Credential auto-fill did not result in a successful login. Check the stored username/password in Portal Credentials.");
            }
          } catch (fillErr) {
            return fail(`Credential auto-fill failed: ${fillErr instanceof Error ? fillErr.message : String(fillErr)}`);
          }
        } else {
          return fail(
            "Oregon ePermitting login page is still showing. Log in manually in the browser window, then re-run. For a persistent login, use: npm run portal:login -- accela"
          );
        }
      }

      return ok("Logged in to Oregon ePermitting.", { portalProfileId: context.portalProfileId ?? null });
    } catch (err) {
      return fail(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // openSubmission — clicks "Building Dept Application" and accepts disclaimer
  // ---------------------------------------------------------------------------
  async openSubmission(project: ProjectRecord): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in. Call login() first.");
    try {
      await this.page.goto(`${BASE_URL}/Dashboard.aspx`);
      await this.page.getByRole("link", { name: "Building Dept Application" }).click();
      await this.page.getByRole("checkbox", { name: /I have read and agree/i }).check();
      await this.page.getByRole("link", { name: "Continue Application »" }).click();

      // Step 1: Address search
      const streetNum = parseStreetNumber(project.projectAddress ?? "");
      const streetName = parseStreetName(project.projectAddress ?? "");

      await this.page.getByRole("textbox", { name: /Street Number/i }).fill(streetNum);
      await this.page.getByRole("textbox", { name: "Street Name:" }).fill(streetName);
      await this.page.getByRole("link", { name: "Search", description: "Search" }).click();

      // Select first address result
      await this.page.locator(
        "#ctl00_PlaceHolderMain_WorkLocationEdit_ucAddressList_gvAddress_ctl03_lnkGetService"
      ).click({ timeout: 15000 });

      // Choose Residential - Structural application type
      await this.page.getByRole("checkbox", { name: "Residential - Structural" }).check();
      await this.page.getByRole("link", { name: "Continue Application »" }).click();

      // PII redaction: do NOT return the street number/name/full address — only a
      // boolean confirming the address search resolved.
      return ok("Application opened and address confirmed.", {
        projectId: project.id,
        addressResolved: Boolean(streetNum || streetName),
      });
    } catch (err) {
      return fail(`openSubmission failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // fillApplication — fills all form steps through the construction details page
  // ---------------------------------------------------------------------------
  async fillApplication(project: ProjectRecord): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in. Call login() first.");
    // Collect REQUIRED-field failures (redacted field names only) so a half-filled
    // form reports ok:false instead of silently looking successful.
    const requiredFailures: string[] = [];
    const collect = async (label: string, action: () => Promise<void>, required = true): Promise<void> => {
      const r = await safeAction(label, action, { required });
      if (!r.ok) requiredFailures.push(`${r.field}: ${r.message ?? "failed"}`);
    };
    try {
      const descriptionOfWork = buildDescriptionOfWork(project);
      const projectName = buildProjectName(project);

      // Step 2 page 2 — skip filler pages
      await this.page.goto(
        `${BASE_URL}/Cap/CapEdit.aspx?stepNumber=2&pageNumber=2&currentStep=0&currentPage=1&Module=Building&isRenewal=N&isFromShoppingCart=&isFromConfirmPage=&confirmStepNumber=0&isFromConfirmPage=N`
      );
      await this.page.getByRole("link", { name: "Continue Application »" }).click();
      await this.page.getByRole("link", { name: "Continue Application »" }).click();

      // Project info — jobValue lives in parserSnapshot. These are REQUIRED fields:
      // route them through safeAction (retry+timeout) and surface any failure.
      const s = snap(project);
      const jobValue = str(s["jobValue"] ?? s["job_value"]) || String((project.systemSizeDcKw ?? 0) * 4000) || "0";
      await collect("jobValue", () => this.page.getByRole("textbox", { name: "Job Value($):" }).fill(jobValue));
      await collect("categoryOfConstruction", () => this.page.getByLabel("Category of Construction").selectOption("1"));
      await collect("projectName", () => this.page.getByRole("textbox", { name: "Project Name" }).fill(projectName));
      await collect("descriptionOfWork", () => this.page.getByRole("textbox", { name: "Description of Work" }).fill(descriptionOfWork));
      await this.page.getByRole("link", { name: "Continue Application »" }).click();

      // Applicant / contact — select from account (pre-existing company contact)
      await this.page.locator("#ctl00_PlaceHolderMain_Applicant_19Edit_btnAddNew").click().catch(() => null);

      // NEVER hardcode contractor identity. These come from the assigned client via
      // clientStagingOverlay (prepareSubmission guarantees clientId + CCB). Refuse to
      // fill the applicant/contact with blank or default info.
      const installerCompanyName = str(s["installerCompanyName"] ?? s["installer_company_name"]);
      const installerEmail = str(s["installerEmail"] ?? s["installer_email"]);
      if (!installerCompanyName || !installerEmail) {
        throw new Error(
          "Oregon ePermitting: refusing to fill the applicant/contact — no submitting-client company/email on the staging overlay. Assign a client with full licensing before staging.",
        );
      }

      const contactFrame = this.page.frameLocator('iframe[name="ACADialogFrame"]');
      const contactFirst = await contactFrame.getByRole("textbox", { name: "First:" }).count();
      if (contactFirst > 0) {
        const firstName = installerCompanyName.split(" ")[0] ?? installerCompanyName;
        const lastName = installerCompanyName.split(" ").slice(1).join(" ") || firstName;
        await contactFrame.getByRole("textbox", { name: "First:" }).fill(firstName);
        await contactFrame.getByRole("textbox", { name: "Last:" }).fill(lastName);
        await contactFrame.getByRole("textbox", { name: "E-mail:" }).fill(installerEmail);
        await contactFrame.getByRole("link", { name: "Continue" }).click();
      }

      // Or select the company from the existing account list
      await this.page.getByRole("link", { name: "Select from Account" }).click().catch(() => null);
      const accountFrame = this.page.frameLocator('iframe[name="ACADialogFrame"]');
      const firstRow = await accountFrame.locator(
        "#ctl00_phPopup_contactSearchList_gdvSearchContactList_CB_1"
      ).count();
      if (firstRow > 0) {
        await accountFrame.locator(
          "#ctl00_phPopup_contactSearchList_gdvSearchContactList_CB_1"
        ).check();
        await accountFrame.getByRole("link", { name: "Continue" }).click();
      }

      await this.page.getByRole("link", { name: "Continue Application »" }).click();

      // Construction details — REQUIRED fields, routed through safeAction.
      await collect("constructionCategory", () => this.page.getByLabel("Category of Construction:", { exact: true }).selectOption("Other"));
      await collect("otherCategory", () => this.page.getByRole("textbox", { name: /Other Category of/i }).fill("Solar"));
      await collect("typeOfWork", () => this.page.getByLabel("Type of Work:", { exact: true }).selectOption("New"));
      await collect("buildingHeight", () => this.page.getByRole("textbox", { name: "Building Height - Feet:" }).fill("0"));
      await collect("numberOfStories", () => this.page.getByRole("textbox", { name: "Number of Stories:" }).fill("0"));
      await collect("newBuildingArea", () => this.page.getByRole("textbox", { name: "New Building Area:" }).fill("0"));
      await collect("existingBuildingArea", () => this.page.getByRole("textbox", { name: "Existing Building Area:" }).fill("0"));
      await this.page.getByRole("link", { name: "Continue Application »" }).click();

      // If any REQUIRED field failed, the form is half-filled — report ok:false with a
      // redacted (field-name-only) message so the backend never records a clean fill.
      if (requiredFailures.length > 0) {
        return fail(
          `fillApplication: ${requiredFailures.length} required field(s) could not be filled — manual review required.`,
          { requiredFailures, jobValue },
        );
      }

      // PII redaction: do NOT return projectName (homeowner name / address) or the
      // free-text descriptionOfWork (contains owner name/address). Return only
      // non-identifying confirmation of what was filled.
      return ok("All application fields filled.", {
        jobValue,
        descriptionFilled: descriptionOfWork.length > 0,
      });
    } catch (err) {
      return fail(`fillApplication failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // uploadFiles — uploads each file as a "Plans - Construction" document
  // ---------------------------------------------------------------------------
  async uploadFiles(project: ProjectRecord, files: string[]): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in. Call login() first.");
    const uploaded: string[] = [];
    const failed: string[] = [];

    for (const filePath of files) {
      try {
        await this.page.getByRole("link", { name: "Add" }).first().click();

        const uploadFrame = this.page.frameLocator('iframe[name="ACADialogFrame"]');
        await uploadFrame.getByRole("link", { name: "Add" }).click();
        await uploadFrame.getByTitle("Add").setInputFiles(filePath);
        await uploadFrame.getByRole("link", { name: "Continue" }).click();

        const descriptionOfWork = buildDescriptionOfWork(project);
        await this.page.getByRole("textbox", { name: "Description:" }).fill(descriptionOfWork);
        await this.page.getByLabel("*Type (Required):").selectOption("BUILDING DOCUMENTS::Plans - Construction");
        await this.page.getByRole("link", { name: "Save", exact: true }).click();

        uploaded.push(path.basename(filePath));
      } catch (err) {
        failed.push(`${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.page.getByRole("link", { name: "Continue Application »" }).click().catch(() => null);

    if (failed.length > 0 && uploaded.length === 0) {
      return fail(`All uploads failed.`, { failed });
    }

    return ok(`Uploaded ${uploaded.length} file(s).`, { uploaded, failed });
  }

  // ---------------------------------------------------------------------------
  // stopAtReview — navigates to the final review page and STOPS.
  // The human must review all fields, handle any MFA/CAPTCHA, pay fees, and
  // click the final submit button manually.
  // AUTOMATION MUST NEVER CLICK FINAL SUBMIT.
  // ---------------------------------------------------------------------------
  async stopAtReview(project: ProjectRecord, reviewerReport?: ReviewerReport): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in. Call login() first.");
    try {
      // Navigate forward through any remaining wizard steps to reach the review page.
      // We click Continue until we reach a page whose URL or title indicates "Review".
      let reviewReached = false;
      for (let i = 0; i < 6; i++) {
        const url = this.page.url();
        if (url.includes("Review") || url.includes("review") || url.includes("Confirm")) {
          reviewReached = true;
          break;
        }
        const continueLink = this.page.getByRole("link", { name: "Continue Application »" });
        if (await continueLink.count() === 0) break;
        await continueLink.click();
        await this.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
      }

      const finalUrl = this.page.url();
      const blockerCount = reviewerReport?.findings.filter((f) => f.severity === "blocker").length ?? 0;

      return ok(HUMAN_REVIEW_MESSAGE, {
        projectId: project.id,
        portalReviewUrl: finalUrl,
        reviewReached,
        blockerCount,
        ahjPreviewVisibleRequired: reviewerReport?.finalSubmitGate.mustShowAhjPreviewWindow ?? true,
        finalSubmitButtonAloneIsEnough: reviewerReport?.finalSubmitGate.finalSubmitButtonAloneIsEnough ?? false,
        internalFinalReviewPacketRequired: true,
        finalReviewPacketUrl: `/api/projects/${project.id}/reviewer-report?format=html`,
        nextHumanAction:
          "The browser is staged at the final review screen. Verify all fields and uploaded files, handle any MFA or fee payment, then click submit manually. AUTOMATION HAS STOPPED.",
      });
    } catch (err) {
      return fail(`stopAtReview failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // captureSubmissionConfirmation — called after the human clicks submit
  // ---------------------------------------------------------------------------
  async captureSubmissionConfirmation(): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in.");
    try {
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      const url = this.page.url();
      const title = await this.page.title();

      // Extract the record/permit number from the confirmation page
      const bodyText = await this.page.locator("body").innerText();
      const recordMatch = bodyText.match(/Record\s*(?:Number|#|No\.?)[:\s]+([A-Z0-9-]+)/i)
        ?? bodyText.match(/Permit\s*(?:Number|#|No\.?)[:\s]+([A-Z0-9-]+)/i);
      const permitNumber = recordMatch?.[1] ?? null;

      return ok("Confirmation page captured.", {
        url,
        title,
        permitNumber,
      });
    } catch (err) {
      return fail(`captureSubmissionConfirmation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // checkStatus — read-only scrape of "My Records" for the given application numbers.
  // Navigates to the logged-in My Records page, locates the row matching any of the
  // provided record/permit numbers, and extracts the status text. NEVER modifies,
  // clicks submit, or pays anything.
  // ---------------------------------------------------------------------------
  async checkStatus(applicationNumbers: string[]): Promise<string | null> {
    if (!this.page || !applicationNumbers.length) return null;
    try {
      await this.page.goto(`${BASE_URL}/Cap/CapHome.aspx?module=Building&TabName=Building`);
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

      const bodyText = await this.page.locator("body").innerText().catch(() => "");
      // Scan the page text for a row that contains one of the known application numbers.
      // Return a REDACTED, capped snippet (account/meter-like digit runs masked) — never
      // a multi-thousand-char raw portal body dump.
      for (const num of applicationNumbers) {
        if (!num) continue;
        const idx = bodyText.indexOf(num);
        if (idx === -1) continue;
        const snippet = redactStatusText(bodyText.slice(Math.max(0, idx - 80), idx + 320));
        if (snippet) return snippet;
      }
      // Fall back: a short, redacted slice of the My Records page body.
      return redactStatusText(bodyText.slice(0, 600));
    } catch {
      return null;
    }
  }
}
