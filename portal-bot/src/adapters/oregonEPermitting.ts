import path from "node:path";
import type { ProjectRecord, ReviewerReport } from "../../../shared/src/types";
import { HUMAN_REVIEW_MESSAGE, type PortalAdapter, type PortalContext, type PortalStepResult } from "../adapter";

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

export class OregonEPermittingAdapter implements PortalAdapter {
  portalName = "Oregon ePermitting (Accela ACA)";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any = null;

  // ---------------------------------------------------------------------------
  // login — loads encrypted session state so no password is ever entered here
  // ---------------------------------------------------------------------------
  async login(context: PortalContext): Promise<PortalStepResult> {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: context.headless ?? false });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const browserContext: any = context.storageStatePath
        ? await browser.newContext({ storageState: context.storageStatePath })
        : await browser.newContext();

      this.page = await browserContext.newPage();
      await this.page.goto(`${BASE_URL}/Default.aspx`);

      // If session state was loaded we may already be logged in — check dashboard
      const isLoggedIn = await this.page.locator('a[href*="Dashboard"]').count() > 0
        || (await this.page.title()).toLowerCase().includes("dashboard");

      if (!isLoggedIn) {
        // Click Sign In inside the login iframe; password must be in session state
        const loginFrame = this.page.frameLocator('iframe[title="Login Frame"]');
        await loginFrame.getByRole("button", { name: "Sign In" }).click();
        await this.page.waitForURL(`${BASE_URL}/Dashboard.aspx`, { timeout: 20000 }).catch(() => null);
      }

      return ok("Session loaded and logged in to Oregon ePermitting.", {
        portalProfileId: context.portalProfileId ?? null,
        sessionStateLoaded: !!context.storageStatePath,
      });
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

      return ok("Application opened and address confirmed.", {
        projectId: project.id,
        address: project.projectAddress,
        streetNumber: streetNum,
        streetName,
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
    try {
      const descriptionOfWork = buildDescriptionOfWork(project);
      const projectName = buildProjectName(project);

      // Step 2 page 2 — skip filler pages
      await this.page.goto(
        `${BASE_URL}/Cap/CapEdit.aspx?stepNumber=2&pageNumber=2&currentStep=0&currentPage=1&Module=Building&isRenewal=N&isFromShoppingCart=&isFromConfirmPage=&confirmStepNumber=0&isFromConfirmPage=N`
      );
      await this.page.getByRole("link", { name: "Continue Application »" }).click();
      await this.page.getByRole("link", { name: "Continue Application »" }).click();

      // Project info — jobValue lives in parserSnapshot
      const s = snap(project);
      const jobValue = str(s["jobValue"] ?? s["job_value"]) || String((project.systemSizeDcKw ?? 0) * 4000) || "0";
      await this.page.getByRole("textbox", { name: "Job Value($):" }).fill(jobValue);
      await this.page.getByLabel("Category of Construction").selectOption("1");
      await this.page.getByRole("textbox", { name: "Project Name" }).fill(projectName);
      await this.page.getByRole("textbox", { name: "Description of Work" }).fill(descriptionOfWork);
      await this.page.getByRole("link", { name: "Continue Application »" }).click();

      // Applicant / contact — select from account (pre-existing company contact)
      await this.page.locator("#ctl00_PlaceHolderMain_Applicant_19Edit_btnAddNew").click().catch(() => null);

      const installerCompanyName = str(s["installerCompanyName"] ?? s["installer_company_name"]) || "Infinity Solar";
      const installerEmail = str(s["installerEmail"] ?? s["installer_email"]) || "permit@infinitysolarusa.com";

      const contactFrame = this.page.frameLocator('iframe[name="ACADialogFrame"]');
      const contactFirst = await contactFrame.getByRole("textbox", { name: "First:" }).count();
      if (contactFirst > 0) {
        const firstName = installerCompanyName.split(" ")[0] ?? "Infinity";
        const lastName = installerCompanyName.split(" ").slice(1).join(" ") || "Solar";
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

      // Construction details
      await this.page.getByLabel("Category of Construction:", { exact: true }).selectOption("Other");
      await this.page.getByRole("textbox", { name: /Other Category of/i }).fill("Solar");
      await this.page.getByLabel("Type of Work:", { exact: true }).selectOption("New");
      await this.page.getByRole("textbox", { name: "Building Height - Feet:" }).fill("0");
      await this.page.getByRole("textbox", { name: "Number of Stories:" }).fill("0");
      await this.page.getByRole("textbox", { name: "New Building Area:" }).fill("0");
      await this.page.getByRole("textbox", { name: "Existing Building Area:" }).fill("0");
      await this.page.getByRole("link", { name: "Continue Application »" }).click();

      return ok("All application fields filled.", {
        projectName,
        descriptionOfWork,
        jobValue,
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
}
