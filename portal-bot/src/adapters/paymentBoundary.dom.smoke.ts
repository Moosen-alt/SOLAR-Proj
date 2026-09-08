// AUTOMATION NEVER PAYS A PORTAL FEE -- SO IT MUST NOT WALK INTO THE CARD FORM EITHER.
//
// Hard safety rule #1 is enforced at the click: no pay button is ever pressed. But a recipe
// is learned by a HUMAN who did pay, so it carries their card fields, and replay used to walk
// straight at them -- failing on page drift at the fee page and scoring as a broken recipe
// when what actually happened was the boundary working.
//
// Live: Coos Bay electrical, 53 of 62 steps, stopped at CapFees.aspx with "CVV:", a month
// list and a year list still recorded ahead of it.
//
// The second half of this file matters more than the first. A boundary that stops too eagerly
// halts filings that were fine, and permit forms are full of words that merely SOUND like
// payment: a job value in dollars, a licence expiration date, a fee amount shown for
// information. None of those is a card.
//   npx tsx portal-bot/src/adapters/paymentBoundary.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><head><style>body{font:14px sans-serif;padding:16px}</style></head><body>
  <label for="jobvalue">Job Value ($)</label><input id="jobvalue" />
  <label for="licexp">Contractor Licence Expiration Date</label><input id="licexp" />
  <label for="feeamt">Total Fees Due</label><input id="feeamt" />
  <label for="ccnum">Card Number</label><input id="ccnum" />
  <label for="cvv">CVV:</label><input id="cvv" />
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const recipe = {
  id: "pb1", scopeType: "ahj", profileKey: "or|city of coos bay|pacific power", state: "OR",
  ahj: "City of Coos Bay", utility: "Pacific Power", portalPlatform: "accela", portalUrl: url,
  status: "complete", version: 1,
  steps: [
    { action: "fill", phase: "fill", field: "", note: "Job Value ($)", value: "25000", selector: { css: "#jobvalue" } },
    { action: "fill", phase: "fill", field: "", note: "Contractor Licence Expiration Date", value: "2027-04-01", selector: { css: "#licexp" } },
    { action: "fill", phase: "fill", field: "", note: "Total Fees Due", value: "412.50", selector: { css: "#feeamt" } },
    { action: "fill", phase: "fill", field: "", note: "Card Number", value: "4111111111111111", selector: { css: "#ccnum" } },
    { action: "fill", phase: "fill", field: "", note: "CVV:", value: "123", selector: { css: "#cvv" } },
  ] as unknown as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(url);
const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;
const res = await adapter.fillApplication({} as never);
const data = (res as unknown as { data?: { skipped?: string[]; stoppedAtPayment?: boolean; executed?: number } }).data ?? {};
const val = async (sel: string): Promise<string> => await page.locator(sel).inputValue().catch(() => "");
const [jobvalue, licexp, feeamt, ccnum, cvv] = [await val("#jobvalue"), await val("#licexp"), await val("#feeamt"), await val("#ccnum"), await val("#cvv")];
console.log(`   jobValue=${JSON.stringify(jobvalue)} licExp=${JSON.stringify(licexp)} fees=${JSON.stringify(feeamt)}`);
console.log(`   cardNumber=${JSON.stringify(ccnum)} cvv=${JSON.stringify(cvv)} stoppedAtPayment=${String(data.stoppedAtPayment)}`);

check("THE RULE: no card number is ever typed",
  ccnum === "", `a card number was entered into the portal: ${JSON.stringify(ccnum)}`);

check("...and no CVV either",
  cvv === "", `a security code was entered into the portal: ${JSON.stringify(cvv)}`);

check("...and the run SAYS it stopped at payment, so nobody reads it as a broken recipe",
  data.stoppedAtPayment === true, JSON.stringify(data.stoppedAtPayment));

check("...and the remaining card steps are recorded as not entered, not as failures",
  (data.skipped ?? []).some((sName) => /^payment: /i.test(sName)), JSON.stringify(data.skipped));

// THE HALF THAT MATTERS MORE. A boundary that stops too eagerly halts filings that were fine.
check("A DOLLAR AMOUNT IS NOT A CARD: the job value is still filled",
  jobvalue === "25000", `job value came out ${JSON.stringify(jobvalue)} — the boundary fired too early`);

check("A LICENCE EXPIRY IS NOT A CARD EXPIRY: it is still filled",
  licexp === "2027-04-01", `licence expiration came out ${JSON.stringify(licexp)} — the boundary fired too early`);

check("A FEE SHOWN FOR INFORMATION IS NOT A PAYMENT: it is still filled",
  feeamt === "412.50", `fees due came out ${JSON.stringify(feeamt)} — the boundary fired too early`);

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} payment-boundary check(s) FAILED.`); process.exit(1); }
console.log("\nAll payment-boundary checks passed (real Chromium).");
process.exit(0);
