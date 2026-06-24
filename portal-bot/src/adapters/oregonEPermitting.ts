import path from "node:path";
import type { ProjectRecord, ReviewerReport } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, ok, fail, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { scanStatusFromBody, safeAction } from "../safeAction";
import { snap, str, num } from "../snapshot";
import { scrapeReviewScreen, compareReviewFields } from "../reviewScreenScraper";

// Oregon ePermitting (Accela ACA) adapter
// Codegen recording captured by operator up to the review page.
// SECURITY: This adapter NEVER clicks final submit, pays fees, solves CAPTCHA, or handles MFA.
// The human must perform those actions after reviewing the staged package.

const BASE_URL = "https://aca-oregon.accela.com/oregon";

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

// The street LINE only — the part before the first comma. projectAddress is stored as
// "925 N Grant St, Lafayette, OR, 97127"; everything after the first comma is city/state/zip
// and must not leak into the street-number/name/direction parsing (it returns zero results).
function streetLine(address: string): string {
  return (address || "").split(",")[0].trim();
}

function parseStreetNumber(address: string): string {
  return streetLine(address).split(/\s+/)[0] ?? "";
}

const STREET_DIRECTIONS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"]);
const STREET_SUFFIXES = new Set([
  "st", "street", "ave", "avenue", "blvd", "boulevard", "rd", "road", "dr", "drive",
  "ln", "lane", "ct", "court", "way", "pl", "place", "ter", "terrace", "cir", "circle",
  "hwy", "highway", "pkwy", "parkway", "loop", "trl", "trail",
]);
const clean = (w: string) => w.toLowerCase().replace(/[.,]/g, "");

// Accela's "Street Name" search field wants the CORE name only — e.g. "925 N Grant St" must
// be searched as "Grant" (the leading direction and trailing street-type suffix belong in
// separate fields). Including them returns zero results, which silently breaks the flow.
function parseStreetName(address: string): string {
  const parts = streetLine(address).split(/\s+/);
  parts.shift(); // remove street number
  if (parts.length > 1 && STREET_DIRECTIONS.has(clean(parts[0]))) parts.shift(); // leading direction
  const unitKeywords = new Set(["apt", "unit", "ste", "suite", "#"]);
  const unitIdx = parts.findIndex((p) => unitKeywords.has(p.toLowerCase()));
  let core = unitIdx === -1 ? parts : parts.slice(0, unitIdx);
  // strip trailing street-type suffix and/or trailing direction (e.g. "Grant St", "Main St NW")
  while (core.length > 1 && (STREET_SUFFIXES.has(clean(core[core.length - 1])) || STREET_DIRECTIONS.has(clean(core[core.length - 1])))) {
    core = core.slice(0, -1);
  }
  return core.join(" ");
}

