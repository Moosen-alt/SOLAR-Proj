// FINDING "START AN APPLICATION" ON A PORTAL NOBODY TAUGHT US — AND NEVER CLICKING THE
// OPERATOR'S REAL FILINGS.
//
// Every vendor names the same control differently (Accela "Create an Application", Tyler
// EnerGov a bare "Apply" tile, OpenGov "Apply for a permit", SmartGov "Apply Online"), so
// the learn loop used to spend an LLM planner call — or wander — on a step that is
// deterministic. The far more dangerous half is what sits NEXT to it on a logged-in home:
// "Resume Application", "Pay Fees Due", "Search Applications", "Renew" — every one of them
// operates on a REAL submitted permit belonging to a real customer. Exclusions must win
// over any positive match.
//
// Fixtures mirror the six live families in the operator's workbook. Run:
//   npx tsx portal-bot/src/adapters/applicationEntry.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { findApplicationEntry, findApplicationEntryDeep, matchesEntryLabel, isExcludedEntryLabel } from "./applicationEntry";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Each fixture is a logged-in portal home: the real entry control surrounded by the
// look-alike controls that must never be clicked.
const PAGES: Record<string, string> = {
  // Accela ACA — the shape verified live on Anne Arundel County.
  "/accela": `<!doctype html><body>
    <a href="/AACO/Cap/CapHome.aspx">Search Applications</a>
    <a href="/AACO/Cap/CapApplyDisclaimer.aspx">Create an Application</a>
    <a href="/AACO/Welcome.aspx">Resume Application</a>
    <a href="/AACO/Cap/Fees.aspx">Pay Fees Due</a>
  </body>`,
  // Tyler EnerGov CSS — a bare "Apply" tile plus the dashboard tiles beside it.
  "/energov": `<!doctype html><body>
    <a href="#/dashboard">Dashboard</a>
    <a href="#/apply">Apply</a>
    <a href="#/myWork">My Work</a>
    <a href="#/payInvoice">Pay Invoices</a>
  </body>`,
  // OpenGov / ViewPoint Cloud.
  "/opengov": `<!doctype html><body>
    <button>View my records</button>
    <a href="/apply">Apply for a permit</a>
    <a href="/renew">Renew a license</a>
  </body>`,
  // SmartGov.
  "/smartgov": `<!doctype html><body>
    <a href="/Public/Search">Search Permits</a>
    <a href="/Public/Apply">Apply Online</a>
    <a href="/Public/Inspections">Schedule an Inspection</a>
  </body>`,
  // Citizenserve.
  "/citizenserve": `<!doctype html><body>
    <a href="?Action=showApply">Apply for a Permit</a>
    <a href="?Action=showStatus">Check Permit Status</a>
    <a href="?Action=upload">Upload Documents</a>
  </body>`,
  // A HOSTILE home: every control is one of the must-never-click kind. The finder must
  // return NOTHING rather than pick the least-bad option.
  "/dangerous": `<!doctype html><body>
    <a href="/resume">Resume Application</a>
    <a href="/pay">Pay Fees Due</a>
    <a href="/search">Search Applications</a>
    <a href="/renew">Renew Permit</a>
    <a href="/register">Register for an Account</a>
    <a href="/upload">Upload Documents to an Existing Permit</a>
  </body>`,
  // Two candidates present: the specific one must win over the bare "Apply".
  "/ranked": `<!doctype html><body>
    <a href="/x">Apply</a>
    <a href="/y">Create an Application</a>
  </body>`,
  // Accela's REAL logged-in home (verified live on Anne Arundel County): the entry is NOT
  // here — the home offers only module tabs, and "Create an Application" lives one hop in.
  "/module-home": `<!doctype html><body>
    <a href="/module-licensing">Licensing</a>
    <a href="/module-permits">Permits</a>
    <a href="/search">Search Applications</a>
    <a href="/records">My Records</a>
  </body>`,
  "/module-permits": `<!doctype html><body>
    <a href="/disclaimer">Create an Application</a>
    <a href="/search">Search Applications</a>
  </body>`,
  // The wrong module: a dead end that the search must back out of, not settle for.
  "/module-licensing": `<!doctype html><body>
    <a href="/renew">Renew a License</a>
    <a href="/pay">Pay Fees Due</a>
  </body>`,
  // Momentum's shape: the entry is right there but worded "Apply Here".
  "/apply-here": `<!doctype html><body>
    <a href="/register">Create a Profile</a>
    <a href="/submit">Apply Here</a>
  </body>`,
  // Ameren Illinois (PowerClerk), verified live: the real entry is "New Interconnection
  // Application", sitting right next to "New Pre-Application" — a different, usually paid
  // engineering study that files nothing and must never be picked.
  "/utility-interconnection": `<!doctype html><body>
    <a href="/home">Home</a>
    <a href="/new-app">New Interconnection Application</a>
    <a href="/new-pre">New Pre-Application</a>
    <a href="/all">All Projects</a>
  </body>`,
  // ComEd's shape (verified live): a floating "+" button whose only visible text is the
  // plus sign; the name appears in aria-label, and to a person only on hover. Reading
  // textContent made the entry unfindable, and locating it BY that text found nothing even
  // once it was identified.
  "/fab": `<!doctype html><body>
    <a href="/records">My Records</a>
    <button aria-label="New Application Button. This will open a popup drawer.">+</button>
  </body>`,
  // The same idea with a tooltip attribute instead of aria-label.
  "/fab-title": `<!doctype html><body>
    <a href="/records">Search Applications</a>
    <button title="New Application">+</button>
  </body>`,

  // A mobile-first home where the whole menu — entry included — is behind a hamburger.
  // Verified live: Momentum's logged-in home offers only "Open Navigation Menu".
  "/collapsed-nav": `<!doctype html><body>
    <button aria-label="Open Navigation Menu" id="burger">☰</button>
    <div id="nav" style="display:none"><a href="/apply">Apply Here</a><a href="/pay">Pay Fees Due</a></div>
    <script>document.getElementById('burger').onclick=function(){document.getElementById('nav').style.display='block';};</script>
  </body>`,
};

