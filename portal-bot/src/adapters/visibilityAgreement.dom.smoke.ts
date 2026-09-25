// TWO VISIBILITY CHECKS THAT MUST AGREE — NOW MEASURED ON THE BOT'S OWN CODE.
//
// PGE's inverter Model step failed identically after three separate fixes, and the diagnostic
// line never moved: `resolved <input id="pcInputBase34" label="Model" visible=false>`. The
// level-acceptance test asked Playwright isVisible() while the diagnostic computed visibility
// itself, and Playwright calls a 1x1 or opacity:0 control VISIBLE — so three rescues shipped into
// a branch that never ran.
//
// This file used to prove that divergence against its OWN inline copy of the diagnostic, so it
// passed with the bot code deleted. It now drives the real code:
//   - portal-bot/src/visibility.ts          — the one shared predicate (visible / usable / via);
//   - RecipeAdapter.isTrulyVisible           — replay's gate, until replay adopts visibility.ts;
//   - autoLearnAdapter.hasVisibleWidgetFaceInPage — the learn side's widget-face rule.
// and asserts they agree, except on a DECLARED drift list. A declared drift that stops diverging
// fails too, so the list is emptied the day replay adopts the shared predicate instead of rotting.
//   npx tsx portal-bot/src/adapters/visibilityAgreement.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe } from "../../../shared/src/types";
import { visibilityOf } from "../visibility";
import { RecipeAdapter } from "./recipeAdapter";
import { hasVisibleWidgetFaceInPage } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Every way a portal hides a control while leaving it in the DOM.
const PAGE = `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; }
  .zeroOpacity { opacity: 0; }
  .tiny { width: 1px; height: 1px; padding: 0; border: 0; }
  .offscreen { position: absolute; left: -9999px; }
  .clipped { position: absolute; clip-path: inset(50%); width: 1px; height: 1px; overflow: hidden; }
</style></head><body>
  <label for="normal">Model</label><input id="normal" />
  <label for="zeroOpacity">Model</label><input id="zeroOpacity" class="zeroOpacity" />
  <label for="tiny">Model</label><input id="tiny" class="tiny" />
  <label for="offscreen">Model</label><input id="offscreen" class="offscreen" />
  <label for="clipped">Model</label><input id="clipped" class="clipped" />
  <label for="hiddenVis">Model</label><input id="hiddenVis" style="visibility:hidden" />
  <label for="displayNone">Model</label><input id="displayNone" style="display:none" />
  <div style="opacity:0"><label for="parentOpacity">Model</label><input id="parentOpacity" /></div>
  <div class="t-widget t-dropdown"><div class="t-dropdown-wrap"><span class="t-input">STAND-ALONE</span></div><input id="widgetBacking" style="display:none"></div>
  <div class="dropdown"><input id="deadWidget" style="display:none"></div>
</body></html>`;

const IDS = ["normal", "zeroOpacity", "tiny", "offscreen", "clipped", "hiddenVis", "displayNone", "parentOpacity"];

/** Where replay's private isTrulyVisible still differs from the shared predicate, and why. Each
 *  entry must STILL differ — remove it when recipeAdapter adopts visibility.ts. */
const DECLARED_REPLAY_DRIFT: Record<string, string> = {
  offscreen: "replay's box test never looks at position, so a left:-9999px input reads as visible",
  parentOpacity: "replay reads only the element's own opacity, not an ancestor's",
  clipped: "replay ignores clip-path, and a 1px input's padding+border make its box > 2px",
};

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const recipe = { id: "va", scopeType: "ahj", profileKey: "x|y|z", state: "OR", ahj: "X", utility: "", portalPlatform: "",
  portalUrl: "", status: "complete", version: 1, steps: [], createdBy: "t", createdAt: "", updatedAt: "", notes: "" } as unknown as PortalRecipe;
const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;
const replayVisible = (sel: string): Promise<boolean> =>
  (adapter as unknown as { isTrulyVisible(l: unknown): Promise<boolean> }).isTrulyVisible(page.locator(sel));

const rows: Array<{ id: string; pw: boolean; shared: boolean; replay: boolean }> = [];
for (const id of IDS) {
  const pw = await page.locator(`#${id}`).isVisible().catch(() => false);
  const shared = (await visibilityOf(page.locator(`#${id}`))).visible;
  const replay = await replayVisible(`#${id}`);
  rows.push({ id, pw, shared, replay });
}

console.log("\n   control          playwright   shared   replay   ");
for (const r of rows) {
  console.log(`   ${r.id.padEnd(16)} ${String(r.pw).padEnd(12)} ${String(r.shared).padEnd(8)} ${String(r.replay).padEnd(8)}` +
    `${r.shared !== r.replay ? ` <- replay drift${DECLARED_REPLAY_DRIFT[r.id] ? " (declared)" : " (UNDECLARED)"}` : ""}`);
}

check("a normally rendered control is visible by every measure",
  rows[0].pw && rows[0].shared && rows[0].replay, JSON.stringify(rows[0]));

// THE DIVERGENCE FROM PLAYWRIGHT IS REAL AND IS THE POINT: it counts opacity:0 and 1x1 controls as
// visible, and both are how a portal hides a native input behind a styled widget. Asserted so that
// nobody "fixes" it by switching a gate back to Playwright's answer.
const pwDiverging = rows.filter((r) => r.pw !== r.shared).map((r) => r.id).sort();
check("Playwright disagrees with the shared predicate on opacity 0, 1x1, off-screen, clipped and ancestor opacity",
  JSON.stringify(pwDiverging) === JSON.stringify(["clipped", "offscreen", "parentOpacity", "tiny", "zeroOpacity"]),
  `diverging: ${JSON.stringify(pwDiverging)}`);

check("the shapes a portal uses to conceal a control read as HIDDEN by the shared predicate",
  rows.filter((r) => r.id !== "normal").every((r) => !r.shared), JSON.stringify(rows.filter((r) => r.shared)));

const undeclared = rows.filter((r) => r.shared !== r.replay && !DECLARED_REPLAY_DRIFT[r.id]).map((r) => r.id);
check("replay's gate agrees with the shared predicate everywhere except the declared drift",
  undeclared.length === 0, `undeclared drift: ${JSON.stringify(undeclared)}`);
const healed = Object.keys(DECLARED_REPLAY_DRIFT).filter((id) => {
  const r = rows.find((x) => x.id === id);
  return !r || r.shared === r.replay;
});
check("every declared drift still diverges (empty the list when replay adopts visibility.ts)",
  healed.length === 0, `no longer diverging — remove from DECLARED_REPLAY_DRIFT: ${JSON.stringify(healed)}`);

// The widget-face rule: the learn side's answer and the shared predicate's `via` must agree.
for (const id of ["widgetBacking", "deadWidget", "normal"]) {
  const learn = await page.locator(`#${id}`).evaluate(hasVisibleWidgetFaceInPage);
  const v = await visibilityOf(page.locator(`#${id}`));
  const sharedFace = v.via === "widget-face";
  check(`widget face "${id}": learn-side hasVisibleWidgetFaceInPage (${learn}) == shared via=widget-face (${sharedFace})`,
    id === "normal" ? !sharedFace : learn === sharedFace, JSON.stringify(v));
}

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} visibility-agreement check(s) FAILED — see the table above.`);
  process.exit(1);
}
console.log("\nAll visibility-agreement checks passed.");
process.exit(0);
