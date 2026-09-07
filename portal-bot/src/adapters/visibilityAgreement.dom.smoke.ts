// TWO VISIBILITY CHECKS THAT MUST AGREE, AND MIGHT NOT.
//
// PGE's inverter Model step failed identically after three separate fixes, and the
// diagnostic line never moved: `resolved <input id="pcInputBase34" label="Model"
// visible=false>`. An identical signature after three different fixes does not mean the
// fixes missed — it means they were never on the executed path.
//
// The suspect is a disagreement inside our own code. The level-acceptance test in
// resolveLocator asks Playwright `isVisible()`. The diagnostic that prints `visible=false`
// computes visibility itself, from getBoundingClientRect and computed style. If Playwright
// calls a 1x1 or opacity:0 combobox VISIBLE while our diagnostic calls it hidden, then
// `usable` passes, level 0 is accepted, and every rescue built downstream — the enabled
// check, the no-fallback fall-through, the unpinned ordinal twin — is dead code for that
// step. Three fixes shipped into a branch that never ran.
//
// This settles it without touching a portal: drive both answers over the shapes a portal
// actually uses to conceal a control, and print them side by side.
//   npx tsx portal-bot/src/adapters/visibilityAgreement.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";

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
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const IDS = ["normal", "zeroOpacity", "tiny", "offscreen", "clipped", "hiddenVis", "displayNone"];
const rows: Array<{ id: string; pw: boolean; ours: boolean }> = [];
for (const id of IDS) {
  const pw = await page.locator(`#${id}`).isVisible().catch(() => false);
  // The diagnostic's own notion, as describeResolved computes it.
  const ours = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
  }, `#${id}`);
  rows.push({ id, pw, ours });
}

console.log("\n   control          playwright   ourDiagnostic   agree");
for (const r of rows) {
  console.log(`   ${r.id.padEnd(16)} ${String(r.pw).padEnd(12)} ${String(r.ours).padEnd(15)} ${r.pw === r.ours ? "yes" : "NO  <-- divergence"}`);
}

// ---------------------------------------------------------------------------
// What matters is not which is "right" — it is that ONE of them gates the action
// while the OTHER writes the diagnostic a human reads.
// ---------------------------------------------------------------------------
const diverging = rows.filter((r) => r.pw !== r.ours);
check("a normally rendered control is visible by both measures",
  rows[0].pw && rows[0].ours, JSON.stringify(rows[0]));

// THE DIVERGENCE IS REAL AND IS THE POINT — Playwright counts an opacity:0 and a 1x1 control
// as visible, and both are how a portal hides a native input behind a styled widget. This
// asserts the divergence still EXISTS, so that nobody "fixes" it by quietly switching the
// acceptance test back to Playwright's answer and re-breaking three rescues at once.
check("Playwright and a human disagree about opacity:0 and 1x1 — that is why the gate is ours",
  diverging.length === 2 && diverging.every((d) => ["zeroOpacity", "tiny"].includes(d.id)),
  `expected exactly zeroOpacity and tiny to diverge, got ${JSON.stringify(diverging.map((d) => d.id))}`);

check("...and the shapes a portal uses to conceal a control read as HIDDEN by our measure",
  rows.filter((r) => ["zeroOpacity", "tiny", "hiddenVis", "displayNone"].includes(r.id)).every((r) => !r.ours),
  JSON.stringify(rows.filter((r) => r.ours)));

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} visibility-agreement check(s) FAILED — see the divergence above.`);
  process.exit(1);
}
console.log("\nAll visibility-agreement checks passed.");
process.exit(0);
