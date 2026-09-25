// A REQUIRED EMAIL IS FILLED FROM THE IDENTITY ITS SECTION HEADING NAMES.
//
// PowerClerk's Customer Information block has a required Email the planner left blank while
// the project held the address all along; "Property Owner Information" then mirrored the
// customer block read-only, so one blank showed up as two and the portal refused the filing.
// fillSectionEmails matches on the SECTION HEADING above the control and fills from the
// identity that heading names — only a REQUIRED, still-EMPTY, editable, visible box.
//
// This smoke used to test its OWN copy of the scan and of the routing rule ("mirroring
// fillSectionEmails"), so it passed with the bot code deleted. It now runs
// AutoLearnAdapter.fillSectionEmails itself and reads back what landed where.
// All identities here are fictional.
//   npx tsx portal-bot/src/adapters/sectionEmail.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import type { RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const OWNER_EMAIL = "owner.fixture@example.com";
const INSTALLER_EMAIL = "installer.fixture@example.com";
const PHONE = "(555) 010-0100";

// PowerClerk's own shape: section heading, then the contact block. Page 4 mirrors page 3
// read-only exactly as the live screenshot showed.
const PAGE = `<!doctype html><html><body>
  <section>
    <h3>Customer Information</h3>
    <div><label for="c-email">Email *</label><input id="c-email" type="text"></div>
    <div><label for="c-phone">Phone *</label><input id="c-phone" type="text" value="${PHONE}"></div>
  </section>
  <section>
    <h3>Property Owner Information</h3>
    <div><label for="p-email">Email *</label><input id="p-email" type="text" readonly></div>
  </section>
  <section>
    <h3>Installer Information</h3>
    <div><label for="i-email">Email *</label><input id="i-email" type="text"></div>
  </section>
  <section>
    <h3>Interconnection Details</h3>
    <div><label for="n-email">Notification Email</label><input id="n-email" type="text"></div>
  </section>
  <section>
    <h3>Some Unknown Information</h3>
    <div><label for="u-email">Email *</label><input id="u-email" type="text"></div>
  </section>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const planner: LearnPlanner = async () => ({ fills: [], atReview: true });
const makeAdapter = (withEmails: boolean): AutoLearnAdapter => {
  const a = new AutoLearnAdapter("Section Email Fixture", planner, {
    maxPages: 1,
    ...(withEmails ? { contactIdentity: { email: INSTALLER_EMAIL }, siteContactIdentity: { email: OWNER_EMAIL } } : {}),
  });
  (a as unknown as { page: unknown }).page = page;
  return a;
};
type EmailPass = { fillSectionEmails(s: RecipeStep[], a: string[]): Promise<number> };

const steps: RecipeStep[] = [];
const filled = await (makeAdapter(true) as unknown as EmailPass).fillSectionEmails(steps, []);
const v = async (id: string): Promise<string> => page.locator(`#${id}`).inputValue();
console.log(`  filled ${filled}; fields bound ${JSON.stringify(steps.map((s) => s.field))}`);

check("THE REGRESSION: the customer block's required Email is filled with the OWNER's email",
  (await v("c-email")) === OWNER_EMAIL, `got ${JSON.stringify(await v("c-email"))}`);
check("the installer block's Email gets the INSTALLER's email, not the owner's",
  (await v("i-email")) === INSTALLER_EMAIL, `got ${JSON.stringify(await v("i-email"))}`);
check("the READ-ONLY mirrored Property Owner block is never touched", (await v("p-email")) === "");
check("an OPTIONAL email (no asterisk) is left alone", (await v("n-email")) === "");
check("a required email under an UNRECOGNISED heading stays EMPTY — refused, not guessed", (await v("u-email")) === "");
check("an already-answered field is never overwritten", (await v("c-phone")) === PHONE);
check("exactly two boxes filled, recorded as BOUND steps (never the literal — recipes are shared)",
  filled === 2 && steps.length === 2
    && steps.some((s) => s.field === "homeownerEmail") && steps.some((s) => s.field === "installerEmail")
    && !JSON.stringify(steps).includes("@example.com"),
  JSON.stringify(steps));

// No identity email at all: the pass must do nothing, whatever the page asks for.
await page.goto(`http://127.0.0.1:${port}/`);
const none = await (makeAdapter(false) as unknown as EmailPass).fillSectionEmails([], []);
check("no email in either identity → the pass does nothing", none === 0 && (await v("c-email")) === "", `filled ${none}`);

// A page with nothing required must produce no work at all.
await page.setContent(`<!doctype html><body><h3>Contact Information</h3>
  <label for="e">Email</label><input id="e" type="text"></body>`);
const optional = await (makeAdapter(true) as unknown as EmailPass).fillSectionEmails([], []);
check("no required email anywhere → the pass does nothing", optional === 0 && (await v("e")) === "", `filled ${optional}`);

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} section-email check(s) FAILED.`); process.exit(1); }
console.log("\nAll section-email checks passed (real Chromium, real fillSectionEmails).");
process.exit(0);