// Leading directional (N/S/E/W) of the street, for Accela's separate direction dropdown.
function parseStreetDirection(address: string): string {
  const parts = streetLine(address).split(/\s+/);
  parts.shift(); // street number
  return parts.length > 1 && STREET_DIRECTIONS.has(clean(parts[0])) ? parts[0].toUpperCase().replace(/[.,]/g, "") : "";
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
      await this.page.getByRole("link", { name: /Continue Application/i }).first().click({ timeout: 10000 });
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

      // Step 1: Work-site address search. On the current WorkLocation.aspx the fields are
      // id-only (no accessible labels): street number = ...txtStreetNo4Search_ChildControl0,
      // street name = ...txtStreetName. Use id-suffix locators rather than role+name.
      const streetNum = parseStreetNumber(project.projectAddress ?? "");
      const streetName = parseStreetName(project.projectAddress ?? "");
      await this.page.locator('input[id*="StreetNo4Search"]').first().fill(streetNum, { timeout: 10000 });
      await this.page.locator('input[id$="txtStreetName"]').first().fill(streetName, { timeout: 10000 });
      // Best-effort: set the street direction dropdown (separate field on Accela) to narrow
      // the results. Non-fatal — row selection below disambiguates jurisdiction regardless.
      const streetDir = parseStreetDirection(project.projectAddress ?? "");
      if (streetDir) {
        await this.page.locator('select[id$="ddlStreetDirection"]').first().selectOption(streetDir).catch(() => null);
      }
      // The address form's OWN search button: id ends in WorkLocationEdit_btnSearch. (Use the
      // precise suffix — a looser match also hits the street field's "_help" anchor.)
      await this.page.locator('a[id$="WorkLocationEdit_btnSearch"]').first().click({ timeout: 10000 });
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

      // The results grid lists the SAME street address under multiple jurisdictions:
      //   CITY APPLICATIONS  → structural permits (Building Dept)
      //   COUNTY APPLICATIONS → electrical permits (Yamhill County / state electrical)
      // Select the row that matches the permit type. Default to structural if unspecified.
      const isElectrical = /elec/i.test(project.permitType ?? "");
      const jurisdictionPattern = isElectrical ? /COUNTY APPLICATIONS/i : /CITY APPLICATIONS/i;
      const cityUpper = (project.city || "").toUpperCase();
      const jurisdictionRow = this.page.locator("tr", { hasText: jurisdictionPattern }).filter({ hasText: cityUpper });
      const selectLink = (await jurisdictionRow.count()) > 0
        ? jurisdictionRow.getByRole("link", { name: /^Select$/i }).first()
        : this.page.getByRole("link", { name: /^Select$/i }).first();
      await selectLink.click({ timeout: 15000 });
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

      // Choose application type matching the permit discipline. The selector tries the most
      // specific match first (e.g. "Residential – Electrical Comprehensive") then falls back
      // to a broader pattern. Both structural and electrical tracks use a single checkbox.
      const appTypePattern = isElectrical
        ? /Residential\s*-?\s*Electrical/i
        : /Residential\s*-?\s*Structural/i;
      const appTypeCheckbox = this.page.getByRole("checkbox", { name: appTypePattern });
      if ((await appTypeCheckbox.count().catch(() => 0)) > 0) {
        await appTypeCheckbox.first().check({ timeout: 10000 });
      } else {
        // Fallback: check the first available checkbox (only one option on the page)
        await this.page.locator('input[type="checkbox"]').first().check({ timeout: 8000 });
      }
      await this.page.getByRole("link", { name: /Continue Application/i }).first().click({ timeout: 10000 });

      // PII redaction: do NOT return the street number/name/full address — only a
      // boolean confirming the address search resolved, plus the permit discipline chosen.
      return ok(`Application opened (${isElectrical ? "electrical/county" : "structural/city"}) and address confirmed.`, {
        projectId: project.id,
        addressResolved: Boolean(streetNum || streetName),
        permitDiscipline: isElectrical ? "electrical" : "structural",
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
      const cont = this.page.getByRole("link", { name: /Continue Application/i }).first();
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
        const cont = this.page.getByRole("link", { name: /Continue Application/i });
        if ((await cont.count()) === 0) break;
        await cont.first().click({ timeout: 10000 }).catch(() => null);
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

    await this.page.getByRole("link", { name: /Continue Application/i }).first()
      .click({ timeout: 10000 }).catch(() => null);
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
        const continueLink = this.page.getByRole("link", { name: /Continue Application/i });
        if ((await continueLink.count().catch(() => 0)) === 0) break;
        await continueLink.first().click({ timeout: 10000 });
        await this.page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => null);
        reviewReached = await isReviewPage();
      }

      const finalUrl = this.page.url();
      const blockerCount = reviewerReport?.findings.filter((f) => f.severity === "blocker").length ?? 0;

      // Compare what the Accela review page shows against the project record.
      // Mismatches are surfaced to the dashboard so the operator can catch a silently
      // wrong field before clicking Approve & Submit.
      const reviewFields = await scrapeReviewScreen(this.page).catch(() => []);
      const reviewMismatches = compareReviewFields(reviewFields, project);

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
        // Check for MFA/CAPTCHA text on the page.
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
