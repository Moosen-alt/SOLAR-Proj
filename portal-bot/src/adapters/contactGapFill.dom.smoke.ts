// THE CONTACT GAP-FILL RETURNS AS SOON AS IT KNOWS THERE IS NOTHING TO FILL (runs-finish item 5).
//
// Live run 191e45c8 (production, 2026-09-27, Oregon ePermitting / Accela, the borrowed Coos Bay
// recipe): "contact(applicant): save new contact" took 75,553 ms, of which phases.gap-fill was
// 60,063 ms; "contact(site contact): save new contact" 45,558 ms with gap-fill 30,056 ms — and the
// gap-fill filled NOTHING (gapFill.filled / reportedMissing both empty). Exact multiples of 30 s:
// Playwright's default timeout. gapFillCurrentPage read every candidate's value (inputValue /
// isChecked) BEFORE asking whether any of them was required, and a candidate whose recorded
// selector resolves to nothing waited the whole 30 s default for an element that never appears.
// The shape that does it without guessing: a radio / checkbox the extractor labels by its
// NEIGHBOURING text (no <label> association — Miami's Yes/No rows, a contact list's "Primary"
// column), which getByLabel can never find.
//
//   MUST-PASS    the contact dialog's "save new contact" click (Accela shape: a main page with a
//                contact list and two neighbour-labelled choice controls, the contact form in the
//                ACADialogFrame iframe) spends < 5 s in gap-fill — it was 60 s.
//   MUST-PASS    what gap-fill legitimately fills it still fills: a REQUIRED empty text box with a
//                real <label>, the planner's value grounded in the project, is filled.
//   MUST-EXCLUDE a required empty box the project has no value for is still reported, never guessed.
//
//   npx tsx portal-bot/src/adapters/contactGapFill.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import type { LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The main contacts page. The two choice controls are labelled only by the text in the NEXT cell
// (no <label for>, no wrapping label, no aria-label) — the extractor names them "Primary" /
// "Same as the applicant", and getByLabel resolves neither.
const contactsPage = (extra: string): string => `<!doctype html><html><head><title>Accela Citizen Access</title></head><body>
<h1>ePermit</h1>
<table class="breadcrump-table"><tr><td class="breadcrump-selected">1 General Info</td><td class="breadcrump-disable">2 Services</td><td class="breadcrump-disable">3 Review</td></tr></table>
<div class="breadcrump-pagetitle"><table><tr><td>Step 1</td><td>:</td><td>General Info</td><td>&gt;</td><td>Contacts</td></tr></table></div>
<form id="aspnetForm" onsubmit="return false">
<div class="ACA_Section"><h2>Applicant</h2>
  <table><tr><td><input type="radio" name="ctl00$PlaceHolderMain$Applicant$rdoPrimary" id="ctl00_PlaceHolderMain_Applicant_rdoPrimary"></td><td>Primary</td></tr></table>
  <a id="btnAddNewApplicant" role="button" href="#" onclick="document.getElementById('dlg').style.display='block';return false;">Add New</a>
</div>
<div class="ACA_Section"><h2>Site Contact</h2>
  <table><tr><td><input type="checkbox" name="ctl00$PlaceHolderMain$Site$chkSame" id="ctl00_PlaceHolderMain_Site_chkSame"></td><td>Same as the applicant</td></tr></table>
</div>
<div class="ACA_Section"><h2>Project</h2>
  <label for="jobValue">Job Value($):</label><input id="jobValue" name="jobValue" required value="1000">
  ${extra}
</div>
</form>
<div id="dlg" style="display:none;position:fixed;left:40px;top:40px;width:520px;height:360px;background:#fff;border:1px solid #333">
  <iframe name="ACADialogFrame" src="/dialog" style="width:100%;height:100%;border:0"></iframe>
</div>
</body></html>`;

const dialogPage = `<!doctype html><html><head><title>Contact Information</title></head><body>
<h1>Contact Information</h1>
<label for="txtFirstName">First Name:</label><input id="txtFirstName" name="txtFirstName">
<label for="txtLastName">Last Name:</label><input id="txtLastName" name="txtLastName">
<a id="btnContinue" role="button" href="#" onclick="parent.document.getElementById('dlg').style.display='none';return false;">Continue</a>
</body></html>`;

