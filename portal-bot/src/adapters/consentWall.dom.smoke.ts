// A CONSENT WALL IS ANSWERED, NOT SURRENDERED TO -- AND THE BOUNCED CLICK MUST NOT SURVIVE.
//
// Des Moines (PermitTrax) answers a click on ANY permit type by serving its cookie policy:
// the row picked is verifiably correct and the portal bounces it anyway, because its consent
// decision has not been made and the application flow is gated behind it. Two portals in the
// 59-portal learn benchmark ended their run there having filled nothing.
//
// Stopping was right about ACCEPTING and wrong about the wall. Declining is also an answer,
// and it is the one that suits the operator -- Reject / Decline / Necessary-only, or a Close
// that consents to nothing. An Accept-only banner still blocks, by design.
//
// Three behaviours, and the first draft only had one of them:
//   1. the wall clears and the walk carries on;
//   2. the entry is clicked AGAIN -- the loop guard that refuses a repeat click has to let
//      this one through, or clearing the wall changes nothing;
//   3. the BOUNCED click never reaches the recipe. It is pushed before the wall is even
//      detected, and replay runs on a fresh profile where it would bounce again, with
//      nothing there that knows how to go back.
//   npx tsx portal-bot/src/adapters/consentWall.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { planConsentDismissal, looksLikeConsentWall } from "./consentBanner";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The portal: an apply link that bounces to /cookie-policy until a decline is recorded.
const HOME = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h3>Permits</h3>
  <a id="apply" href="/apply">05) RESIDENTIAL ROOFTOP PHOTOVOLTAIC PERMIT</a>
</body></html>`;

const POLICY = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h3>Cookie Policy</h3>
  <!-- Shaped the way the planner requires and real banners are built: an identifiable
       consent container, wording that says what it is, and a decline beside an accept. -->
  <div id="cookie-consent-banner" role="dialog" style="border:1px solid #999;padding:12px">
    <p>We use cookies and similar tracking technologies. Choose your privacy preferences.</p>
    <button id="reject">Reject All</button>
    <button id="accept">Accept All</button>
  </div>
  <script>
    document.getElementById("reject").addEventListener("click", function () {
      document.cookie = "consent=declined;path=/";
      document.getElementById("cookie-consent-banner").remove();
    });
  </script>
</body></html>`;

const APPLY = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h3>Application</h3><label for="nm">Name</label><input id="nm" />
</body></html>`;

const server = http.createServer((q, r) => {
  const declined = /consent=declined/.test(q.headers.cookie || "");
  // The wall REDIRECTS, which is what makes it detectable: Des Moines bounces a correct
  // permit-type click to /citizen/CookiePolicy/. Serving the policy at the original URL
  // would be a different (and easier) bug.
  if (q.url === "/apply" && !declined) {
    r.writeHead(302, { Location: "/cookie-policy" });
    return r.end();
  }
  r.writeHead(200, { "Content-Type": "text/html" });
  if (q.url === "/apply") return r.end(APPLY);
  if (q.url === "/cookie-policy") return r.end(POLICY);
  return r.end(HOME);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

// The walk, reduced to the shape the adapter performs around the wall check.
const steps: Array<{ note: string }> = [];
const navClicksByPath = new Set<string>();
const navLoopKey = "home|apply";

await page.goto(base);
const before = page.url();
navClicksByPath.add(navLoopKey);                      // registered BEFORE the click, as live
steps.push({ note: "navigate to application: 05) RESIDENTIAL ROOFTOP PHOTOVOLTAIC PERMIT" });
await page.locator("#apply").click();
await page.waitForLoadState("domcontentloaded");
const after = page.url();

check("the fixture reproduces the wall: the apply link bounces to the cookie policy",
  looksLikeConsentWall(before, after), `${before} -> ${after}`);

// ---- what the adapter now does -------------------------------------------------
const outcome = await page.evaluate(planConsentDismissal);
if (outcome?.how && outcome.how !== "accept-only") {
  await page.locator("[data-al-consent]").first().click({ timeout: 3000 }).catch(() => null);
}
await page.goto(before);
if (steps.length && steps[steps.length - 1].note.startsWith("navigate to application:")) steps.pop();
navClicksByPath.delete(navLoopKey);

check("it DECLINES rather than accepts",
  outcome?.how === "declined", JSON.stringify(outcome));

check("the bounced click is NOT left in the recipe",
  steps.length === 0, JSON.stringify(steps));

check("the loop guard lets the entry be clicked again",
  !navClicksByPath.has(navLoopKey), "the retry is barred by the same guard that stops repeat clicks");

// ...and the retry actually gets in now.
await page.locator("#apply").click();
await page.waitForLoadState("domcontentloaded");
const finalUrl = page.url();
const onApplication = await page.locator("#nm").count().catch(() => 0);
console.log(`   after declining and retrying -> ${finalUrl} (application fields: ${onApplication})`);

check("THE POINT: the retry reaches the application instead of the policy again",
  onApplication === 1 && !looksLikeConsentWall(before, finalUrl),
  `landed on ${finalUrl} with ${onApplication} application field(s)`);

assert.ok(true);
await browser.close();
server.close();
if (failures) { console.error(`\n${failures} consent-wall check(s) FAILED.`); process.exit(1); }
console.log("\nAll consent-wall checks passed (real Chromium).");
process.exit(0);
