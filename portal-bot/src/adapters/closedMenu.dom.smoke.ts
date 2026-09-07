// THE ENTRY POINT WAS BEHIND A MENU THAT WAS SHUT.
//
// Both Coos Bay recipes died on step 1 for six live runs. The markup below is Oregon
// ePermitting's own, copied from the page a failing step finally saved:
//
//   <div class="dropdown">
//     <button class="dropbtn1" disabled onclick="alert('Button was clicked!');">
//       <i class="material-icons">check_circle</i>Apply
//     </button>
//     <div class="dropdown-content">
//       <a href="...?module=Building">Building Dept Application</a>
//       ...
//
// Three separate defences each answered correctly and the filing still could not start:
//   • the recorded text "Apply" matched the trigger, which is `disabled` ON PURPOSE — this
//     is a CSS hover menu, so its button is never meant to be clicked;
//   • the icon ligature makes the trigger's name "check_circleApply", so role+name missed it;
//   • the name-based recovery found nothing, because the destinations say "Building Dept
//     Application" and contain no "Apply" at all.
//
// It is the "present but shut" pattern one level up: not a concealed field but a concealed
// MENU. Hover the trigger; then choose among what appears — and REFUSE to choose when
// nothing distinguishes the entries, because filing under the wrong module is worse than not
// filing.
//   npx tsx portal-bot/src/adapters/closedMenu.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Oregon ePermitting's nav, reduced but structurally faithful: a disabled trigger carrying
// an icon ligature, and a CSS-hover menu of module applications behind it.
const page = (items: string): string => `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; }
  .dropdown { position: relative; display: inline-block; }
  .dropdown-content { display: none; position: absolute; background: #fff; border: 1px solid #999; min-width: 240px; }
  .dropdown-content a { display: block; padding: 10px 14px; }
  .dropdown:hover .dropdown-content { display: block; }
  .dropbtn1 { padding: 10px 16px; background: #c60; color: #fff; border: 0; }
</style></head><body>
  <h2 id="heading">Dashboard</h2>
  <div id="OREGnav">
    <div class="dropdown">
      <button class="dropbtn1" disabled type="text" onclick="alert('Button was clicked!');">
        <i class="material-icons">check_circle</i>Apply
      </button>
      <div class="dropdown-content">${items}</div>
    </div>
  </div>
  <div id="page2" style="display:none"><h3>Review</h3></div>
  <script>
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('.dropdown-content a');
      if (!a) return;
      e.preventDefault();
      window.__picked = a.textContent.trim();
      document.getElementById('heading').textContent = 'Review';
    });
  </script>
</body></html>`;

const BUILDING = `
  <a target="_self" href="/OREGON/Cap/CapApplyDisclaimer.aspx?module=Building">Building Dept Application</a>
  <a target="_self" href="/OREGON/Cap/CapApplyDisclaimer.aspx?module=Onsite">Onsite/Septic Application</a>
  <a target="_self" href="/OREGON/Cap/CapApplyDisclaimer.aspx?module=Planning">Planning Application</a>`;
// Nothing here names a discipline, so nothing should be guessed at.
const AMBIGUOUS = `
  <a target="_self" href="/a">Option One</a>
  <a target="_self" href="/b">Option Two</a>`;

const PAGES: Record<string, string> = { building: page(BUILDING), ambiguous: page(AMBIGUOUS) };
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? page(BUILDING));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const run = async (which: string) => {
  const url = `http://127.0.0.1:${port}/${which}`;
  const recipe = {
    id: `cm-${which}`, scopeType: "ahj", profileKey: "or|city of coos bay|x", state: "OR",
    ahj: "City of Coos Bay", utility: "", discipline: "building",
    portalPlatform: "accela", portalUrl: url, status: "complete", version: 1,
    steps: [
      // The recorded shape, verbatim from the live recipe.
      { action: "click", phase: "open", selector: { text: "Apply", exact: true, fallbacks: [{ role: "link", name: "Apply", exact: true }] }, note: "application entry: Apply" },
    ] as RecipeStep[],
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline2: "",
  } as unknown as PortalRecipe;
  const p = await context.newPage();
  await p.goto(url);
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = p;
  const res = await adapter.fillApplication({} as never);
  const data = (res as unknown as { data?: { driftWarnings?: string[]; skipped?: string[] } }).data ?? {};
  const picked = await p.evaluate(() => (window as unknown as { __picked?: string }).__picked ?? "");
  await p.close();
  return { res, data, picked };
};

// ---------------------------------------------------------------------------
// The live failure, end to end.
// ---------------------------------------------------------------------------
const ok = await run("building");
console.log(`   picked: ${JSON.stringify(ok.picked)}`);
console.log(`   drift:  ${JSON.stringify((ok.data.driftWarnings ?? []).slice(0, 2))}`);

check("THE REGRESSION: the closed menu is opened and the entry is clicked", () => {
  assert.ok(ok.picked, "nothing was clicked — the menu never opened, or the disabled trigger was used again");
});

check("...and it picks the entry matching the recipe's discipline, not merely the first", () => {
  assert.match(ok.picked, /Building/i, `picked ${JSON.stringify(ok.picked)}`);
});

check("...and says what it did, so the recipe can be re-recorded against the real target", () => {
  assert.ok((ok.data.driftWarnings ?? []).some((w) => /closed menu/i.test(w)), JSON.stringify(ok.data.driftWarnings));
});

check("the step is not reported as skipped", () => {
  assert.ok(!(ok.data.skipped ?? []).some((s) => /application entry/i.test(s)), JSON.stringify(ok.data.skipped));
});

// ---------------------------------------------------------------------------
// The refusal. Filing under the wrong module is worse than not filing.
// ---------------------------------------------------------------------------
const amb = await run("ambiguous");
check("REFUSES TO GUESS when nothing identifies which entry the recipe wants", () => {
  assert.equal(amb.picked, "", `it chose ${JSON.stringify(amb.picked)} with nothing to go on`);
});

check("...and names the options it saw, so a human can settle it in one look", () => {
  assert.ok((amb.data.driftWarnings ?? []).some((w) => /Option One/.test(w)), JSON.stringify(amb.data.driftWarnings));
});

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} closed-menu check(s) FAILED.`); process.exit(1); }
console.log("\nAll closed-menu checks passed (real Chromium).");
process.exit(0);