let extraMarkup = "";
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(url.pathname === "/dialog" ? dialogPage : contactsPage(extraMarkup));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipeOf = (steps: RecipeStep[]): PortalRecipe => ({
  id: "contact-gapfill-smoke", scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "accela", portalUrl: `${base}/contacts`, status: "complete", version: 1,
  steps, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
});
const STEPS: RecipeStep[] = [
  { action: "goto", value: `${base}/contacts`, note: "entry url" },
  { action: "click", selector: { role: "button", name: "Add New", fallbacks: [{ css: "a:has-text(\"Add New\")" }] }, note: "contact(applicant): add new" },
  { action: "fill", selector: { css: "input[id*='FirstName' i]", frame: "ACADialogFrame" }, value: "Charles", note: "contact: first name [applicant]" },
  { action: "fill", selector: { css: "input[id*='LastName' i]", frame: "ACADialogFrame" }, value: "Bitton", note: "contact: last name [applicant]" },
  { action: "click", selector: { role: "button", name: "Continue", frame: "ACADialogFrame" }, note: "contact(applicant): save new contact" },
];

// A planner that fills a "Business Name" box from the project, and nothing else.
let plannerCalls = 0;
const planner: LearnPlanner = async (req) => {
  plannerCalls++;
  const i = req.fields.findIndex((f) => /business name/i.test(String(f.label ?? "")));
  return { fills: i >= 0 ? [{ selectorIndex: i, value: "Acme Solar", field: "installerCompany" }] : [], atReview: false };
};

const browser = await chromium.launch();
async function run(name: string): Promise<{ gapMs: number; filled: string[]; missing: string[]; totalMs: number; ok: boolean; message: string; businessValue: string }> {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  const adapter = new RecipeAdapter(recipeOf(STEPS), {}, {});
  (adapter as unknown as { page: unknown }).page = page;
  adapter.enableLlmGapFill(planner, { installerCompany: "Acme Solar" });
  const t0 = Date.now();
  const result = await adapter.fillApplication({} as ProjectRecord);
  const totalMs = Date.now() - t0;
  const data = (result.data ?? {}) as { slowSteps?: Array<{ note: string; phases?: Record<string, number> }>; gapFill?: { filled: string[]; reportedMissing: string[] } };
  // slowSteps lists every step of >= 4 s with its phases; a save that is not listed took < 4 s
  // in total, gap-fill included.
  const save = (data.slowSteps ?? []).find((s) => /save new contact/i.test(s.note));
  const gapMs = save ? (save.phases?.["gap-fill"] ?? 0) : 0;
  if (!save) console.log("  (the save is not a slow step: the whole step took < 4 s, gap-fill included)");
  const businessValue = await page.locator("#businessName").inputValue({ timeout: 1000 }).catch(() => "");
  await ctx.close();
  const out = { gapMs, filled: adapter.gapFillReport.filled.slice(), missing: adapter.gapFillReport.reportedMissing.slice(), totalMs, ok: !!result.ok, message: String(result.message ?? "").slice(0, 200), businessValue };
  console.log(`  [${name}] gap-fill ${gapMs} ms (whole replay ${totalMs} ms) filled=[${out.filled.join(", ")}] missing=[${out.missing.join(", ")}] plannerCalls=${plannerCalls}`);
  return out;
}

console.log("\n1. MUST-PASS: the contact dialog's save spends < 5 s in gap-fill (live: 60,063 ms)");
{
  extraMarkup = "";
  plannerCalls = 0;
  const o = await run("contact dialog, nothing to fill");
  check("gap-fill on 'save new contact' is under 5 s", o.gapMs < 5000, `gap-fill ${o.gapMs} ms`);
  check("nothing to fill: no planner call spent", plannerCalls === 0, `plannerCalls=${plannerCalls}`);
  check("nothing invented", o.filled.length === 0, o.filled.join(", "));
}

console.log("\n2. MUST-PASS: a required empty box with a real label is still gap-filled from the project");
{
  extraMarkup = `<label for="businessName">Business Name:</label><input id="businessName" name="businessName" required>`;
  plannerCalls = 0;
  const o = await run("required empty box");
  check("the planner was asked", plannerCalls >= 1, `plannerCalls=${plannerCalls}`);
  check("Business Name was filled from the project", o.filled.some((f) => /business name/i.test(f)) && o.businessValue === "Acme Solar", `filled=[${o.filled.join(", ")}] value="${o.businessValue}"`);
  check("and still quickly (< 5 s)", o.gapMs < 5000, `gap-fill ${o.gapMs} ms`);
}

console.log("\n3. MUST-EXCLUDE: a required empty box the project has no value for is reported, never guessed");
{
  extraMarkup = `<label for="permitNo">Contractor Permit Number:</label><input id="permitNo" name="permitNo" required>`;
  plannerCalls = 0;
  const o = await run("required box, no project value");
  check("reported missing", o.missing.some((m) => /contractor permit number/i.test(m)), `missing=[${o.missing.join(", ")}]`);
  check("not filled", !o.filled.some((f) => /permit number/i.test(f)), `filled=[${o.filled.join(", ")}]`);
}

await browser.close();
server.close();
if (failures) { console.error(`\ncontactGapFill: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\ncontactGapFill: all checks passed (real Chromium)");
