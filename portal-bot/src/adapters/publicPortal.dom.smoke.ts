// A PORTAL WITH NOWHERE TO LOG IN IS NOT A PORTAL WHOSE LOGIN WE FAILED TO FIND.
//
// The 2026-09-04 baseline scored five of eleven portals `login_failed`, four of them
// "the portal's login form was not recognised" — the engine's own fault, four times over,
// on four unrelated platforms. Probing all four found they were not one bug:
//
//   Star ID (iWorq)      GENUINELY PUBLIC. No password field, no sign-in control, and its
//                        applications listed as links — "Electrical", "Plumbing", "Ada
//                        County Residential Building". We were hunting a login that does
//                        not exist.
//   Des Moines WA        HAS ACCOUNTS, invisibly. From the live probe it looked exactly
//   (PermitTrax)         like iWorq; its markup carries SIGN IN and REGISTER inside a
//                        closed dropdown whose toggle is a bare icon.
//   Washington County    HAS ACCOUNTS — a header "Login" link and "Register for an
//   (Accela)             Account". Its defect is elsewhere and must NOT be papered over.
//   Wilsonville (Tyler)  HAS ACCOUNTS — "Login or Register". Likewise.
//
// TWO RULES COME OUT OF THAT, and this file tests both:
//
//   1. A portal is public only when there is NOWHERE TO LOG IN — never because it has
//      apply-ish links, since every permit portal has those. Get this wrong in the
//      generous direction and the silent false success on logged-out landing pages comes
//      straight back, which is what the surrounding guard exists to prevent. So the three
//      portals that DO have accounts are checked here as carefully as the one that doesn't.
//
//   2. A control's identity can live OUTSIDE ITS TEXT. PermitTrax's sign-in is named only
//      by a tooltip and by the menu it opens. That is the "present but shut" pattern for
//      the third time — after collapsed nav and the closed record-type category — so it is
//      worth naming as a standing rule rather than fixing once more in place.
//
// One of these checks was written backwards first: PermitTrax was asserted public, because
// that is what the live page looked like. Its own markup corrected it. That is the reason
// the fixtures are the portals' real HTML and not a hand-written approximation.
//
// FIXTURES ARE THE PORTALS' OWN MARKUP, captured 2026-09-04 (scripts stripped, inert).
//   npx tsx portal-bot/src/adapters/publicPortal.dom.smoke.ts
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { markDescribedLoginControl, publicApplicationEntry } from "./loginFlow";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string): string => fs.readFileSync(path.join(here, "fixtures", `${n}.html`), "utf8");

const PAGES: Record<string, string> = {
  iworq: fixture("iworq-public-menu"),
  permittrax: fixture("permittrax-public-menu"),
  accela: fixture("accela-login-link"),
  tyler: fixture("tyler-login-link"),
  // A logged-out landing page with a login link and no apply-ish wording: the shape the
  // guard exists to refuse.
  landing: `<!doctype html><html><body>
     <a href="/Account/Login">Sign In</a>
     <input type="search" placeholder="Search permits" />
     <a href="/status">Check permit status</a></body></html>`,
  // The nastiest near-miss: no password field ON THIS PAGE, plenty of apply-ish links,
  // and the only login affordance is an href with no login WORDING at all.
  hiddenLogin: `<!doctype html><html><body>
     <a href="/portal/account/signin" style="width:80px;height:20px">Members</a>
     <a href="/new-permit/600/1" style="width:80px;height:20px">Electrical</a>
     <a href="/new-permit/600/2" style="width:80px;height:20px">Plumbing</a></body></html>`,
};

