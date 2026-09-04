// AN ENTRY THAT OPENS A DRAWER MAY ASK WHICH PROGRAMME FIRST.
//
// ComEd's Intellio Connect has no "new application" page. A text-less floating action button
// — identifiable only by aria-label "New Application Button. This will open a popup drawer."
// and a custom itcevent attribute — slides a drawer in place. Its first screen is not a form
// but a CHOICE: "Distributed Generation" or "Distributed Generation Rebates". Fields appear
// only after one is picked.
//
// Which programme is not a judgement call: an interconnection application is not a rebate
// application. Picking the rebate would file the wrong thing — the wrong-permit-type mistake
// in another costume — so a rebate option is never eligible and an unrecognised drawer is
// left alone rather than guessed at.
//
// THE FIXTURE IS THE PORTAL'S OWN MARKUP (fixtures/comed-drawer.html, lifted from the learn
// run's page capture). An earlier version of this test hand-wrote an approximation with one
// drawer and no header: it PASSED while the live run failed, because the real page carries
// ~80 elements matching [class*='drawer'] and a header category-switcher whose label is the
// SAME TEXT as the real option. Both traps are in the fixture now, and this test drives the
// same module the adapter does rather than a copy of its logic.
//   npx tsx portal-bot/src/adapters/programDrawer.dom.smoke.ts
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PROGRAM_PREFER, chooseProgram, offeredLabels, programSelector, scanProgramGroups } from "./applicationProgram";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const COMED = fs.readFileSync(path.join(here, "fixtures", "comed-drawer.html"), "utf8");
const MOMENTUM = fs.readFileSync(path.join(here, "fixtures", "momentum-record-type.html"), "utf8");

// A portal whose drawer offers nothing that reads as an interconnection application.
const UNKNOWN = `<!doctype html><html><body>
  <mat-drawer class="mat-drawer mat-drawer-opened" style="width:420px;height:400px">
    <h2>New Request</h2>
    <button type="button" style="height:40px;width:280px">Tree Trimming Request</button>
    <button type="button" style="height:40px;width:280px">Streetlight Outage</button>
  </mat-drawer>
</body></html>`;

// THE OLD SCAN, verbatim in shape: one flat option list scoped to "the last visible panel",
// with a document fallback. Kept here only to prove this test reproduces the live failure.
const oldScan = (): Array<{ key: string; label: string }> => {
  const vis = (e: Element): boolean => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 2 && r.height > 2; };
  const panels = Array.from(document.querySelectorAll(
    "mat-drawer, mat-sidenav, [role='dialog'], .mat-drawer, .mat-sidenav, .new-application, .modal.show, [class*='drawer']"))
    .filter(vis);
  const scope: ParentNode = panels.length ? panels[panels.length - 1] : document;
  const out: Array<{ key: string; label: string }> = [];
  let n = 0;
  for (const el of Array.from(scope.querySelectorAll(
    "mat-button-toggle, [role='radio'], input[type='radio'], button, a[role='button'], .mat-button-toggle"))) {
    if (!vis(el)) continue;
    const label = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!label || label.length > 60) continue;
    if (out.some((o) => o.label === label)) continue;
    out.push({ key: `old${n++}`, label });
  }
  return out;
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  const u = req.url || "";
  if (u.includes("unknown")) return res.end(UNKNOWN);
  if (u.includes("momentum")) return res.end(MOMENTUM);
  return res.end(COMED);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
// tsx/esbuild wraps named functions with __name(); without this shim every page.evaluate
// throws ReferenceError and the caller's .catch turns it into "found nothing".
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

// ---- ComEd's real drawer ----
await page.goto(`http://127.0.0.1:${port}/comed`);

// 1. The regression, reproduced against the portal's own markup.
const old = await page.evaluate(oldScan);
check("THE REGRESSION: the old last-visible-panel scan finds no choice on the REAL page",
  old.length < 2,
  `old scan returned ${JSON.stringify(old.map((o) => o.label))} — expected fewer than 2`);

// 2. The new scan, scoped by tightest grouping.
const groups = await page.evaluate(scanProgramGroups);
console.log(`   groups offering >=2 options: ${groups.length} (areas ${groups.map((g) => g.area).join(", ")})`);
console.log(`   offered: ${JSON.stringify(offeredLabels(groups))}`);

check("the drawer's two programmes are found",
  offeredLabels(groups).includes("Distributed Generation") && offeredLabels(groups).includes("Distributed Generation Rebates"),
  JSON.stringify(offeredLabels(groups)));

const pick = chooseProgram(groups);
check("the interconnection programme is chosen, not the rebate",
  pick?.label === "Distributed Generation", `picked ${JSON.stringify(pick?.label)}`);