const server = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGES[q.url || ""] ?? "<body>?</body>"); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

const expectEntry = async (route: string, expected: string) => {
  await page.goto(`http://127.0.0.1:${port}${route}`);
  const found = await findApplicationEntry(page);
  assert.ok(found, `no entry found on ${route}`);
  assert.equal(found!.match.label, expected, `on ${route}`);
};

await check("Accela: picks 'Create an Application', not Resume/Pay/Search", () => expectEntry("/accela", "Create an Application"));
await check("Tyler EnerGov: picks the bare 'Apply' tile", () => expectEntry("/energov", "Apply"));
await check("OpenGov: picks 'Apply for a permit', not Renew", () => expectEntry("/opengov", "Apply for a permit"));
await check("SmartGov: picks 'Apply Online', not Schedule an Inspection", () => expectEntry("/smartgov", "Apply Online"));
await check("Citizenserve: picks 'Apply for a Permit', not Upload/Status", () => expectEntry("/citizenserve", "Apply for a Permit"));
await check("a specific label outranks the bare 'Apply'", () => expectEntry("/ranked", "Create an Application"));

await check("a home of ONLY real-filing controls yields NOTHING (never a least-bad click)", async () => {
  await page.goto(`http://127.0.0.1:${port}/dangerous`);
  const found = await findApplicationEntry(page);
  assert.equal(found, null, `must not pick ${found?.match.label}`);
});

await check("exclusions win over positive matches, label-by-label", async () => {
  // Each of these CONTAINS an apply-ish phrase but must still be refused.
  for (const bad of [
    "Resume Application",
    "Search Applications",
    "Renew a Permit Application",
    "Pay for a Permit",
    "Upload Documents to an Application",
    "Register for an Account",
    "View Application Status",
  ]) {
    assert.equal(isExcludedEntryLabel(bad), true, `should exclude: ${bad}`);
    assert.equal(matchesEntryLabel(bad), false, `should not match: ${bad}`);
  }
  // …and the genuine ones still match.
  for (const good of ["Create an Application", "Apply for a Permit", "Apply Online", "Apply", "Start a New Application"]) {
    assert.equal(matchesEntryLabel(good), true, `should match: ${good}`);
  }
});

await check("a paragraph of text is never treated as a button", async () => {
  assert.equal(matchesEntryLabel("To apply for a permit you must first register an account and provide proof of insurance"), false);
});

await check("Momentum: 'Apply Here' is recognised", () => expectEntry("/apply-here", "Apply Here"));

await check("Ameren IL: picks 'New Interconnection Application', never 'New Pre-Application'",
  () => expectEntry("/utility-interconnection", "New Interconnection Application"));

await check("ComEd: a '+' FAB named only by aria-label is found", async () => {
  await page.goto(`http://127.0.0.1:${port}/fab`);
  const found = await findApplicationEntry(page);
  assert.ok(found, "the FAB should be found via its accessible name");
  assert.match(found!.match.label, /New Application/i);
  // And it must be CLICKABLE — locating an aria-label by visible text finds nothing.
  await found!.locator.click({ timeout: 5000 });
});

