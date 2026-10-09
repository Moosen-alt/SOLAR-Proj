import path from "node:path";
import type { ProjectRecord, ReviewerReport } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, ok, fail, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { detectChallengeFrame, scanStatusFromBody, safeAction } from "../safeAction";
import { snap, str, num } from "../snapshot";
import { batteryStatus, isPlaceholderBatteryModel } from "../../../shared/src/batteryControls";
import { scrapeReviewScreen, compareReviewFields } from "../reviewScreenScraper";

// Oregon ePermitting (Accela ACA) adapter
// Codegen recording captured by operator up to the review page.
// SECURITY: This adapter NEVER clicks final submit, pays fees, solves CAPTCHA, or handles MFA.
// The human must perform those actions after reviewing the staged package.

const BASE_URL = "https://aca-oregon.accela.com/oregon";

export function buildDescriptionOfWork(project: ProjectRecord): string {
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

  // THE ONE BATTERY PREDICATE (shared batteryControls, #246): a placeholder model ("N/A") is not
  // storage, so this never prints "Battery / ESS scope includes N/A." on a PV-only filing.
  if (batteryStatus(s) === "yes") {
    const model = isPlaceholderBatteryModel(batteryModel) ? "" : batteryModel;
    const battery = [batteryQty ? String(batteryQty) : "", model, essKwh ? `(${essKwh} kWh)` : ""].filter(Boolean).join(" ");
    parts.push(`Battery / ESS scope includes ${battery || "battery storage"}.`);
  }

  return parts.join("\n") || "Solar PV system installation.";
}

function buildProjectName(project: ProjectRecord): string {
  return project.homeownerName || project.projectAddress || "Solar PV Project";
}

// Street parsing moved to ../addressParse.ts (pure, browser-free) so the backend's
// resolveRecipeFieldValues can bind the same values at replay. Re-exported here for
// existing importers.
import { parseStreetNumber, parseStreetName, parseStreetDirection } from "../addressParse";
export { parseStreetNumber, parseStreetName, parseStreetDirection };

// The address-version ranking moved to ../addressVersion.ts so the AUTO-LEARN engine can use
// it too — auto-learn outranks this adapter in the staging precedence, so discipline that
// lives only here never runs. Re-exported: addressVersion.test.ts imports it from this path.
import { rankAddressVersions } from "../addressVersion";
export { rankAddressVersions };
export type { AddressVersion } from "../addressVersion";

export class OregonEPermittingAdapter extends BasePortalAdapter {
  portalName = "Oregon ePermitting (Accela ACA)";
  /** The per-job lookup's issuing agency for this track (runAdapter → setIssuingAgency). */
  private issuingAgency: string | null = null;
  setIssuingAgency(name: string | null): void {
    this.issuingAgency = String(name ?? "").trim() || null;
  }

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

