// R1 — THE DRIFT-SEEK CLICK-THROUGH GOES THROUGH THE CHOKEPOINT, AND A TERMINAL PAGE STOPS IT.
//
// Replay's drift-seek loop clicks "Continue Application" past a page that has nothing to fill
// (a jurisdiction's extra "Licensed Professional" page). A read-only REVIEW page has nothing to
// fill either — and on Accela's review page that link FILES the application. This drives the
// real RecipeAdapter in real Chromium against the synthetic Accela replica (127.0.0.1 only):
//
//   MUST-EXCLUDE  a recipe one page longer than the portal lands on CapConfirm.aspx while it
//                 expects "Additional Information": the server receives NO filing POST, and the
//                 run fails with a named terminal-page drift reason.
//   MUST-PASS     the same drift onto a read-only "Licensed Professional" page (not terminal) is
//                 clicked through, and the recipe's Contacts fills land on the next page.
//
//   npx tsx portal-bot/src/adapters/driftSeekReview.dom.smoke.ts
import { chromium } from "playwright";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
// Every artifact this smoke's replays write goes to a temp folder, never data/.
const SMOKE_ARTIFACTS = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "replay-smoke-"));
process.env.REPLAY_CAPTURE_DIR = SMOKE_ARTIFACTS;
process.env.REPLAY_RUN_DIR = nodePath.join(SMOKE_ARTIFACTS, "runs");
process.env.PORTAL_SCREENSHOT_DIR = nodePath.join(SMOKE_ARTIFACTS, "screenshots");
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { buildWizard } from "../replica/fixtures/wizards";
import { startSyntheticReplica } from "../replica/syntheticServer";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const recipeOf = (base: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "drift-seek-smoke", scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "accela", portalUrl: `${base}/CitizenAccess/Default.aspx`, status: "complete", version: 1,
  steps, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
});

const browser = await chromium.launch();
async function run(recipe: PortalRecipe, values: Record<string, string>) {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  const adapter = new RecipeAdapter(recipe, values, {});
  (adapter as unknown as { page: unknown }).page = page;
  const result = await adapter.fillApplication({} as ProjectRecord);
  return { result, adapter, page, close: () => ctx.close() };
}

console.log("\n1. MUST-EXCLUDE: the recipe expects a field page; the portal is already on its review page");
{
  const w = buildWizard("accela", "one_page_fewer");
  const r = await startSyntheticReplica({ wizard: w });
  const review = w.pages.find((p) => p.kind === "review")!;
  const steps: RecipeStep[] = [
    { action: "goto", value: `${r.base}/CitizenAccess/Cap/${review.slug}`, note: "resume the application" },
    { action: "fill", selector: { label: "Description of Work:" }, note: "Description of Work:", field: "workDescription" },
    { action: "fill", selector: { label: "System Size (kW DC):" }, note: "System Size (kW DC):", field: "systemSizeDcKw" },
    { action: "fill", selector: { label: "Total Number of Modules:" }, note: "Total Number of Modules:", field: "moduleQuantity" },
    { action: "fill", selector: { label: "Number of Stories:" }, note: "Number of Stories:", field: "numberOfStories" },
    { action: "click", selector: { role: "link", name: "Continue Application »" }, note: "advance: Continue Application" },
    { action: "stopForReview" },
  ];
  const { result, close } = await run(recipeOf(r.base, steps), { workDescription: "PV", systemSizeDcKw: "7.2", moduleQuantity: "18", numberOfStories: "2" });
  check("the server received NO filing POST", r.state.submitPosts.length === 0, `submitPosts=${r.state.submitPosts.length}`);
  check("the run failed", result.ok === false, String(result.message).slice(0, 200));
  check("with a named reason: the landing page is TERMINAL and its control is the filing click", /the page it landed on is TERMINAL/.test(String(result.message)) && /(is the filing click on this page|terminal-page drift)/i.test(String(result.message)), String(result.message).slice(0, 600));
  await close();
  await r.close();
}