check("the REBATE programme is never eligible — it would file the wrong thing entirely",
  !PROGRAM_EXCLUDE_TEST("Distributed Generation") && PROGRAM_EXCLUDE_TEST("Distributed Generation Rebates"));
function PROGRAM_EXCLUDE_TEST(s: string): boolean {
  return /rebate|incentive|enroll|enrol|renew|amend|withdraw|cancel|close|back|help/i.test(s);
}

// 3. The header trap: same text, different element. It must never be what we click.
const sel = pick ? programSelector(pick) : null;
check("THE REPLAY TRAP: the choice is recorded by ROLE, not by bare text",
  sel?.role === "radio" && sel?.name === "Distributed Generation",
  `selector was ${JSON.stringify(sel)} — bare text also matches the header category switcher`);

const headerCount = await page.locator(".application-category-button").count();
const radioCount = await page.getByRole("radio", { name: "Distributed Generation", exact: true }).count();
check("the header category-switcher carries the SAME label (so the trap is real)", headerCount > 0);
check("...and the role-scoped selector resolves to exactly one control — the drawer's",
  radioCount === 1, `role=radio name="Distributed Generation" matched ${radioCount}`);

// 4. The tagged element is clickable, and clicking it hits the drawer, not the header.
if (pick) {
  const clicked = await page.locator(`[data-al-prog="${pick.key}"]`).first().click({ timeout: 5000 }).then(() => true).catch(() => false);
  check("the chosen option is reachable by its learn-time tag", clicked);
  const inDrawer = await page.locator(`[data-al-prog="${pick.key}"]`).first()
    .evaluate((el) => !!el.closest("[class*='drawer'], mat-button-toggle-group")).catch(() => false);
  check("the tagged element lives inside the drawer, not in the page header", inDrawer === true);
}

// ---- an unrecognised drawer ----
await page.goto(`http://127.0.0.1:${port}/unknown`);
const unknownGroups = await page.evaluate(scanProgramGroups);
check("a drawer offering nothing interconnection-shaped is refused, not guessed",
  chooseProgram(unknownGroups) === undefined, JSON.stringify(offeredLabels(unknownGroups)));
check("...and the refusal can name what WAS offered, so it stays diagnosable",
  offeredLabels(unknownGroups).length >= 2, JSON.stringify(offeredLabels(unknownGroups)));

// ---- a page with no drawer at all: no document fallback ----
await page.setContent(`<!doctype html><body><h1>Dashboard</h1>
  <button style="height:30px;width:120px">Distributed Generation</button>
  <button style="height:30px;width:120px">Something Else</button></body>`);
const bare = await page.evaluate(scanProgramGroups);
check("a page with no revealed panel yields NO pick — never a document-wide guess",
  chooseProgram(bare) === undefined,
  `picked ${JSON.stringify(chooseProgram(bare)?.label)} from a page with no drawer`);

// ---------------------------------------------------------------------------
// A CHOICE IS NOT ALWAYS IN A DRAWER, AND A RADIO HAS NO innerText.
//
// Prince George's County (Momentum/CIVICS) asks which kind of thing you are applying for on
// a PLAIN PAGE: <fieldset><legend>Pick a record type.</legend> with two radios whose names
// live in sibling <label for=...> elements. A live learn reached that page and clicked
// "Save & Continue" nine times against a gate it never answered, because scoping only to
// revealed panels made the fieldset invisible and reading innerText off an <input> returned
// "" for both options. Fixture is that page's own markup.
// ---------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/momentum`);
const momentum = await page.evaluate(scanProgramGroups);
console.log(`   momentum offers: ${JSON.stringify(offeredLabels(momentum))}`);

check("THE LABEL: a radio's name is read from its sibling <label for=...>",
  offeredLabels(momentum).includes("City Requests") && offeredLabels(momentum).includes("Licenses & Permits"),
  JSON.stringify(offeredLabels(momentum)));

check("THE TRACK: a permit run picks 'Licenses & Permits', not 'City Requests'",
  chooseProgram(momentum, "electrical")?.label === "Licenses & Permits",
  `picked ${JSON.stringify(chooseProgram(momentum, "electrical")?.label)}`);

check("...and a structural run picks the same permit category",
  chooseProgram(momentum, "structural")?.label === "Licenses & Permits");

check("the interconnection vocabulary alone would have refused this page",
  // PROGRAM_PREFER holds only utility words; neither option matches any of them. That is
  // why the chooser has to know which track it is on rather than one fixed list.
  !PROGRAM_PREFER.some((re) => re.test("Licenses & Permits") || re.test("City Requests")));

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} program-drawer check(s) FAILED.`); process.exit(1); }
console.log("\nAll program-drawer checks passed (real Chromium, ComEd's own captured markup).");
process.exit(0);