      // Log in via the shared, portal-agnostic flow. It is FRAME-AWARE — Accela ACA renders
      // its login form (#username / #passwordRequired / "SIGN IN") inside an AngularUI iframe,
      // which the old getByLabel("Email") path on the main document could never see. It also
      // handles the "reveal login" link pattern and stops on MFA. Never logs the credential.
      const { performLogin } = await import("./loginFlow");
      const result = await performLogin(this.page, context.credential);
      if (result.status === "logged_in" || result.status === "already_authenticated") {
        return ok(`Logged in to Oregon ePermitting. ${result.message}`, { portalProfileId: context.portalProfileId ?? null });
      }
      if (result.status === "mfa_captcha") {
        return { ok: false, message: result.message, pauseReason: "mfa_captcha" };
      }
      if (result.status === "no_credential") {
        return fail("Oregon ePermitting is showing a login form but no stored credential was found for this client/portal. Add the portal username + password under the client's logins, then retry.");
      }
      return fail(`Oregon ePermitting login failed: ${result.message}`);
    } catch (err) {
      return fail(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // openSubmission — clicks "Building Dept Application" and accepts disclaimer
  // ---------------------------------------------------------------------------

  // "Continue Application »" renders as an <a> on some Accela layouts and as a
  // BUTTON/submit-input on others (live-tested: the Building disclaimer page's
  // teal button is not a link, so a link-role click times out and the run stalls
  // on the terms page with the checkbox already ticked). Pre-application
  // navigation — never a final submit, which is always a human.
  private continueApplicationLocator() {
    if (!this.page) throw new Error("no page");
    return this.page
      .locator('a:has-text("Continue Application"), button:has-text("Continue Application"), input[type="submit"][value*="Continue Application" i]')
      .first();
  }

  private async clickContinueApplication(timeout = 10000): Promise<void> {
    await this.continueApplicationLocator().click({ timeout });
  }

  async openSubmission(project: ProjectRecord): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in. Call login() first.");
    try {
      // Go straight to the Building disclaimer page. The dashboard "Building Dept
      // Application" link is a HIDDEN quick-link (not actionable); its href is this URL, so
      // navigating directly is more robust than clicking the hidden anchor.
      await this.page.goto(`${BASE_URL}/Cap/CapApplyDisclaimer.aspx?module=Building`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      // Accept the disclaimer (checkbox id is termAccept on the current layout) and continue.
      await this.page.getByRole("checkbox", { name: /I have read and agree/i }).check({ timeout: 10000 })
        .catch(async () => { await this.page.locator('input[id$="termAccept"]').first().check({ timeout: 8000 }); });
      await this.clickContinueApplication(10000);
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

      // Step 1: Work-site address search, then pick the right version of the address.
      //
      // One street address is listed once per issuing jurisdiction ("City Applications",
      // "COUNTY APPLICATIONS", "DEQ Applications") and the permit types on offer differ per
      // row — operator-confirmed: city may hold structural while county holds electrical, but
      // either can hold BOTH, so jurisdiction alone cannot decide. Accela's own instructions
      // give the algorithm: "try selecting each version of your address until you find the
      // permit type that you are looking for."
      //
      // Each attempt RE-RUNS the search. Accela is ASP.NET postback: once a row is selected
      // the results grid is gone, its row locators are stale, and goBack() does not bring it
      // back — so a retry that relies on the back button wedges on the first wrong row (live:
      // it selected DEQ Applications, which issues nothing, and stopped there). Re-searching
      // and re-matching the row by its TEXT is the only stable way to try the next one.
      const isElectrical = /elec/i.test(project.permitType ?? "");
      const appTypePattern = isElectrical
        ? /Residential\s*-?\s*Electrical/i
        : /Residential\s*-?\s*Structural/i;
      const zip = (project.zip || "").trim();

      const selectRows = () => this.page.locator("tr").filter({ has: this.page.locator('a:has-text("Select")') });

      const runSearch = async (): Promise<void> => {
        await this.page.goto(`${BASE_URL}/Cap/CapApplyDisclaimer.aspx?module=Building`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
        await this.page.getByRole("checkbox", { name: /I have read and agree/i }).check({ timeout: 10000 })
          .catch(async () => { await this.page.locator('input[id$="termAccept"]').first().check({ timeout: 8000 }); });
        await this.clickContinueApplication(10000);
        await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
        await this.page.locator('input[id*="StreetNo4Search"]').first().fill(streetNum, { timeout: 10000 });
        await this.page.locator('input[id$="txtStreetName"]').first().fill(streetName, { timeout: 10000 });
        if (streetDir) {
          await this.page.locator('select[id$="ddlStreetDirection"]').first().selectOption(streetDir).catch(() => null);
        }
        await this.page.locator('a[id$="WorkLocationEdit_btnSearch"]').first().click({ timeout: 10000 });
        await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      };

      const streetNum = parseStreetNumber(project.projectAddress ?? "");
      const streetName = parseStreetName(project.projectAddress ?? "");
      const streetDir = parseStreetDirection(project.projectAddress ?? "");
      await runSearch();

      const rows0 = selectRows();
      const rowCount = Math.min(await rows0.count().catch(() => 0), 8);
      if (rowCount === 0) return fail("openSubmission: the address search returned no selectable rows.");

      // ONLY VERSIONS OF *THIS* PROPERTY ARE CANDIDATES. Accela's street search is loose —
      // "119 7th" also returns Milton Freewater, Portland and Corvallis — and trying every row
      // until one offers the permit would open an application against a house in another city.
      const rowTexts: string[] = [];
      for (let i = 0; i < rowCount; i++) {
        rowTexts.push(((await rows0.nth(i).innerText().catch(() => "")) || ""));
      }
      // The looked-up issuing agency decides the row when known (addressVersion — one predicate
      // with the learner and the replay); the discipline convention otherwise.
      const { ranked, rejected, preference } = rankAddressVersions(rowTexts, {
        city: project.city, zip, homeownerName: project.homeownerName, isElectrical, issuingAgency: this.issuingAgency,
      });
      if (ranked.length === 0) {
        return fail(`openSubmission: none of the ${rowCount} address result(s) are in `
          + `${project.city || "(no city)"} ${zip}. Refusing to open an application against another property. `
          + `Rows seen: ${rejected.slice(0, 4).join(" | ")}`);
      }
      if (preference.contradicts) {
        return fail(`openSubmission: ${preference.note} — refusing to open an application with the wrong agency.`);
      }

      let chosen: { text: string; offered: string[]; ownerHit: boolean } | null = null;
      const offeredSeen: string[] = [];
      for (let attempt = 0; attempt < ranked.length; attempt++) {
        const cand = ranked[attempt];
        if (attempt > 0) await runSearch(); // the grid is gone after a Select — rebuild it
        const row = selectRows().nth(cand.index);
        if (!(await row.count().catch(() => 0))) continue;
        await row.locator('a:has-text("Select")').first().click({ timeout: 15000 }).catch(() => null);
        await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
        // THE SERVICE LIST ARRIVES ON A POSTBACK, NOT WITH THE CLICK. Reading the checkboxes
        // immediately finds none and condemns a perfectly good version as "does not offer the
        // permit" — live, that walked past County (which does offer it) and left the run on
        // "No Building services were returned for this address". count() does not auto-wait,
        // so wait for the list explicitly. Absent after this, the version genuinely has none.
        await this.page.locator('input[type="checkbox"]').first()
          .waitFor({ state: "visible", timeout: 12000 }).catch(() => null);
        await this.page.waitForTimeout(800);

        const offered = await this.page.evaluate(() => Array.from(document.querySelectorAll('input[type="checkbox"]'))
          .map((cb) => {
            const id = cb.getAttribute("id") || "";
            const lab = id ? document.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`) : null;
            return ((lab as HTMLElement | null)?.innerText || (cb.closest("label") as HTMLElement | null)?.innerText || "")
              .replace(/\s+/g, " ").trim();
          })
          .filter((t) => t.length > 0)).catch(() => [] as string[]);
        for (const o of offered) if (!offeredSeen.includes(o)) offeredSeen.push(o);

        const match = this.page.getByRole("checkbox", { name: appTypePattern });
        if ((await match.count().catch(() => 0)) > 0) {
          await match.first().check({ timeout: 10000 });
          chosen = { text: cand.text, offered, ownerHit: cand.ownerHit };
          break;
        }
        // Wrong version. NEVER fall back to "check the first checkbox" — that is how a
        // Commercial or Mechanical permit gets filed under a residential solar job.
      }

      if (!chosen) {
        return fail(`openSubmission: none of the ${rowCount} address version(s) offered a `
          + `"${isElectrical ? "Residential - Electrical" : "Residential - Structural"}" permit. `
          + `Types seen: ${offeredSeen.slice(0, 10).join("; ") || "(none)"}.`);
      }
      await this.clickContinueApplication(10000);

      // PII redaction: do NOT return the street number/name/full address — only a
      // boolean confirming the address search resolved, plus the permit discipline chosen.
      return ok(`Application opened (${isElectrical ? "electrical" : "structural"}) and address confirmed.`, {
        projectId: project.id,
        addressResolved: Boolean(streetNum || streetName),
        permitDiscipline: isElectrical ? "electrical" : "structural",
        // Which address version won, and how many were tried before it — the audit trail for
        // "did we file against the right parcel?". Jurisdiction words only, never the address.
        addressVersionsTried: ranked.length,
        jurisdictionChosen: (chosen.text.match(/(CITY|COUNTY|DEQ)\s+APPLICATIONS/i) || [])[0] || "unlabelled",
        // False here means we filed against a parcel whose owner of record is NOT the
        // homeowner. Legitimate for a recent sale or a renter, and a wrong-parcel filing
        // otherwise — either way a human must see it, so it rides out on the step result.
        ownerOfRecordMatched: chosen.ownerHit,
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
    // Field names (non-PII) whose post-fill read-back did not match what we tried to
    // fill — a strong signal the portal silently dropped or overwrote the value.
    const readbackMismatches: string[] = [];
    const collect = async (
      label: string,
      action: () => Promise<void>,
      required = true,
      readback?: () => Promise<string>,
      expected?: string,
    ): Promise<void> => {
      const r = await safeAction(label, action, { required, readback, expected });
      if (!r.ok) requiredFailures.push(`${r.field}: ${r.message ?? "failed"}`);
      if (r.readbackMismatch) readbackMismatches.push(r.field);
    };

    // After a Continue click, detect Accela's "Message Bar" validation error and
    // return the (redacted) text so the caller can surface a useful failure message.
    const checkMessageBar = async (): Promise<string | null> => {
      try {
        const bar = this.page.locator(
          ".message-bar,.MessageBar,[id*=MessageBar],[class*=msgBar],.acc-error-bar,.validation-summary"
        );
        if ((await bar.count()) === 0) return null;
        const visible = await bar.first().isVisible().catch(() => false);
        if (!visible) return null;
        const text = (await bar.first().innerText().catch(() => "")).trim().slice(0, 200);
        return text || "validation error";
      } catch { return null; }
    };

    // Click Continue, wait for navigation, and check for blocking message bars.
    // Returns null on success, or a short error string if the page shows a validation error.
    const continueAndCheck = async (label: string): Promise<string | null> => {
      // LLM-assisted gap-fill: after the fixed-selector fills, let the planner fill any
      // REQUIRED field still empty on THIS page — from real project data only. No-op unless
      // the staging runner enabled it; best-effort, never throws.
      await this.runGapFill(this.page);
      const preUrl = String(this.page.url());
      const cont = this.continueApplicationLocator();
      if ((await cont.count()) === 0) return `${label}: Continue link not found on page`;
      await cont.click({ timeout: 15000 });
      await this.page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => null);
      const postUrl = String(this.page.url());
      if (postUrl === preUrl) {
        // URL didn't change → likely a validation error keeping us on the same page.
        const msg = await checkMessageBar();
        return msg ? `${label} validation error: ${msg}` : `${label}: page did not advance after Continue`;
      }
      return null;
    };

    // Accela uses table-cell labels (not HTML <label> elements). Find selects and
    // inputs by scoping to the table row that contains the label text.
    const selectInRow = (labelText: string) =>
      this.page.locator("tr").filter({ hasText: new RegExp(labelText, "i") }).locator("select").first();
    const inputInRow = (labelText: string) =>
      this.page.locator("tr").filter({ hasText: new RegExp(labelText, "i") }).locator("input[type='text'],textarea").first();

    // Select a <select> option by matching option text with a regex.
    // Throws when no match is found (so callers can use try/catch for fallback logic).
    // Pass `fallback` to select by exact label text when the regex matches nothing.
    const selectByPattern = async (sel: ReturnType<typeof selectInRow>, pattern: RegExp, fallback?: string): Promise<void> => {
      const opts: Array<{ v: string; t: string }> = await sel.evaluate((el: HTMLSelectElement) =>
        Array.from(el.options).map((o) => ({ v: o.value, t: o.text.trim() }))
      ).catch(() => []);
      const match = opts.find((o) => pattern.test(o.t) && o.v);
      if (match) { await sel.selectOption(match.v); return; }
      if (fallback) { await sel.selectOption({ label: fallback }); return; }
      throw new Error(`No option matching /${pattern.source}/ found in select`);
    };

    try {
      const descriptionOfWork = buildDescriptionOfWork(project);
      const projectName = buildProjectName(project);
      const s = snap(project);

      // ── Step 0: advance past confirmation pages (Parcel / Owner) to the Project
      // Info page where Job Value appears.
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      for (let i = 0; i < 5; i++) {
        const jvField = this.page.getByRole("textbox", { name: /Job Value/i });
        const present = (await jvField.count().catch(() => 0)) > 0 &&
          (await jvField.first().isVisible().catch(() => false));
        if (present) break;
        const cont = this.continueApplicationLocator();
        if ((await cont.count()) === 0) break;
        await cont.click({ timeout: 10000 }).catch(() => null);
        await this.page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => null);
      }

      // ── Step 1: Project info (Job Value, Category, Name, Description).
      const jobValue = str(s["jobValue"] ?? s["job_value"]) ||
        String((project.systemSizeDcKw ?? 0) * 4000) || "0";
      const jobValueLoc = () => this.page.getByRole("textbox", { name: "Job Value($):" });
      await collect("jobValue", () => jobValueLoc().fill(jobValue), true, () => jobValueLoc().inputValue().catch(() => ""), jobValue);
      // Category of Construction — on this page the select is found via label text in a row.
      // The live options are numeric IDs (e.g. value="1" = Residential). Select the first
      // non-blank option; wrong value here is non-fatal (Accela defaults to a valid choice).
      await collect("categoryOfConstruction", async () => {
        const sel = selectInRow("Category of Construction");
        if ((await sel.count().catch(() => 0)) === 0) return; // field not on this page layout
        await selectByPattern(sel, /residential|new/i);
      }, false);
      const projectNameLoc = () => this.page.getByRole("textbox", { name: /Project Name/i }).first();
      await collect("projectName", () => projectNameLoc().fill(projectName), true, () => projectNameLoc().inputValue().catch(() => ""), projectName);
      await collect("descriptionOfWork", () => this.page.getByRole("textbox", { name: /Description of Work/i }).first().fill(descriptionOfWork));
      const projectInfoErr = await continueAndCheck("project info");
      if (projectInfoErr) return fail(`fillApplication: ${projectInfoErr}`);

      // ── Step 2: Applicant / contact.
      // NEVER hardcode contractor identity — it comes from the staging overlay.
      const installerCompanyName = str(s["installerCompanyName"] ?? s["installer_company_name"]);
      const installerEmail = str(s["installerEmail"] ?? s["installer_email"]);
      if (!installerCompanyName || !installerEmail) {
        return fail(
          "Oregon ePermitting: no submitting-client company/email on the staging overlay. Assign a client with licensing before staging.",
        );
      }

      // Primary path: "Select from Account" — picks the pre-existing contractor
      // contact from the portal account. Most reliable because it never requires
      // the operator to re-type the contact details.
      let contactAdded = false;
      const selectFromAccount = this.page.getByRole("link", { name: /Select from Account/i });
      if ((await selectFromAccount.count().catch(() => 0)) > 0) {
        await selectFromAccount.first().click({ timeout: 8000 }).catch(() => null);
        await this.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => null);
        const dlgFrame = this.page.frameLocator('iframe[name="ACADialogFrame"]');
        // Check the first available contact checkbox (any checkbox in the dialog).
        const cb = dlgFrame.locator('input[type="checkbox"]').first();
        if ((await cb.count().catch(() => 0)) > 0) {
          await cb.check({ timeout: 5000 }).catch(() => null);
          await dlgFrame.getByRole("link", { name: /Continue|OK|Select/i }).first()
            .click({ timeout: 8000 }).catch(() => null);
          await this.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
          contactAdded = true;
        }
      }

      // Fallback: "Add New" button — find it by any visible text that includes "add new",
      // not by a hard-coded ID (the ID suffix changes per app-type config in Accela).
      if (!contactAdded) {
        const addNew = this.page.getByRole("link", { name: /Add New/i })
          .or(this.page.locator('input[value*="Add New" i],button:has-text("Add New")'));
        if ((await addNew.count().catch(() => 0)) > 0) {
          await addNew.first().click({ timeout: 8000 }).catch(() => null);
          await this.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => null);
          const dlgFrame = this.page.frameLocator('iframe[name="ACADialogFrame"]');
          const firstField = await dlgFrame.locator('input[type="text"]').first().count().catch(() => 0);
          if (firstField > 0) {
            const firstName = installerCompanyName.split(" ")[0] ?? installerCompanyName;
            const lastName = installerCompanyName.split(" ").slice(1).join(" ") || firstName;
            await dlgFrame.locator('input[type="text"]').nth(0).fill(firstName).catch(() => null);
            await dlgFrame.locator('input[type="text"]').nth(1).fill(lastName).catch(() => null);
            // Email — look for input after "E-mail" or "Email" label text.
            const emailInput = dlgFrame.locator("tr").filter({ hasText: /e-?mail/i }).locator('input[type="text"]').first();
            if ((await emailInput.count().catch(() => 0)) > 0) {
              await emailInput.fill(installerEmail).catch(() => null);
            }
            await dlgFrame.getByRole("link", { name: /Continue|OK|Save/i }).first()
              .click({ timeout: 8000 }).catch(() => null);
            await this.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
            contactAdded = true;
          }
        }
      }

      const contactErr = await continueAndCheck("contacts");
      if (contactErr) {
        // Contacts may be optional (some Lafayette Building Dept configs don't enforce them).
        // Surface as a warning in the failures list but continue rather than hard-abort.
        requiredFailures.push(`contacts: ${contactErr}`);
      }

      // ── Step 3: Construction details / Electrical services.
      // The page content differs by permit discipline:
      //   Structural → building dimensions, construction type, type of work
      //   Electrical → kVA-tier renewable-energy count, service type selects
      const isElectrical = /elec/i.test(project.permitType ?? "");

      if (!isElectrical) {
        // ── STRUCTURAL construction details.
        // Accela renders table-cell labels (not HTML <label> elements) so use row-scoped locators.

        // "Category of Construction" on this page is the BUILDING construction type.
        // For a solar panel addition → "Other" (which reveals an "Other Category" text field).
        await collect("constructionCategory", async () => {
          const sel = selectInRow("Category of Construction");
          if ((await sel.count().catch(() => 0)) === 0) return;
          await selectByPattern(sel, /^other/i, "Other");
          // After selecting "Other", an "Other Category of Construction" text field appears.
          await this.page.waitForTimeout(800).catch(() => null);
          const otherInput = inputInRow("Other Category");
          if ((await otherInput.count().catch(() => 0)) > 0) {
            await otherInput.fill("Solar").catch(() => null);
          }
        });

        // "Type of Work" — solar on existing home = "Alteration" or "Addition".
        await collect("typeOfWork", async () => {
          const sel = selectInRow("Type of Work");
          if ((await sel.count().catch(() => 0)) === 0) return;
          // Try alteration first; fall back to "New" if the select only has that option.
          const selected = await selectByPattern(sel, /alteration|addition/i).then(() => true).catch(() => false);
          if (!selected) await selectByPattern(sel, /new/i).catch(() => null);
        });

        // "Project includes any of the following" — for solar: "Not Applicable".
        await collect("projectIncludes", async () => {
          const sel = selectInRow("Project includes any");
          if ((await sel.count().catch(() => 0)) === 0) return;
          await selectByPattern(sel, /not applicable|n\/a/i);
        }, false);

        // Building dimensions — 0 for a roof-mounted solar addition (no new building area).
        await collect("buildingHeight", async () => {
          const inp = inputInRow("Building Height");
          if ((await inp.count().catch(() => 0)) > 0) await inp.fill("0");
        });
        await collect("numberOfStories", async () => {
          const inp = inputInRow("Number of Stories");
          if ((await inp.count().catch(() => 0)) > 0) await inp.fill("0");
        });
        await collect("newBuildingArea", async () => {
          const inp = inputInRow("New Building Area");
          if ((await inp.count().catch(() => 0)) > 0) await inp.fill("0");
        });
        await collect("existingBuildingArea", async () => {
          const inp = inputInRow("Existing Building Area");
          if ((await inp.count().catch(() => 0)) > 0) await inp.fill("0");
        });
      } else {
        // ── ELECTRICAL services page.
        // Category of Construction → "Other" (reveals "Other Category" → "Solar").
        await collect("constructionCategory", async () => {
          const sel = selectInRow("Category of Construction");
          if ((await sel.count().catch(() => 0)) === 0) return;
          await selectByPattern(sel, /^other/i, "Other");
          await this.page.waitForTimeout(800).catch(() => null);
          const otherInput = inputInRow("Other Category");
          if ((await otherInput.count().catch(() => 0)) > 0) await otherInput.fill("Solar").catch(() => null);
        });

        // Type of Work → "New".
        await collect("typeOfWork", async () => {
          const sel = selectInRow("Type of Work");
          if ((await sel.count().catch(() => 0)) === 0) return;
          await selectByPattern(sel, /^new/i);
        });

        // "Project includes any of the following" → "Not Applicable".
        await collect("projectIncludes", async () => {
          const sel = selectInRow("Project includes any");
          if ((await sel.count().catch(() => 0)) === 0) return;
          await selectByPattern(sel, /not applicable|n\/a/i);
        }, false);

        // Renewable-energy kVA tier: fill the count field matching the DC system size.
        // Accela fees key off DC nameplate (systemSizeDcKw). Fill exactly ONE tier field
        // with "1" (count of systems); leave all others empty (do NOT zero them out).
        const dcKw = project.systemSizeDcKw ?? 0;
        const kvaRowPattern =
          dcKw <= 5
            ? /5\s*kva or less|renewable.*5\s*kva/i
            : dcKw <= 15
            ? /5\.?0?1.*15\s*kva|5\.01.*15|renewable.*15\s*kva/i
            : dcKw <= 25
            ? /15\.?0?1.*25\s*kva|renewable.*25\s*kva/i
            : /over\s*25\s*kva|solar.*generation.*25/i;
        const kvaLoc = () => this.page.locator("tr").filter({ hasText: kvaRowPattern }).locator('input[type="text"]').first();
        const kvaValue = dcKw > 25 ? String(Math.ceil(dcKw)) : "1";
        // No read-back comparison here: the tier row legitimately may not render for
        // small systems (we skip the fill), and the value's meaning differs by tier
        // (count of systems for ≤25 kVA vs. total kVA above), so a read-back would
        // produce false mismatches rather than real signal.
        await collect("renewableEnergyKva", async () => {
          const inp = kvaLoc();
          if ((await inp.count().catch(() => 0)) === 0) return;
          // For ≤25 kVA tiers the value is the COUNT of systems (typically "1");
          // >25 kVA tier takes the total kVA.
          await inp.fill(kvaValue);
        });
      }

      const constrErr = await continueAndCheck("construction details");
      if (constrErr) return fail(`fillApplication: ${constrErr}`, { requiredFailures });

      // If required fields failed to fill (selectors didn't match), report ok:false with
      // field names only — never PII or raw portal text.
      if (requiredFailures.length > 0) {
        return fail(
          `fillApplication: ${requiredFailures.length} field(s) could not be filled — manual review required.`,
          { requiredFailures, readbackMismatches, jobValue },
        );
      }

      // PII redaction: return only non-identifying confirmation.
      return ok("All application fields filled.", {
        jobValue,
        descriptionFilled: descriptionOfWork.length > 0,
        contactAdded,
        readbackMismatches,
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
        // Open the file-upload dialog. Accela renders an "Add" link in the documents
        // section — click the FIRST visible one in the page body (not inside any frame).
        const addLink = this.page.getByRole("link", { name: /^Add$/i }).first();
        await addLink.click({ timeout: 10000 });
        await this.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => null);

        const uploadFrame = this.page.frameLocator('iframe[name="ACADialogFrame"]');

        // The dialog has an inner "Add" link that opens a second step (the actual file-
        // picker area). Click it, then set the files directly on the hidden file input —
        // this bypasses the OS file dialog and works in headless mode.
        await uploadFrame.getByRole("link", { name: /^Add$/i }).first()
          .click({ timeout: 8000 }).catch(() => null);
        await this.page.waitForTimeout(500).catch(() => null);

        // Playwright's setInputFiles() must target the <input type="file"> element.
        // Accela's upload frame uses a hidden file input — find it by type.
        const fileInput = uploadFrame.locator('input[type="file"]').first();
        if ((await fileInput.count().catch(() => 0)) > 0) {
          await fileInput.setInputFiles(filePath);
        } else {
          // Fallback: the input may be attached to a button with title "Add" or "Browse".
          await uploadFrame.locator('[title="Add"],[title="Browse"]').first()
            .setInputFiles(filePath).catch(() => {
              throw new Error(`Could not locate file input in upload dialog for ${path.basename(filePath)}`);
            });
        }
        await uploadFrame.getByRole("link", { name: /Continue|Upload/i }).first()
          .click({ timeout: 8000 });
        await this.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);

        // After upload, fill the description and document type on the main page.
        const descriptionOfWork = buildDescriptionOfWork(project);
        await this.page.getByRole("textbox", { name: /Description/i }).first()
          .fill(descriptionOfWork).catch(() => null);

        // "Type (Required)" select — Accela renders required-field labels with a leading
        // asterisk in visible text, so use a partial label match via locator chain.
        const typeSelect = this.page.locator("tr").filter({ hasText: /Type.*Required/i })
          .locator("select").first();
        if ((await typeSelect.count().catch(() => 0)) > 0) {
          // Try to select "Plans - Construction" by partial text match.
          const opts: Array<{ v: string; t: string }> = await typeSelect.evaluate((el: HTMLSelectElement) =>
            Array.from(el.options).map((o) => ({ v: o.value, t: o.text.trim() }))
          ).catch(() => []);
          const match = opts.find((o) => /plans.*construction|construction.*plan/i.test(o.t) && o.v);
          if (match) await typeSelect.selectOption(match.v).catch(() => null);
        }

        await this.page.getByRole("link", { name: /^Save$/i }).first()
          .click({ timeout: 10000 });
        await this.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => null);

        // After Save, check for visible error messages — the portal may accept the click
        // but show a validation error (wrong file type, size limit). Treat an error message
        // as an upload failure so it surfaces to the operator rather than disappearing silently.
        const baseName = path.basename(filePath);
        const errorBar = this.page.locator(
          ".message-bar,.MessageBar,[id*=MessageBar],[class*=msgBar],.acc-error-bar,.validation-summary"
        );
        const errorVisible = (await errorBar.count().catch(() => 0)) > 0 &&
          (await errorBar.first().isVisible().catch(() => false));
        if (errorVisible) {
          const errText = await errorBar.first().innerText().catch(() => "upload error");
          failed.push(`${baseName}: ${errText.trim().slice(0, 120)}`);
        } else {
          uploaded.push(baseName);
        }
      } catch (err) {
        failed.push(`${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.continueApplicationLocator().click({ timeout: 10000 }).catch(() => null);
    await this.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);

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
      // Stop when URL contains "Review"/"Confirm" OR a final-submit button is visible
      // (that's a structural indicator of the review page, regardless of URL pattern).
      const isReviewPage = async (): Promise<boolean> => {
        const url = String(this.page.url());
        if (/review|confirm/i.test(url)) return true;
        // Accela's review page typically has a "Submit Application" or "Submit" final button.
        // We detect it by presence but NEVER click it.
        const submitBtn = this.page.getByRole("link", { name: /Submit Application|Submit/i })
          .or(this.page.locator('input[value*="Submit" i]'));
        return (await submitBtn.count().catch(() => 0)) > 0;
      };

      let reviewReached = await isReviewPage();
      for (let i = 0; i < 8 && !reviewReached; i++) {
        const continueLink = this.continueApplicationLocator();
        if ((await continueLink.count().catch(() => 0)) === 0) break;
        await continueLink.click({ timeout: 10000 });
        await this.page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => null);
        reviewReached = await isReviewPage();
      }

      const finalUrl = this.page.url();
      const blockerCount = reviewerReport?.findings.filter((f) => f.severity === "blocker").length ?? 0;

      // Compare what the Accela review page shows against the project record.
      // Mismatches are surfaced to the dashboard so the operator can catch a silently
      // wrong field before clicking Approve & Submit. Accela's "Step N: Review" is a
      // read-only summary (no inputs), so pass the rendered page text as the fallback
      // haystack — otherwise the structured scrape is empty and every field looks missing.
      const reviewFields = await scrapeReviewScreen(this.page).catch(() => []);
      const reviewBody = (await this.page.locator("body").innerText().catch(() => "")).slice(0, 20000);
      // A permit application types no utility account or meter (B8): neither is looked for here.
      const reviewMismatches = compareReviewFields(reviewFields, project, { accountNumber: false, meterNumber: false }, reviewBody);

      return ok(HUMAN_REVIEW_MESSAGE, {
        projectId: project.id,
        portalReviewUrl: finalUrl,
        reviewReached,
        blockerCount,
        ahjPreviewVisibleRequired: reviewerReport?.finalSubmitGate.mustShowAhjPreviewWindow ?? true,
        finalSubmitButtonAloneIsEnough: reviewerReport?.finalSubmitGate.finalSubmitButtonAloneIsEnough ?? false,
        internalFinalReviewPacketRequired: true,
        finalReviewPacketUrl: `/api/projects/${project.id}/reviewer-report?format=html`,
        reviewMismatches,
        reviewAccurate: reviewMismatches.length === 0,
        // What the LLM gap-fill added (and what it left blank for lack of real data).
        gapFill: this.gapFillReport,
        nextHumanAction:
          "The browser is staged at the final review screen. Verify all fields and uploaded files, handle any MFA or fee payment, then click submit manually. AUTOMATION HAS STOPPED.",
      });
    } catch (err) {
      return fail(`stopAtReview failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // submitFromReview — POST-APPROVAL only. Called by submitStagedRun() after
  // stopAtReview() has already positioned the browser on the final review page.
  // Clicks the allowlisted final-submit control and captures confirmation.
  // NEVER navigates to a new application, pays fees, or bypasses MFA.
  // ---------------------------------------------------------------------------
  override async submitFromReview(_project: ProjectRecord): Promise<PortalStepResult> {
    if (!this.page) return fail("Not logged in.");
    try {
      // 1. Assert we are on the Accela review/confirmation page.
      const url = String(this.page.url());
      const submitBtn = this.page.getByRole("link", { name: /Submit Application|Submit/i })
        .or(this.page.locator('input[value*="Submit Application" i], input[value*="Submit" i]'));
      const onReviewPage = /review|confirm/i.test(url) || (await submitBtn.count().catch(() => 0)) > 0;
      if (!onReviewPage) {
        return fail("submitFromReview: not on the Accela review page — refusing to submit. Run stopAtReview() first.");
      }

      // 2. Fee-payment denylist: if every visible submit-like control contains fee-related text,
      //    pause for human rather than risk triggering a payment.
      const allSubmitText = await submitBtn.allInnerTexts().catch(() => [] as string[]);
      const allAreFeeGated = allSubmitText.length > 0 &&
        allSubmitText.every((t: string) => /pay|fee|payment|checkout/i.test(t));
      if (allAreFeeGated) {
        return { ok: false, message: "submitFromReview: Accela review page shows a fee-payment gate before submit — pausing for human to complete payment.", pauseReason: "mfa_captcha" };
      }

      // 3. Click the allowlisted final-submit button. Accela may render it as a link or
      //    an input[type=submit]; prefer the more specific text first.
      const submitTarget = this.page.locator('input[value*="Submit Application" i]')
        .or(this.page.locator('input[value*="Submit" i]'))
        .or(this.page.getByRole("link", { name: /Submit Application/i }))
        .or(this.page.getByRole("link", { name: /^Submit$/i }));
      await submitTarget.first().click({ timeout: 15000 });
      await this.page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);

      // 4. Post-click: if URL didn't change, a challenge or validation may be blocking.
      const postUrl = String(this.page.url());
      if (/review|confirm/i.test(postUrl) && postUrl === url) {
        // Challenge detection (converged): use the shared structural detector FIRST — it
        // catches iframe-based CAPTCHA/MFA (reCAPTCHA, hCaptcha, Cloudflare) that a body-text
        // regex can't see — then keep the visible-text regex as an additional fallback. This
        // matches how the recipe + PowerClerk adapters detect challenges (one shared codepath
        // to harden); purely additive, so it can only catch more, never fewer.
        const challenge = await detectChallengeFrame(this.page);
        if (challenge) {
          return { ok: false, message: `submitFromReview: ${challenge} after submit click — pausing for human.`, pauseReason: "mfa_captcha" };
        }
        const bodyText = await this.page.locator("body").innerText().catch(() => "");
        if (/captcha|recaptcha|two.?factor|mfa|authenticat/i.test(bodyText)) {
          return { ok: false, message: "submitFromReview: MFA/CAPTCHA appeared after submit click — pausing for human.", pauseReason: "mfa_captcha" };
        }
        // Validation message?
        const msgBar = await this.page.locator(
          ".message-bar,.MessageBar,[id*=MessageBar],[class*=msgBar],.acc-error-bar,.validation-summary"
        ).first().innerText().catch(() => "");
        if (msgBar) return fail(`submitFromReview: Accela blocked the submit: ${msgBar.trim().slice(0, 200)}`);
      }

      // 5. Capture the confirmation page.
      const confirmation = await this.captureSubmissionConfirmation();
      return {
        ok: confirmation.ok,
        message: confirmation.ok
          ? `Accela application submitted. Permit: ${String(confirmation.data?.["permitNumber"] ?? "captured")}`
          : `submitFromReview: submit appeared to succeed but confirmation capture failed: ${confirmation.message}`,
        data: {
          finalSubmitClicked: true,
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
      const url = this.page.url();
      const title = await this.page.title();

      // Extract the record/permit number from the completion page. Accela's receipt shows
      // the number as a BARE green link (e.g. "495-26-000071-STR") with no "Record Number:"
      // label, so match the structured Accela record pattern first, then fall back to a
      // labeled match. The trailing suffix encodes the discipline: -STR (structural),
      // -ELE (electrical), -MEC (mechanical), etc.
      const bodyText = await this.page.locator("body").innerText();
      const accela = bodyText.match(/\b\d{2,4}-\d{2}-\d{4,7}-[A-Z]{2,4}\b/);
      const labeled = bodyText.match(/(?:Record|Permit)\s*(?:Number|#|No\.?)[:\s]+([A-Z0-9-]+)/i);
      const permitNumber = (accela?.[0] ?? labeled?.[1] ?? null);
      const discipline = permitNumber?.match(/-([A-Z]{2,4})$/)?.[1] ?? null;

      return ok("Confirmation page captured.", {
        url,
        title,
        permitNumber,
        confirmationNumber: permitNumber,
        discipline,
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
      // Scan the page text for a row that contains one of the known application numbers and
      // return a REDACTED, capped snippet (account/meter-like digit runs masked) — never a
      // multi-thousand-char raw portal body dump.
      return scanStatusFromBody(this.page, applicationNumbers);
    } catch {
      return null;
    }
  }
}
