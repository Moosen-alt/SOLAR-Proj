import path from "node:path";
import type { ProjectRecord, ReviewerReport } from "../../../shared/src/types";
import { HUMAN_REVIEW_MESSAGE, type PortalAdapter, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";

// PowerClerk (PGE Net Metering) adapter
// Built from an operator codegen recording captured up to the final submit page.
// SECURITY: This adapter NEVER clicks final submit, pays fees, solves CAPTCHA, or
// handles MFA. Credentials are never hardcoded — login uses encrypted session state.

const PGE_LOGIN_URL = "https://pgenm.powerclerk.com/MvcAccount/Login";

function ok(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: true, message, data };
}

function fail(message: string, data: Record<string, unknown> = {}): PortalStepResult {
  return { ok: false, message, data };
}

function snap(project: ProjectRecord): Record<string, unknown> {
  return (project.parserSnapshot ?? {}) as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

interface PvArray {
  quantity: string;
  moduleManufacturer: string;
  moduleModel: string;
  tilt: string;
  azimuth: string;
}

// Reads PV arrays from the parser snapshot. Supports an explicit `pvArrays`
// array, or falls back to a single array built from flat module fields.
// Handles any number of arrays.
function readArrays(project: ProjectRecord): PvArray[] {
  const s = snap(project);
  const raw = s["pvArrays"] ?? s["pv_arrays"] ?? s["arrays"];

  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((entry) => {
      const a = (entry ?? {}) as Record<string, unknown>;
      return {
        quantity: str(a["quantity"] ?? a["qty"] ?? a["moduleQuantity"]),
        moduleManufacturer: str(a["moduleManufacturer"] ?? a["manufacturer"] ?? a["module_manufacturer"]),
        moduleModel: str(a["moduleModel"] ?? a["model"] ?? a["module_model"]),
        tilt: str(a["tilt"]),
        azimuth: str(a["azimuth"]),
      };
    });
  }

  // Fallback: single array from flat fields
  const single: PvArray = {
    quantity: str(s["moduleQuantity"] ?? s["module_quantity"]),
    moduleManufacturer: str(s["moduleManufacturer"] ?? s["module_manufacturer"]),
    moduleModel: str(s["moduleModel"] ?? s["module_model"]),
    tilt: str(s["tilt"]),
    azimuth: str(s["azimuth"]),
  };
  return single.quantity || single.moduleModel ? [single] : [];
}

export class PowerClerkAdapter implements PortalAdapter {
  portalName = "PowerClerk (PGE Net Metering)";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any = null;

