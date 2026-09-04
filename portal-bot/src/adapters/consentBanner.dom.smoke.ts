// DECLINING IS THE DEFAULT, AND REFUSING TO CLICK IS A VALID ANSWER.
//
// Des Moines (PermitTrax) walked into /citizen/CookiePolicy/ on three runs and spent its
// whole budget there. Its log finally named what it followed:
//
//   navigate_chosen page 2  label: "SELECT"  dashboard: true  ->  /citizen/CookiePolicy/
//
// "SELECT" is the granular-choice button on the cookie banner. The legal-page exclusion
// could never have caught it — the label carries no legal wording — and a planner staring at
// a dashboard of buttons cannot know that one of them is a privacy dialog.
//
// Two things are true at once. The banner blocks the run, and every visit is a first visit
// now that each portal has its own profile. AND it asks a real question about the operator's
// privacy: clicking "Accept" to get on with the job answers that question on their behalf,
// in the direction that suits us rather than them.
//
// So most of this test is what must NOT be clicked. An accept-only banner is left standing —
// a blocked run is a far smaller problem than a bot consenting to tracking for someone else,
// and the overlay neutraliser already handles a banner that merely covers a control.
//   npx tsx portal-bot/src/adapters/consentBanner.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { looksLikeConsentWall, planConsentDismissal } from "./consentBanner";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const banner = (buttons: string): string => `<!doctype html><html><body>
  <div id="cookie-banner" style="position:fixed;bottom:0;width:600px;height:120px">
    We use essential cookies to make our site work. With your consent we may also use
    non-essential cookies to analyze website traffic.
    ${buttons}
  </div>
  <a href="/apply" style="display:block;width:200px;height:24px">Click to Apply Online</a>
  </body></html>`;
const btn = (t: string): string => `<button style="width:110px;height:30px">${t}</button>`;

const PAGES: Record<string, string> = {
  // PermitTrax's own shape: Preferences / Decline / Accept.
  permittrax: banner(btn("Preferences") + btn("Decline") + btn("Accept")),
  rejectAll: banner(btn("Reject All") + btn("Accept All")),
  necessaryOnly: banner(btn("Only necessary") + btn("Allow all")),
  closeOnly: banner(btn("Close") + btn("Accept")),
  // The one that must be left alone.
  acceptOnly: banner(btn("Accept") + btn("Learn more")),
  gotItOnly: banner(btn("Got it")),
  // Not a consent banner at all.
  ordinaryDialog: `<!doctype html><html><body>
    <div role="dialog" style="width:400px;height:120px">
      Your session will expire soon. ${btn("Continue")}${btn("Close")}
    </div></body></html>`,
  none: `<!doctype html><html><body><a href="/apply" style="display:block;width:200px;height:24px">Apply</a></body></html>`,
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? "<!doctype html><html><body>none</body></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
// tsx/esbuild wraps named functions with __name(); without this every page.evaluate throws.
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

const planOn = async (key: string): Promise<{ clicked: string; how: string }> => {
  await page.goto(`http://127.0.0.1:${port}/${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(80);
  return page.evaluate(planConsentDismissal);
};

// --- the declines ---
const pt = await planOn("permittrax");
check("THE REGRESSION: PermitTrax's banner is DECLINED, not accepted, not 'Preferences'",
  pt.clicked === "Decline" && pt.how === "declined", JSON.stringify(pt));
check("...and 'Preferences' is not treated as a way through — that is the /CookiePolicy/ trip",
  pt.clicked !== "Preferences", JSON.stringify(pt));

check("'Reject All' is preferred over 'Accept All'", (await planOn("rejectAll")).clicked === "Reject All");
check("'Only necessary' is preferred over 'Allow all'", (await planOn("necessaryOnly")).clicked === "Only necessary");

const closed = await planOn("closeOnly");
check("with no decline offered, Close is taken — it consents to nothing",
  closed.clicked === "Close" && closed.how === "closed", JSON.stringify(closed));

// --- the refusals, which are the substance ---
const acceptOnly = await planOn("acceptOnly");
check("ACCEPT-ONLY: nothing is clicked — consenting is the operator's to give",
  acceptOnly.clicked === "" && acceptOnly.how === "accept-only-refused", JSON.stringify(acceptOnly));

const gotIt = await planOn("gotItOnly");
check("...and 'Got it' alone is an acceptance too, so it is also refused",
  gotIt.clicked === "", JSON.stringify(gotIt));

check("an ordinary dialog with no consent wording is not touched",
  (await planOn("ordinaryDialog")).clicked === "");
check("a page with no banner yields nothing", (await planOn("none")).how === "");

// ---------------------------------------------------------------------------
// A CONSENT WALL: the portal will not proceed until the question is answered.
//
// Des Moines answers a click on ANY permit type by serving its cookie policy. The row
// picked was verifiably correct — "05) RESIDENTIAL ROOFTOP PHOTOVOLTAIC PERMIT" is in the
// run log — and the portal bounced it anyway. Three runs were spent re-reading that page
// before anything noticed the bounce was the answer, not a mis-pick.
// ---------------------------------------------------------------------------
check("THE REGRESSION: an application click that lands on the cookie policy is a wall",
  looksLikeConsentWall(
    "https://desmoines-wa.permittrax.com/citizen/Home/DESMON_L/PBPW",
    "https://desmoines-wa.permittrax.com/citizen/CookiePolicy/DESMON_L/PBPW",
  ));

check("...and a privacy or consent landing counts the same way",
  looksLikeConsentWall("https://x.gov/apply", "https://x.gov/privacy-policy")
  && looksLikeConsentWall("https://x.gov/apply", "https://x.gov/consent"));

check("an ordinary navigation is not a wall",
  !looksLikeConsentWall("https://x.gov/home", "https://x.gov/apply/electrical"));

check("staying on the SAME cookie page is not a fresh bounce",
  !looksLikeConsentWall("https://x.gov/CookiePolicy", "https://x.gov/CookiePolicy"),
  "otherwise every page after the first bounce reports the wall again");

check("leaving a cookie page for a real one is not a wall",
  !looksLikeConsentWall("https://x.gov/CookiePolicy", "https://x.gov/apply"));

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} consent-banner check(s) FAILED.`); process.exit(1); }
console.log("\nAll consent-banner checks passed.");
process.exit(0);