const server = http.createServer((req, res) => {
  const key = (req.url || "").replace(/^\/|\?.*$/g, "") || "iworq";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGES[key] ?? "<!doctype html><html><body>none</body></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
// tsx/esbuild wraps named functions with __name(); without this every page.evaluate throws
// and the caller's .catch turns the failure into a silent "found nothing".
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

const evidenceFor = async (key: string): Promise<string> => {
  await page.goto(`http://127.0.0.1:${port}/${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(120);
  return publicApplicationEntry(page);
};

// ---------------------------------------------------------------------------
// The two that are genuinely public.
// ---------------------------------------------------------------------------
const iworq = await evidenceFor("iworq");
check("THE REGRESSION: iWorq's public menu is recognised as needing no login", !!iworq, `got ${JSON.stringify(iworq)}`);
check("...and it says WHAT it saw, so the verdict can be argued with", /application entries/.test(iworq), iworq);
console.log(`   iworq evidence: ${iworq}`);

// ---------------------------------------------------------------------------
// The three that have accounts. A false positive here is worse than the bug being fixed:
// it would proceed as authenticated on a portal where we are not.
// ---------------------------------------------------------------------------
// PERMITTRAX BELONGS IN THIS GROUP, and finding that out is why this test earns its keep.
//
// From the live probe it looked exactly like iWorq: no password field, no visible sign-in
// control, "CLICK TO APPLY ONLINE" on the page. This test was first written asserting it
// was public. Its own markup says otherwise — SIGN IN and REGISTER are there, inside a
// closed Bootstrap dropdown whose toggle is an icon with no text at all
// (<i class="bi-person-circle">), described only by a tooltip: "Click to Sign In /
// Register a New Account". Accounts exist; they are merely invisible.
//
// So the detector refusing it is CORRECT, and PermitTrax's real defect is the one behind
// iconDropdownReveal — the "present but shut" pattern again, this time as a dropdown.
const permittrax = await evidenceFor("permittrax");
check("ACCOUNTS EXIST: PermitTrax hides SIGN IN in a closed dropdown — invisible is not absent",
  permittrax === "", `claimed public with: ${permittrax}`);

const accela = await evidenceFor("accela");
check("ACCOUNTS EXIST: Accela's header 'Login' link disqualifies it, despite the apply links",
  accela === "", `claimed public with: ${accela}`);

const tyler = await evidenceFor("tyler");
check("ACCOUNTS EXIST: Tyler's 'Login or Register' disqualifies it", tyler === "", `claimed public with: ${tyler}`);

// ---------------------------------------------------------------------------
// The shapes the guard must keep refusing.
// ---------------------------------------------------------------------------
check("a logged-out landing page with a search box is not a public application",
  (await evidenceFor("landing")) === "");

check("a login hidden in an href with no login WORDING still disqualifies",
  (await evidenceFor("hiddenLogin")) === "",
  "an /account/signin href is an account even when the link says 'Members'");

// ---------------------------------------------------------------------------
// Properties of the rule itself.
// ---------------------------------------------------------------------------
PAGES.passwordOnly = `<!doctype html><html><body>
   <a href="/apply/new-permit/1" style="width:90px;height:20px">Apply for a permit</a>
   <a href="/apply/new-permit/2" style="width:90px;height:20px">Apply for another</a>
   <input type="password" style="display:none" /></body></html>`;
check("a password field disqualifies even when hidden — accounts exist either way",
  (await evidenceFor("passwordOnly")) === "");

PAGES.oneEntry = `<!doctype html><html><body>
   <a href="/apply" style="width:90px;height:20px">Apply online</a></body></html>`;
check("ONE apply link is not a menu — a lone link is too weak a claim to skip a login",
  (await evidenceFor("oneEntry")) === "");

PAGES.signedOut = `<!doctype html><html><body>
   <a href="/logout" style="width:90px;height:20px">Log out</a>
   <a href="/new-permit/1" style="width:90px;height:20px">Apply: Electrical</a>
   <a href="/new-permit/2" style="width:90px;height:20px">Apply: Plumbing</a></body></html>`;
check("a LOG OUT link is not a login affordance — that page is already signed in",
  (await evidenceFor("signedOut")) !== "");

// ---------------------------------------------------------------------------
// THE OTHER HALF: finding a login control that never says it is one.
//
// PermitTrax's toggle is <button class="dropdown-toggle"><i class="bi-person-circle"></i>
// </button> — no text, no aria-label, no login token in its id. Only a tooltip and the
// closed menu it opens name it. This is the "present but shut" pattern that has now cost
// three separate fixes (collapsed nav, closed record-type category, and this), so the rule
// is worth stating plainly: a control's identity can live outside its text.
// ---------------------------------------------------------------------------
const permittraxTrigger = await (async () => {
  await page.goto(`http://127.0.0.1:${port}/permittrax`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(200);
  return markDescribedLoginControl(page);
})();
check("THE REGRESSION: PermitTrax's icon-only sign-in toggle is found by its description",
  !!permittraxTrigger, "no control matched — the login stays unreachable");
console.log(`   described by: ${permittraxTrigger}`);

check("...and the control it tagged is the dropdown toggle, not some other icon",
  await page.locator("[data-al-login-reveal]").first().evaluate(
    (el) => el.classList.contains("dropdown-toggle") || !!el.closest(".dropdown"),
  ).catch(() => false) === true);

const markOn = async (key: string): Promise<string> => {
  await page.goto(`http://127.0.0.1:${port}/${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(150);
  return markDescribedLoginControl(page);
};

PAGES.iconLogout = `<!doctype html><html><body>
   <div class="dropdown"><button class="dropdown-toggle" style="width:30px;height:30px"><i></i></button>
   <ul class="dropdown-menu"><li><a href="/logout">Sign Out</a></li></ul></div></body></html>`;
check("A SIGN-OUT menu is never clicked as a login — that is the session we already have",
  (await markOn("iconLogout")) === "");

PAGES.iconUnrelated = `<!doctype html><html><body>
   <div class="dropdown"><button class="dropdown-toggle" title="Change language" style="width:30px;height:30px"><i></i></button>
   <ul class="dropdown-menu"><li><a href="#">English</a></li><li><a href="#">Espanol</a></li></ul></div></body></html>`;
check("an unrelated icon dropdown is left alone — narrowness is the whole safety property",
  (await markOn("iconUnrelated")) === "");

PAGES.wordedButton = `<!doctype html><html><body>
   <button style="width:90px;height:30px" title="Sign in here">Log In</button></body></html>`;
check("a control that SAYS what it is belongs to the worded triggers, not this pass",
  (await markOn("wordedButton")) === "",
  "matching it here would double-handle every ordinary login button");

check("Accela's page offers no icon-only login — its worded link is the way in",
  (await markOn("accela")) === "");

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} public-portal check(s) FAILED.`); process.exit(1); }
console.log("\nAll public-portal checks passed.");
process.exit(0);
