import path from "node:path";
import type { ProjectRecord, ReviewerReport } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { detectChallengeFrame, redactStatusText, safeAction, sleep } from "../safeAction";
import { fillCustomCombobox } from "../comboboxFill";

// Select a value on a PowerClerk dropdown that may be a native <select> OR a custom
// "Please select..." widget. Native selectOption first; fall back to the open->type->pick
// interaction. Replaces the old `.catch(() => null)` that silently left these fields blank.
async function selectAny(page: any, locator: any, value: string): Promise<void> {
  await locator.selectOption(value)
    .catch(async () => locator.selectOption({ label: value }))
    .catch(async () => { await fillCustomCombobox(page, locator, value); });
}

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

export class PowerClerkAdapter extends BasePortalAdapter {
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
      const opened = await openPortal({
        userDataDir: context.userDataDir,
        storageStatePath: context.storageStatePath,
        // Pass headless through so resolveHeadless picks the server-correct default.
        headless: context.headless,
      });
      this.opened = opened;
      this.page = opened.page;

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
      await this.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
      // Two intro/instruction pages — no data to settle, just advance.
      await this.page.getByRole("button", { name: "Next", exact: true }).click();
      await this.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
      await this.page.getByRole("button", { name: "Next", exact: true }).click();
      await this.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
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
    // Collect REQUIRED-field failures (redacted field-name labels only). A required
    // fill that fails after retries sets ok:false instead of silently passing.
    const requiredFailures: string[] = [];
    const collect = async (label: string, action: () => Promise<void>): Promise<void> => {
      const r = await safeAction(label, action, { required: true });
      if (!r.ok) requiredFailures.push(`${r.field}: ${r.message ?? "failed"}`);
    };

