// AN ENTRY THAT OPENS A DRAWER MAY ASK WHICH PROGRAMME FIRST.
//
// ComEd's Intellio Connect has no "new application" page. A text-less floating action button
// — identifiable only by aria-label "New Application Button. This will open a popup drawer."
// and a custom itcevent attribute — slides a drawer in place. Its first screen is not a form
// but a CHOICE: "Distributed Generation" or "Distributed Generation Rebates". Fields appear
// only after one is picked.
//
// A live learn clicked the button, watched the page grow by 32 KB (the drawer opening), then
// reported "found nothing fillable on 3 page(s)" while standing on the choice with no steps
// recorded. This pins the rule that fixes it — and the fixture below is the REAL markup,
// lifted from that run's own page capture.
//
// Which programme is not a judgement call: an interconnection application is not a rebate
// application. Picking the rebate would file the wrong thing — the mechanical-permit mistake
// in another costume — so a rebate option is never eligible and an unrecognised drawer is
// left alone rather than guessed at.
//   npx tsx portal-bot/src/adapters/programDrawer.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// The page-side scan + choice, mirroring chooseApplicationProgram.
const scanProgram = (): Array<{ key: string; label: string }> => {
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
    const key = `ap${n++}`;
    (el as HTMLElement).setAttribute("data-al-prog", key);
    out.push({ key, label });
  }
  return out;
};

const EXCLUDE = /rebate|incentive|enroll|enrol|renew|amend|withdraw|cancel|close|back|help/i;
const PREFER: RegExp[] = [/interconnect|net.?meter|\bnem\b/i, /solar|photovoltaic|\bpv\b/i, /distributed generation|\bdg\b/i, /generation/i];
const choose = (list: Array<{ key: string; label: string }>): { key: string; label: string } | undefined => {
  if (list.length < 2) return undefined;
  const eligible = list.filter((o) => !EXCLUDE.test(o.label));
  for (const re of PREFER) { const hit = eligible.find((o) => re.test(o.label)); if (hit) return hit; }
  return undefined;
};

// ComEd's real drawer, as captured: an Angular Material toggle group inside the drawer,
// with Cancel/submit beside it and unrelated chrome outside it.
const COMED = `<!doctype html><html><body>
  <div class="header"><button class="application-category-button"><span>Distributed Generation</span></button></div>
  <mat-drawer class="mat-drawer mat-drawer-opened new-application" style="width:420px;height:600px">
    <h2>New Application</h2>
    <mat-button-toggle-group style="display:block">
      <mat-button-toggle style="display:block;height:40px"><button type="button" class="mat-button-toggle-button" style="height:40px;width:300px">Distributed Generation</button></mat-button-toggle>
      <mat-button-toggle style="display:block;height:40px"><button type="button" class="mat-button-toggle-button" style="height:40px;width:300px">Distributed Generation Rebates</button></mat-button-toggle>
    </mat-button-toggle-group>
    <button type="button" style="height:30px;width:90px">Cancel</button>
    <button type="submit" style="height:30px;width:90px">Next</button>
  </mat-drawer>
</body></html>`;

// A portal whose drawer offers nothing that reads as an interconnection application.
const UNKNOWN = `<!doctype html><html><body>
  <mat-drawer class="mat-drawer mat-drawer-opened" style="width:420px;height:400px">
    <h2>New Request</h2>
    <button type="button" style="height:40px;width:280px">Tree Trimming Request</button>
    <button type="button" style="height:40px;width:280px">Streetlight Outage</button>
  </mat-drawer>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end((req.url || "").includes("unknown") ? UNKNOWN : COMED);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

// ---- ComEd's real drawer ----
await page.goto(`http://127.0.0.1:${port}/comed`);
const found = await page.evaluate(scanProgram);
console.log(`   drawer offers: ${JSON.stringify(found.map((f) => f.label))}`);

check("the drawer's options are found (scoped to the drawer, not the whole page)",
  found.some((f) => f.label === "Distributed Generation") && found.some((f) => f.label === "Distributed Generation Rebates"),
  JSON.stringify(found.map((f) => f.label)));

const pick = choose(found);
check("THE REGRESSION: the interconnection programme is chosen, not the rebate",
  pick?.label === "Distributed Generation", `picked ${JSON.stringify(pick?.label)}`);

check("the REBATE programme is never eligible — it would file the wrong thing entirely",
  !EXCLUDE.test("Distributed Generation") && EXCLUDE.test("Distributed Generation Rebates"));

check("Cancel is never chosen even though it sits in the same drawer",
  pick?.label !== "Cancel");

// The choice is clickable through the tag the pass sets.
if (pick) {
  const clicked = await page.locator(`[data-al-prog="${pick.key}"]`).first().click({ timeout: 5000 }).then(() => true).catch(() => false);
  check("the chosen option is reachable by its learn-time tag", clicked);
}

// ---- an unrecognised drawer ----
await page.goto(`http://127.0.0.1:${port}/unknown`);
const unknown = await page.evaluate(scanProgram);
check("a drawer offering nothing interconnection-shaped is refused, not guessed",
  choose(unknown) === undefined, JSON.stringify(unknown.map((u) => u.label)));

// ---- a page with no drawer at all ----
await page.setContent(`<!doctype html><body><h1>Dashboard</h1><button style="height:30px;width:80px">Only One</button></body>`);
check("a page that is not a choice screen produces no pick",
  choose(await page.evaluate(scanProgram)) === undefined);

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} program-drawer check(s) FAILED.`); process.exit(1); }
console.log("\nAll program-drawer checks passed (real Chromium, ComEd's captured markup).");
process.exit(0);