console.log("\n2. MUST-PASS: a read-only page that is NOT terminal is clicked through");
{
  const w = buildWizard("accela", "extra_readonly_page");
  const r = await startSyntheticReplica({ wizard: w });
  const lp = w.pages.find((p) => p.kind === "readonly")!;
  const steps: RecipeStep[] = [
    { action: "goto", value: `${r.base}/CitizenAccess/Cap/${lp.slug}`, note: "resume the application" },
    { action: "fill", selector: { label: "First Name:", fallbacks: [{ css: "input[id$='ApplicantEdit_txtFirstName']" }] }, note: "First Name:", field: "installerFirstName" },
    { action: "fill", selector: { label: "Last Name:", fallbacks: [{ css: "input[id$='ApplicantEdit_txtLastName']" }] }, note: "Last Name:", field: "installerLastName" },
    { action: "fill", selector: { label: "E-mail:", fallbacks: [{ css: "input[id$='ApplicantEdit_txtEmail']" }] }, note: "E-mail:", field: "installerEmail" },
    { action: "stopForReview" },
  ];
  const { result, adapter, page, close } = await run(recipeOf(r.base, steps), { installerFirstName: "Philippa", installerLastName: "Ashgrove", installerEmail: "office@kestrel.example.com" });
  const drift = ((result.data as { driftWarnings?: string[] })?.driftWarnings ?? []).join(" | ");
  check("the drift-seek clicked through the Licensed Professional page", /clicked through 1 page/i.test(drift), drift.slice(0, 300));
  check("the chokepoint refused nothing", adapter.guardRefusals.length === 0, adapter.guardRefusals.join(" | "));
  const first = await page.locator("input[id$='ApplicantEdit_txtFirstName']").inputValue().catch(() => "");
  check("the Contacts fills landed on the page after it", first === "Philippa", `first="${first}" ok=${result.ok} ${String(result.message).slice(0, 200)}`);
  check("no filing POST", r.state.submitPosts.length === 0);
  await close();
  await r.close();
}

console.log("\n3. MUST-PASS: a form page whose STEP BAR lists the review step is not terminal; a pass-through page advanced by the recipe's own \"Next\"");
{
  // The SPA prints every step in a stepper header ("5 Review your application") on every page.
  // Read as the page's own text, that named page ONE the review step and refused its Next.
  const w = buildWizard("spa", "extra_readonly_page");
  const r = await startSyntheticReplica({ wizard: w });
  const lbl = (label: string, field: string): RecipeStep => ({ action: "fill", selector: { label }, note: label, field });
  const steps: RecipeStep[] = [
    { action: "goto", value: r.entryUrl, note: "open the application" },
    lbl("First name", "installerFirstName"), lbl("Last name", "installerLastName"), lbl("Company", "installerCompanyName"),
    lbl("Email", "installerEmail"), lbl("Phone", "installerPhone"),
    { action: "click", selector: { role: "button", name: "Next", exact: true }, note: "advance: Next" },
    lbl("Street address", "street"), lbl("City", "city"), lbl("ZIP", "zip"),
    { action: "stopForReview" },
  ];
  const values = {
    installerFirstName: "Philippa", installerLastName: "Ashgrove", installerCompanyName: "Kestrel Energy LLC",
    installerEmail: "office@kestrel.example.com", installerPhone: "541-555-0199", street: "918 Quimby Ave", city: "Fernhollow", zip: "97498",
  };
  const recipe = { ...recipeOf(r.base, steps), portalUrl: r.entryUrl };
  const { result, adapter, page, close } = await run(recipe, values);
  check("the first page's Next was NOT refused (the step bar is not the page)", adapter.guardRefusals.length === 0, adapter.guardRefusals.join(" | "));
  check("the applicant step reached the server", r.state.values["app.company"] === values.installerCompanyName, JSON.stringify(r.state.values));
  const drift = ((result.data as { driftWarnings?: string[] })?.driftWarnings ?? []).join(" | ");
  check("the \"Before you continue\" page was clicked through with the recipe's own Next", /clicked through 1 page/i.test(drift), `${drift.slice(0, 300)} ${String(result.message).slice(0, 200)}`);
  const street = await page.locator("input[formcontrolname]").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)).catch(() => [] as string[]);
  check("the Property fills landed on the page after it", street.includes(values.street), JSON.stringify(street));
  check("no filing POST", r.state.submitPosts.length === 0);
  await close();
  await r.close();
}

await browser.close();
if (failures) { console.error(`\ndriftSeekReview: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\ndriftSeekReview: all checks passed (real Chromium, synthetic replica)");
process.exit(0);