    // Settle the page before advancing. PowerClerk's Vue autosaves each section
    // on blur/change; clicking Next too soon snapshots blank values.
    // 1. Tab-blur commits any focused input into Vue's reactive model.
    // 2. networkidle catches the autosave XHR.
    // 3. A configurable sleep covers slow-network/slow-save edge cases.
    // 4. After clicking Next, another networkidle waits for the next section.
    // 5. URL check: if Next didn't navigate, surface any visible validation text
    //    so the run fails with a meaningful message rather than filling the wrong section.
    const settleAndNext = async (section = "") => {
      await page.keyboard.press("Tab").catch(() => null);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => null);
      await sleep(Number(process.env.POWERCLERK_SETTLE_MS) || 2000);
      const beforeUrl = String(page.url());
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      // If the URL didn't change, Next was blocked by a validation error.
      // Extract visible error text (field names only — never field values).
      const afterUrl = String(page.url());
      // If a challenge appeared after navigation, stop for human immediately.
      const midChallenge = await detectChallengeFrame(page);
      if (midChallenge) {
        throw Object.assign(
          new Error(`PowerClerk MFA/CAPTCHA appeared after ${section || "Next"}: ${midChallenge}`),
          { pauseReason: "mfa_captcha" },
        );
      }
      if (beforeUrl === afterUrl) {
        const errEl = page.locator(
          ".validation-summary-errors,.field-validation-error,[class*=error-message],[class*=alert-danger],[class*=text-danger]"
        ).first();
        const errText = await errEl.isVisible().then(() => errEl.textContent()).catch(() => null);
        const loc = section ? ` (${section})` : "";
        throw new Error(
          `PowerClerk Next click did not advance${loc}${errText ? `: ${errText.trim().slice(0, 120)}` : " — possible validation error or required field missing"}`
        );
      }
    };

    try {
      // Bail immediately if a challenge is already on-screen (e.g. session expired + MFA).
      const initialChallenge = await detectChallengeFrame(page);
      if (initialChallenge) {
        return { ok: false, message: `PowerClerk challenge detected before fill: ${initialChallenge}. Complete verification in the browser, then retry.`, pauseReason: "mfa_captcha" };
      }

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
      // to the first matching field of each kind to stay unambiguous. These are
      // REQUIRED (submitting-party identity) — route through safeAction so a missed
      // fill fails the run instead of submitting a half-populated installer block.
      await collect("installerName", () => page.getByRole("textbox", { name: "Name" }).first().fill(installerFirst));
      await collect("installerLast", () => page.getByRole("textbox", { name: "Last" }).first().fill(installerLast));
      await collect("installerAddress", () => page.getByRole("textbox", { name: "Address", exact: true }).first().fill(installerAddress));
      await collect("installerEmail", () => page.getByRole("textbox", { name: "Email" }).first().fill(installerEmail));
      await collect("installerPhone", () => page.getByRole("textbox", { name: "Phone" }).first().fill(installerPhone));
      await settleAndNext("installer contact");

      // --- Applicant (PGE Customer / homeowner) -----------------------------
      // Scope the whole block to the Applicant group so it never collides with
      // any other contact section rendered on the same page.
      const ownerFull = (project.homeownerName ?? "").trim();
      const ownerFirst = ownerFull.split(/\s+/)[0] ?? "";
      const ownerLast = ownerFull.split(/\s+/).slice(1).join(" ") || ownerFirst;

      const applicant = page.getByRole("group", { name: "Applicant (PGE Customer)" });
      const applicantScope = (await applicant.count()) > 0 ? applicant : page;

      // Applicant identity is REQUIRED — surface failures (field names only; never the
      // owner name / address value itself).
      await collect("applicantName", () => applicantScope.getByRole("textbox", { name: "Name" }).first().fill(ownerFirst));
      await collect("applicantLast", () => applicantScope.getByPlaceholder("Last").first().fill(ownerLast));
      await collect("applicantAddress", () => applicantScope.getByRole("textbox", { name: "Address", exact: true }).first().fill(project.projectAddress ?? ""));
      await collect("applicantCity", () => applicantScope.getByRole("textbox", { name: "City" }).first().fill(project.city ?? ""));
      await collect("applicantState", () => applicantScope.getByLabel("State").first().selectOption(project.state || "OR"));
      await collect("applicantZip", () => applicantScope.getByRole("textbox", { name: "Zip Code" }).first().fill(project.zip ?? ""));

      const ownerPhone = str(s["homeownerPhone"] ?? s["owner_phone"]);
      const ownerEmail = str(s["homeownerEmail"] ?? s["owner_email"]);
      if (ownerPhone) await applicantScope.getByRole("textbox", { name: "Phone" }).first().fill(ownerPhone);
      if (ownerEmail) await applicantScope.getByRole("textbox", { name: "Email" }).first().fill(ownerEmail);
      await settleAndNext("applicant");

      // --- Installer company selection (same authoritative client value) -----
      const installerCompany = installerCompanyName;
      await page.getByLabel("Installer Company").selectOption({ label: installerCompany }).catch(async () => {
        // Fall back to first option if exact label is unavailable
        await page.getByLabel("Installer Company").selectOption({ index: 1 }).catch(() => null);
      });
      await settleAndNext("installer company");

      // --- System / point of interconnection --------------------------------
      const existingContact = str(s["powerclerkExistingContact"] ?? s["existing_contact"]);
      if (existingContact) {
        await page.getByLabel("Existing contact to use for").selectOption(existingContact).catch(() => null);
      }
      await page.getByText("New net metering system at a location currently served by PGE").click().catch(() => null);

      const serviceType = str(s["serviceType"] ?? s["service_type"]) || "Residential";
      await selectAny(page, page.getByLabel("Type").first(), serviceType);
      const schedule = str(s["pgeSchedule"] ?? s["schedule"]) || "7";
      await selectAny(page, page.getByLabel("Schedule").first(), schedule);

      // Account + meter number are REQUIRED to bind the interconnection to the right
      // service point — a missed fill must fail the run, never pass silently.
      await collect("pgeAccountNumber", () => page.getByRole("textbox", { name: "PGE Account Number for point" }).fill(project.accountNumber ?? ""));
      await collect("meterNumber", () => page.getByRole("textbox", { name: "Meter Number" }).fill(project.meterNumber ?? ""));
      await page.getByRole("checkbox", { name: /Click here to confirm/i }).check().catch(() => null);

      // Service configuration
      const phase = str(s["phase"]).toLowerCase();
      if (phase.includes("single") || !phase) {
        await page.getByRole("radio", { name: "Single" }).check().catch(() => null);
      }
      await page.getByRole("radio", { name: "/240" }).check().catch(() => null);

      const serviceRating = str(s["mainServiceRating"] ?? s["main_service_rating"] ?? s["serviceRating"]) || "200";
      await collect("mainServiceRating", () => page.getByRole("textbox", { name: "Main Service Entrance Rating" }).fill(serviceRating));
      await settleAndNext("system / service point");

      // --- Generation: inverter + N PV arrays -------------------------------
      await selectAny(page, page.getByLabel("Energy Source"), "a. Solar");
      await selectAny(page, page.getByLabel("Prime Mover"), "Photovoltaic");
      await selectAny(page, page.getByLabel("Type"), "Static Inverter");

      const hasStorage = String(s["hasBattery"] ?? s["energyStorage"] ?? "").toLowerCase();
      const storageAnswer = hasStorage === "true" || hasStorage === "yes" ? "Yes" : "No";
      await selectAny(page, page.getByLabel("Energy Storage"), storageAnswer);

      // Inverter quantity + manufacturer/model via searchable dropdowns
      const inverterQty = str(s["inverterQuantity"] ?? s["inverter_quantity"]) || "1";
      const inverterManufacturer = str(s["inverterManufacturer"] ?? s["inverter_manufacturer"]);
      const inverterModel = str(s["inverterModel"] ?? s["inverter_model"]);

      await page.locator("#pcInputBase32").fill(inverterQty).catch(() => null);

      if (inverterManufacturer) {
        await this.selectSearchable(inverterManufacturer);
      }
      if (inverterModel) {
        await this.selectSearchable(inverterModel);
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
      await settleAndNext("generation / inverter");

      // --- Aggregation ------------------------------------------------------
      await page.getByRole("radio", { name: "No aggregation" }).check().catch(() => null);
      await page.getByRole("radio", { name: "Yes" }).check().catch(() => null);
      await settleAndNext("aggregation");

      // If any REQUIRED field failed, the form is half-filled — report ok:false with a
      // redacted (field-name-only) message rather than a clean success.
      if (requiredFailures.length > 0) {
        return fail(
          `fillApplication: ${requiredFailures.length} required field(s) could not be filled — manual review required.`,
          { requiredFailures, arrayCount: arrays.length },
        );
      }

      // PII redaction: do NOT return installerCompany (client identity), homeowner
      // name, address, or account/meter numbers in the result payload.
      return ok(`Application filled with ${arrays.length} PV array(s).`, {
        projectId: project.id,
        arrayCount: arrays.length,
      });
    } catch (err) {
      const pauseReason = (err as { pauseReason?: string })?.pauseReason;
      if (pauseReason === "mfa_captcha") {
        return { ok: false, message: err instanceof Error ? err.message : String(err), pauseReason: "mfa_captcha" };
      }
      return fail(`fillApplication failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Selects a value from a PowerClerk searchable "Please select..." dropdown.
  // Clicks the trigger, types the term into the search box, then delegates
  // option picking to fillCustomCombobox (ARIA-role or list-item fallback).
  private async selectSearchable(term: string): Promise<void> {
    const trigger = this.page.getByText("Please select...").first();
    await fillCustomCombobox(this.page, trigger, term);
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
    if (first.moduleModel) await this.selectSearchable(first.moduleModel);
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
  // submitFromReview — POST-APPROVAL only. Called by submitStagedRun() after
  // stopAtReview() has already checked the terms checkbox and positioned the
  // browser at the PowerClerk final review screen. Clicks the Next/Submit
  // button (the final submit on this page) and captures confirmation.
  // NEVER starts a new application, pays fees, or bypasses MFA.
  // ---------------------------------------------------------------------------
  override async submitFromReview(_project: ProjectRecord): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in.");
    const page = this.page;
    try {
      // 1. Assert position: terms checkbox must be present (confirms we are on the
      //    PowerClerk review page, not some other step).
      const termsBox = page.getByRole("checkbox", { name: /Click to Accept Terms/i });
      const termsPresent = (await termsBox.count().catch(() => 0)) > 0;
      if (!termsPresent) {
        return fail("submitFromReview: PowerClerk terms checkbox not found — not on review page. Run stopAtReview() first.");
      }

      // 2. MFA/CAPTCHA pre-check before touching the submit button.
      const preChallenge = await detectChallengeFrame(page);
      if (preChallenge) {
        return { ok: false, message: `submitFromReview: MFA/CAPTCHA detected before submit — pausing for human: ${preChallenge}`, pauseReason: "mfa_captcha" };
      }

      // 3. Ensure terms checkbox is checked (stopAtReview already does this, but
      //    be defensive in case the page reloaded between segments).
      await termsBox.check({ timeout: 8000 }).catch(() => null);

      // 4. Locate the Next/Submit button. On this PowerClerk page "Next" IS the
      //    final submit — clicking it navigates to the confirmation page.
      //    Fee-payment denylist: if the button text mentions pay/fee, refuse.
      const nextBtn = page.getByRole("button", { name: "Next", exact: true })
        .or(page.locator('[type="submit"]'));
      const btnTexts = await nextBtn.allInnerTexts().catch(() => [] as string[]);
      const feeGated = btnTexts.some((t: string) => /pay|fee|payment|checkout/i.test(t));
      if (feeGated) {
        return { ok: false, message: "submitFromReview: PowerClerk submit button appears to trigger fee payment — pausing for human.", pauseReason: "mfa_captcha" };
      }

      // 5. Click Next (final submit).
      const beforeUrl = String(page.url());
      await nextBtn.first().click({ timeout: 15000 });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);

      // 6. Post-click challenge check.
      const postChallenge = await detectChallengeFrame(page);
      if (postChallenge) {
        return { ok: false, message: `submitFromReview: MFA/CAPTCHA appeared after submit click — pausing for human: ${postChallenge}`, pauseReason: "mfa_captcha" };
      }

      // 7. URL should have changed to a confirmation page; if not, surface any
      //    visible validation error.
      const afterUrl = String(page.url());
      if (beforeUrl === afterUrl) {
        const errEl = page.locator(
          ".validation-summary-errors,.field-validation-error,[class*=error-message],[class*=alert-danger],[class*=text-danger]"
        ).first();
        const errText = await errEl.isVisible().then(() => errEl.textContent()).catch(() => null);
        return fail(`submitFromReview: PowerClerk Next click did not navigate to confirmation${errText ? `: ${errText.trim().slice(0, 120)}` : " — possible validation error"}`);
      }

      // 8. Capture confirmation.
      const confirmation = await this.captureSubmissionConfirmation();
      const appNum = String(confirmation.data?.["applicationNumber"] ?? "captured");
      return {
        ok: confirmation.ok,
        message: confirmation.ok
          ? `PowerClerk application submitted. Application: ${appNum}`
          : `submitFromReview: submit appeared to succeed but confirmation capture failed: ${confirmation.message}`,
        data: {
          finalSubmitClicked: true,
          confirmationNumber: appNum,
          ...(confirmation.data ?? {}),
        },
      };
    } catch (err) {
      return fail(`submitFromReview failed: ${err instanceof Error ? err.message : String(err)}`);
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
      // Return a REDACTED, capped snippet (account/meter-like digit runs masked) —
      // never a multi-thousand-char raw portal body dump.
      for (const num of applicationNumbers) {
        if (!num) continue;
        const idx = bodyText.indexOf(num);
        if (idx === -1) continue;
        const snippet = redactStatusText(bodyText.slice(Math.max(0, idx - 80), idx + 320));
        if (snippet) return snippet;
      }
      return redactStatusText(bodyText.slice(0, 600));
    } catch {
      return null;
    }
  }
}
