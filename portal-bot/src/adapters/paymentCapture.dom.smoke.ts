// A CARD FIELD THE HUMAN TYPES INTO IS NOT A STEP THE RECIPE GETS TO KEEP.
//
// The human-patch capture arms the left-open review browser so an operator's fixes merge
// into the learned recipe. On Coos Bay, the operator then paid the permit fee in that same
// browser - and the capture recorded the payment form: CVV "520" as a plain literal, the
// cardholder's name, the expiry month and year, the card type. Those sat in the SHARED
// portal_recipes table for nine days. The card NUMBER alone was caught, because its input
// carried an autocomplete attribute; the CVV's only identity was a <label>CVV:</label> the
// attribute-only predicate never read.
//
// Payment-card fields are now refused at capture - not sensitively-bound, REFUSED: replay
// must never drive a payment form (hard rule 1), so a card step has no legitimate replayer.
//
//   MUST NOT   - typing into CVV / card number / name-on-card / expiry / card type records
//                ANY step, of any kind.
//   MUST STILL - an account-number field records sensitive:true (bound, no literal), and an
//                ordinary field records normally. Over-refusing here would break the whole
//                human-patch feature.
//
//   npx tsx portal-bot/src/adapters/paymentCapture.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { armHumanCaptureOnPage } from "../humanCapture";
import type { RecipeStep } from "../../../shared/src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The Accela payment page's exact hazard shape: the card inputs' ATTRIBUTES are opaque
// server-control ids; only the <label> says what they are. Plus the two control fields
// that must keep working.
const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h2>Fee Payment</h2>
  <label for="ctl00_c1">Card Number:</label><input id="ctl00_c1" autocomplete="cc-number" type="text">
  <label for="ctl00_c2">CVV:</label><input id="ctl00_c2" type="text">
  <label for="ctl00_c3">Name on Card:</label><input id="ctl00_c3" type="text">
  <label for="ctl00_c4">Card Type:</label>
  <select id="ctl00_c4"><option>Visa</option><option>Mastercard</option></select>
  <label for="ctl00_c5">Expiration Date</label>
  <select id="ctl00_c5"><option>01</option><option>02</option></select>
  <hr>
  <label for="acct">Utility Account Number</label><input id="acct" name="account_number" type="text">
  <label for="job">Job Description</label><input id="job" type="text">
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const captured: RecipeStep[] = [];
await armHumanCaptureOnPage(page, (s: RecipeStep) => { captured.push(s); });

// The operator pays the fee: types the whole card block...
await page.fill("#ctl00_c1", "4111111111111111");
await page.fill("#ctl00_c2", "520");
await page.fill("#ctl00_c3", "Seamus Ericson");
await page.selectOption("#ctl00_c4", "Visa");
await page.selectOption("#ctl00_c5", "02");
// ...and also fixes two legitimate fields the learner missed:
await page.fill("#acct", "30917442861");
await page.fill("#job", "Rooftop solar PV");
// change events need a blur to commit
await page.click("h2");
await page.waitForTimeout(400);

const all = JSON.stringify(captured);
console.log(`   captured ${captured.length} step(s)`);

check("MUST NOT: no card VALUE reaches any captured step",
  !all.includes("4111") && !all.includes("520") && !all.includes("Seamus") && !all.includes("Visa"),
  `card data in the capture: ${all.slice(0, 300)}`);

check("MUST NOT: no step targets a card field at all, of any kind",
  !/cvv|card|expir/i.test(all),
  `a card-field step was recorded — replay must never even know where these fields are: ${all.slice(0, 300)}`);

const acct = captured.find((s) => /account/i.test(JSON.stringify(s)));
check("MUST STILL: the account field records sensitive:true with its value riding for binding only",
  !!acct && (acct as { sensitive?: boolean }).sensitive === true,
  `account step: ${JSON.stringify(acct ?? "(none captured — over-refusal broke the feature)")}`);

const job = captured.find((s) => String(s.value ?? "") === "Rooftop solar PV");
check("MUST STILL: an ordinary field records normally",
  !!job,
  "the job-description fill was not captured — the payment refusal is eating ordinary fields");

await browser.close();
server.close();
console.log(failures === 0 ? "paymentCapture.dom.smoke: PASS" : `paymentCapture.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