await check("a '+' FAB named only by a tooltip is found and clickable", async () => {
  await page.goto(`http://127.0.0.1:${port}/fab-title`);
  const found = await findApplicationEntry(page);
  assert.ok(found, "the FAB should be found via its title tooltip");
  assert.equal(found!.match.label, "New Application");
  await found!.locator.click({ timeout: 5000 });
});

await check("Accela: follows ONE module hop to reach 'Create an Application'", async () => {
  await page.goto(`http://127.0.0.1:${port}/module-home`);
  assert.equal(await findApplicationEntry(page), null, "the home itself offers no entry — that's the premise");
  const deep = await findApplicationEntryDeep(page);
  assert.ok(deep, "deep search should find the entry inside a module");
  assert.equal(deep!.match.label, "Create an Application");
  assert.equal(deep!.viaModule, "Permits", "and should report which module it went through");
});

await check("opens a collapsed hamburger nav to reach the entry behind it", async () => {
  await page.goto(`http://127.0.0.1:${port}/collapsed-nav`);
  assert.equal(await findApplicationEntry(page), null, "hidden behind the toggle — that's the premise");
  const deep = await findApplicationEntryDeep(page);
  assert.ok(deep, "should open the menu and find the entry");
  assert.equal(deep!.match.label, "Apply Here");
});

await check("deep search still refuses a portal that only offers real-filing controls", async () => {
  await page.goto(`http://127.0.0.1:${port}/dangerous`);
  const deep = await findApplicationEntryDeep(page);
  assert.equal(deep, null, `must not pick ${deep?.match.label}`);
});

// A DISABLED NAMESAKE IS NEVER THE ENTRY. Live on Marineau's electrical replay: Oregon
// ePermitting's landing page carries a DISABLED decorative "Apply" nav pill, headless layout
// put it first in DOM order, getByText("Apply").first() resolved onto it, and the click
// waited its full 30s on a button that can never be clicked — while the real Apply link sat
// enabled right below. The replay must take the first VISIBLE + ENABLED namesake.
await check("a disabled 'Apply' pill ahead of the real link is skipped, not waited on", async () => {
  await page.setContent(`<!doctype html><body>
    <button disabled type="text" class="dropbtn1" onclick="alert('nope')">Apply</button>
    <a href="#real" id="real-apply" onclick="document.title='ENTERED'">Apply</a>
  </body>`);
  const matches = page.getByText("Apply");
  assert.ok(await matches.count() > 1, "both namesakes match — that's the premise");
  // The rule preferActionableNamesake applies: first visible AND enabled match wins.
  let pick = matches.first();
  if (!(await pick.isVisible() && await pick.isEnabled().catch(() => true))) {
    for (let k = 1; k < await matches.count(); k++) {
      const c = matches.nth(k);
      if (await c.isVisible() && await c.isEnabled().catch(() => true)) { pick = c; break; }
    }
  }
  await pick.click({ timeout: 3000 });
  assert.equal(await page.title(), "ENTERED", "the ENABLED link was the one clicked");
});

// A DOCUMENT *ABOUT* APPLYING IS NOT THE WAY TO APPLY.
//
// Found by running this finder against 66 live portals: Lynnwood's SmartGov portal offers
// "Permit Application Checklist" — a PDF — and it matched /\bpermit application\b/ exactly,
// so the entry pass would have opened a handout, then reported that it had entered the
// application flow. Every portal publishes this class of link beside the real one.
await check("a checklist/instructions document is never mistaken for the way in", async () => {
  const documents = [
    "Permit Application Checklist",
    "Solar Permit Application Instructions",
    "Permit Application Guide",
    "Sample Permit Application",
    "Permit Application Requirements",
    "Application FAQ",
    "New Application Tutorial",
  ];
  for (const doc of documents) {
    assert.equal(isExcludedEntryLabel(doc), true, `should exclude: ${doc}`);
    assert.equal(matchesEntryLabel(doc), false, `should not match: ${doc}`);
  }
});

await check("...and the real entry controls beside them still match", async () => {
  // The exclusion must not cost us the genuine labels seen live during the same sweep.
  for (const good of ["Apply", "Apply for a Permit", "Apply Here", "Click to Apply Online",
                      "Submit an Application/Request", "Create an Application",
                      "New Interconnection Application"]) {
    assert.equal(matchesEntryLabel(good), true, `should match: ${good}`);
  }
});

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} applicationEntry.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll applicationEntry.dom.smoke checks passed.");
process.exit(0);