  // ---------------------------------------------------------------------------
  // login — uses a persistent browser profile (userDataDir) so the login
  // survives across runs without re-entering credentials. Falls back to a
  // storage-state snapshot if userDataDir is not set.
  // ---------------------------------------------------------------------------
  async login(context: PortalContext): Promise<PortalStepResult> {
    try {
      const { page } = await openPortal({
        userDataDir: context.userDataDir,
        storageStatePath: context.storageStatePath,
        headless: context.headless ?? false,
      });
      this.page = page;

      await this.page.goto(PGE_LOGIN_URL);
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

      const loginVisible = await this.page.getByRole("button", { name: "Log In" }).count();
      if (loginVisible > 0) {
        if (context.credential) {
          // Session expired — auto-fill the login form with stored credentials.
          try {
            await this.page.getByLabel(/email|username/i).fill(context.credential.username);
            await this.page.getByLabel(/password/i).fill(context.credential.password);
            await this.page.getByRole("button", { name: "Log In" }).click();
            await this.page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);

            const mfaVisible = await this.page.getByText(/verify|two.factor|authenticat/i).count() > 0;
            if (mfaVisible) {
              return { ok: false, message: "MFA/2FA required after credential fill — pausing for human. Complete verification in the browser window, then retry the portal run.", pauseReason: "mfa_captcha" };
            }
            const stillVisible = await this.page.getByRole("button", { name: "Log In" }).count();
            if (stillVisible > 0) {
              return fail("Credential auto-fill did not result in a successful login. Check the stored username/password in Portal Credentials.");
            }
          } catch (fillErr) {
            return fail(`Credential auto-fill failed: ${fillErr instanceof Error ? fillErr.message : String(fillErr)}`);
          }
        } else {
          return fail(
            "PowerClerk login form is still visible. Log in manually in the browser window, then re-run. For a persistent login, use: npm run portal:login -- powerclerk"
          );
        }
      }

      return ok("Logged in to PowerClerk (PGE).", { portalProfileId: context.portalProfileId ?? null });
    } catch (err) {
      return fail(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // openSubmission — start a New Net Metering Application
  // ---------------------------------------------------------------------------
  async openSubmission(project: ProjectRecord): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in. Call login() first.");
    try {
      await this.page.getByRole("button", { name: "New Net Metering Application" }).click();
      // Two intro/instruction pages
      await this.page.getByRole("button", { name: "Next", exact: true }).click();
      await this.page.getByRole("button", { name: "Next", exact: true }).click();
      return ok("New Net Metering Application started.", { projectId: project.id });
    } catch (err) {
      return fail(`openSubmission failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // fillApplication — fills contact, applicant, system, inverter, and N arrays
  // ---------------------------------------------------------------------------
  async fillApplication(project: ProjectRecord): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in. Call login() first.");
    const page = this.page;
    try {
      const s = snap(project);

      // --- Submitting party / installer contact (from the assigned client overlay) ---
      // NEVER hardcode contractor identity. clientStagingOverlay populates these from
      // the project's assigned client (prepareSubmission guarantees clientId + CCB), so
      // they must be present. The guard below refuses to fill the block with blank or
      // default info — so we can never submit another client's or a default contractor's
      // identity to the utility.
      const installerCompanyName = str(s["installerCompanyName"] ?? s["installer_company_name"]);
      const installerEmail = str(s["installerEmail"] ?? s["installer_email"]);
      const installerPhone = str(s["installerPhone"] ?? s["installer_phone"]);
      const installerAddress = str(s["installerAddress"] ?? s["installer_address"] ?? s["installerStreet"] ?? s["installer_street"]);
      const installerContact = str(s["installerContactName"] ?? s["installer_contact_name"]);
      const installerFirst = installerContact.split(/\s+/)[0] ?? "";
      const installerLast = installerContact.split(/\s+/).slice(1).join(" ") || installerFirst;
      if (!installerCompanyName || !installerEmail) {
        throw new Error(
          "PowerClerk: refusing to fill the installer block — no submitting-client company/email on the staging overlay. Assign a client with full licensing before staging.",
        );
      }

      // The page may render multiple contact sections; pin the installer block
      // to the first matching field of each kind to stay unambiguous.
      await page.getByRole("textbox", { name: "Name" }).first().fill(installerFirst);
      await page.getByRole("textbox", { name: "Last" }).first().fill(installerLast);
      await page.getByRole("textbox", { name: "Address", exact: true }).first().fill(installerAddress);
      await page.getByRole("textbox", { name: "Email" }).first().fill(installerEmail);
      await page.getByRole("textbox", { name: "Phone" }).first().fill(installerPhone);
      await page.getByRole("button", { name: "Next", exact: true }).click();

      // --- Applicant (PGE Customer / homeowner) -----------------------------
      // Scope the whole block to the Applicant group so it never collides with
      // any other contact section rendered on the same page.
      const ownerFull = (project.homeownerName ?? "").trim();
      const ownerFirst = ownerFull.split(/\s+/)[0] ?? "";
      const ownerLast = ownerFull.split(/\s+/).slice(1).join(" ") || ownerFirst;

      const applicant = page.getByRole("group", { name: "Applicant (PGE Customer)" });
      const applicantScope = (await applicant.count()) > 0 ? applicant : page;

      await applicantScope.getByRole("textbox", { name: "Name" }).first().fill(ownerFirst);
      await applicantScope.getByPlaceholder("Last").first().fill(ownerLast);
      await applicantScope.getByRole("textbox", { name: "Address", exact: true }).first().fill(project.projectAddress ?? "");
      await applicantScope.getByRole("textbox", { name: "City" }).first().fill(project.city ?? "");
      await applicantScope.getByLabel("State").first().selectOption(project.state || "OR");
      await applicantScope.getByRole("textbox", { name: "Zip Code" }).first().fill(project.zip ?? "");

      const ownerPhone = str(s["homeownerPhone"] ?? s["owner_phone"]);
      const ownerEmail = str(s["homeownerEmail"] ?? s["owner_email"]);
      if (ownerPhone) await applicantScope.getByRole("textbox", { name: "Phone" }).first().fill(ownerPhone);
      if (ownerEmail) await applicantScope.getByRole("textbox", { name: "Email" }).first().fill(ownerEmail);
      await page.getByRole("button", { name: "Next", exact: true }).click();

      // --- Installer company selection (same authoritative client value) -----
      const installerCompany = installerCompanyName;
      await page.getByLabel("Installer Company").selectOption({ label: installerCompany }).catch(async () => {
        // Fall back to first option if exact label is unavailable
        await page.getByLabel("Installer Company").selectOption({ index: 1 }).catch(() => null);
      });
      await page.getByRole("button", { name: "Next", exact: true }).click();

      // --- System / point of interconnection --------------------------------
      const existingContact = str(s["powerclerkExistingContact"] ?? s["existing_contact"]);
      if (existingContact) {
        await page.getByLabel("Existing contact to use for").selectOption(existingContact).catch(() => null);
      }
      await page.getByText("New net metering system at a location currently served by PGE").click().catch(() => null);

      const serviceType = str(s["serviceType"] ?? s["service_type"]) || "Residential";
      await page.getByLabel("Type").first().selectOption(serviceType).catch(() => null);
      const schedule = str(s["pgeSchedule"] ?? s["schedule"]) || "7";
      await page.getByLabel("Schedule").first().selectOption(schedule).catch(() => null);

      await page.getByRole("textbox", { name: "PGE Account Number for point" }).fill(project.accountNumber ?? "");
      await page.getByRole("textbox", { name: "Meter Number" }).fill(project.meterNumber ?? "");
      await page.getByRole("checkbox", { name: /Click here to confirm/i }).check().catch(() => null);

      // Service configuration
      const phase = str(s["phase"]).toLowerCase();
      if (phase.includes("single") || !phase) {
        await page.getByRole("radio", { name: "Single" }).check().catch(() => null);
      }
      await page.getByRole("radio", { name: "/240" }).check().catch(() => null);

      const serviceRating = str(s["mainServiceRating"] ?? s["main_service_rating"] ?? s["serviceRating"]) || "200";
      await page.getByRole("textbox", { name: "Main Service Entrance Rating" }).fill(serviceRating);
      await page.getByRole("button", { name: "Next", exact: true }).click();

      // --- Generation: inverter + N PV arrays -------------------------------
      await page.getByLabel("Energy Source").selectOption("a. Solar").catch(() => null);
      await page.getByLabel("Prime Mover").selectOption("Photovoltaic").catch(() => null);
      await page.getByLabel("Type").selectOption("Static Inverter").catch(() => null);

      const hasStorage = String(s["hasBattery"] ?? s["energyStorage"] ?? "").toLowerCase();
      const storageAnswer = hasStorage === "true" || hasStorage === "yes" ? "Yes" : "No";
      await page.getByLabel("Energy Storage").selectOption(storageAnswer).catch(() => null);

      // Inverter quantity + manufacturer/model via searchable dropdowns
      const inverterQty = str(s["inverterQuantity"] ?? s["inverter_quantity"]) || "1";
      const inverterManufacturer = str(s["inverterManufacturer"] ?? s["inverter_manufacturer"]);
      const inverterModel = str(s["inverterModel"] ?? s["inverter_model"]);

      await page.locator("#pcInputBase32").fill(inverterQty).catch(() => null);

      if (inverterManufacturer) {
        await this.selectSearchable(inverterManufacturer);
      }
      if (inverterModel) {
        await this.selectSearchable(inverterModel, true);
      }

      // PV arrays — fill the first, clone for each additional array
      const arrays = readArrays(project);
      await this.fillArrays(arrays);

      // Recalculate totals after all arrays are entered
      await page.getByRole("button", { name: "Calculate" }).click().catch(() => null);

      // Export limiting / disconnect proximity (defaults match common residential)
      const limitExport = String(s["limitExport"] ?? "").toLowerCase() === "true" ? "Yes" : "No";
      await page.getByRole("group", { name: /Do you propose to limit/i }).getByLabel(limitExport).check().catch(() => null);
      await page.getByRole("group", { name: /Is your disconnect within 10/i }).getByLabel("Yes").check().catch(() => null);
      await page.getByRole("button", { name: "Next", exact: true }).click();

      // --- Aggregation ------------------------------------------------------
      await page.getByRole("radio", { name: "No aggregation" }).check().catch(() => null);
      await page.getByRole("radio", { name: "Yes" }).check().catch(() => null);
      await page.getByRole("button", { name: "Next", exact: true }).click();

      return ok(`Application filled with ${arrays.length} PV array(s).`, {
        projectId: project.id,
        arrayCount: arrays.length,
        installerCompany,
        accountNumber: "REDACTED",
      });
    } catch (err) {
      return fail(`fillApplication failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Selects a value from a PowerClerk searchable "Please select..." dropdown.
  // When `isModel` is true it matches the option containing the term anywhere
  // (model rows include extra wattage/voltage text).
  private async selectSearchable(term: string, isModel = false): Promise<void> {
    const page = this.page;
    await page.getByText("Please select...").first().click();
    await page.getByRole("combobox", { name: "search term" }).fill(term);
    if (isModel) {
      await page.getByText(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).first().click();
    } else {
      // Exact manufacturer label
      await page.locator("div").filter({ hasText: new RegExp(`^${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).nth(4).click();
    }
  }

  // Fills the first PV array, then clones and fills each additional array.
  private async fillArrays(arrays: PvArray[]): Promise<void> {
    const page = this.page;
    if (arrays.length === 0) return;

    // First array — uses the labelled placeholders within the PV Array group
    const first = arrays[0];
    const firstGroup = page.getByRole("group", { name: "PV Array Delete Array" }).first();
    await firstGroup.getByPlaceholder("Qty").fill(first.quantity).catch(() => null);
    if (first.moduleManufacturer) await this.selectSearchable(first.moduleManufacturer);
    if (first.moduleModel) await this.selectSearchable(first.moduleModel, true);
    await page.getByRole("textbox", { name: "Tilt" }).first().fill(first.tilt).catch(() => null);
    await page.getByRole("textbox", { name: "Azimuth" }).first().fill(first.azimuth).catch(() => null);

    // Additional arrays — clone the first array block and fill the new group
    for (let i = 1; i < arrays.length; i++) {
      const arr = arrays[i];
      await page.locator("#pvSystemPvModule1").getByRole("button", { name: "Clone" }).click().catch(() => null);
      await page.waitForTimeout(500).catch(() => null);

      const groups = page.getByRole("group", { name: "PV Array Delete Array" });
      const group = groups.nth(i);
      await group.getByPlaceholder("Qty").fill(arr.quantity).catch(() => null);
      // Searchable selects inside the cloned group
      if (arr.moduleManufacturer) {
        await group.getByText("Please select...").first().click().catch(() => null);
        await page.getByRole("combobox", { name: "search term" }).fill(arr.moduleManufacturer).catch(() => null);
        await page.locator("div").filter({ hasText: new RegExp(`^${arr.moduleManufacturer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).nth(4).click().catch(() => null);
      }
      if (arr.moduleModel) {
        await group.getByText("Please select...").first().click().catch(() => null);
        await page.getByRole("combobox", { name: "search term" }).fill(arr.moduleModel).catch(() => null);
        await page.getByText(new RegExp(arr.moduleModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).first().click().catch(() => null);
      }
      await group.getByRole("textbox", { name: "Tilt" }).fill(arr.tilt).catch(() => null);
      await group.getByRole("textbox", { name: "Azimuth" }).fill(arr.azimuth).catch(() => null);
    }
  }

  // ---------------------------------------------------------------------------
  // uploadFiles — attaches SLD, site plan, and inverter spec by document slot
  // ---------------------------------------------------------------------------
  async uploadFiles(_project: ProjectRecord, files: string[]): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in. Call login() first.");
    const page = this.page;
    const uploaded: string[] = [];

    try {
      // The document step has labelled file inputs. Classify each file by name.
      const byKeyword = (keywords: string[]): string | undefined =>
        files.find((f) => keywords.some((k) => path.basename(f).toLowerCase().includes(k)));

      const sld = byKeyword(["sld", "3-line", "one-line", "one line", "3 line", "single line"]);
      const sitePlan = byKeyword(["site", "plot", "plan"]);
      const inverterSpec = byKeyword(["inverter", "spec"]);

      if (sld) {
        await page.getByLabel("One-Line Electrical Diagram").setInputFiles(sld);
        uploaded.push(path.basename(sld));
      }
      if (sitePlan) {
        await page.getByLabel("Site Plan", { exact: true }).setInputFiles(sitePlan);
        uploaded.push(path.basename(sitePlan));
      }
      if (inverterSpec) {
        await page.getByLabel("Inverter Technical").setInputFiles(inverterSpec);
        uploaded.push(path.basename(inverterSpec));
      }

      await page.getByRole("button", { name: "Next" }).click().catch(() => null);

      return ok(`Uploaded ${uploaded.length} document(s).`, { uploaded });
    } catch (err) {
      return fail(`uploadFiles failed: ${err instanceof Error ? err.message : String(err)}`, { uploaded });
    }
  }

  // ---------------------------------------------------------------------------
  // stopAtReview — checks terms acceptance box and STOPS before final submit.
  // AUTOMATION MUST NEVER CLICK FINAL SUBMIT.
  // ---------------------------------------------------------------------------
  async stopAtReview(project: ProjectRecord, reviewerReport?: ReviewerReport): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in. Call login() first.");
    try {
      // The terms checkbox is part of the review acknowledgement, not the submit
      // action itself. A human still verifies everything and clicks submit.
      await this.page.getByRole("checkbox", { name: /Click to Accept Terms/i }).check().catch(() => null);

      const blockerCount = reviewerReport?.findings.filter((f) => f.severity === "blocker").length ?? 0;

      return ok(HUMAN_REVIEW_MESSAGE, {
        projectId: project.id,
        portalReviewUrl: this.page.url(),
        blockerCount,
        ahjPreviewVisibleRequired: reviewerReport?.finalSubmitGate.mustShowAhjPreviewWindow ?? true,
        finalSubmitButtonAloneIsEnough: reviewerReport?.finalSubmitGate.finalSubmitButtonAloneIsEnough ?? false,
        internalFinalReviewPacketRequired: true,
        finalReviewPacketUrl: `/api/projects/${project.id}/reviewer-report?format=html`,
        nextHumanAction:
          "The browser is staged at the PowerClerk final review screen with terms accepted. Verify all fields, arrays, and attachments, then click Submit manually. AUTOMATION HAS STOPPED.",
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
      const bodyText = await this.page.locator("body").innerText();
      const match = bodyText.match(/Application\s*(?:Number|#|ID)[:\s]+([A-Z0-9-]+)/i)
        ?? bodyText.match(/Confirmation[:\s]+([A-Z0-9-]+)/i);
      return ok("PowerClerk confirmation captured.", {
        url: this.page.url(),
        applicationNumber: match?.[1] ?? null,
      });
    } catch (err) {
      return fail(`captureSubmissionConfirmation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // checkStatus — read-only scrape of the PowerClerk "My Applications" dashboard
  // for any of the provided application numbers. NEVER modifies, clicks submit,
  // or pays anything.
  // ---------------------------------------------------------------------------
  async checkStatus(applicationNumbers: string[]): Promise<string | null> {
    if (!this.page || !applicationNumbers.length) return null;
    try {
      // Navigate to the applications list (the home page after login).
      await this.page.goto("https://pgenm.powerclerk.com/MvcApplication/Index");
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
}
