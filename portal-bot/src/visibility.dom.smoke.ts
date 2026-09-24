// ONE VISIBILITY PREDICATE, AND THE DISAGREEMENTS THAT MADE IT NECESSARY.
//
// portal-bot/src/visibility.ts answers two questions at once — can a PERSON see this control,
// and may the ENGINE drive it (and how). This drives it in real Chromium over every shape a
// portal uses to conceal a control, and pins the cases where it deliberately disagrees with
// Playwright's isVisible():
//   - opacity:0 and 1x1 inputs: Playwright says visible; a person cannot see them.
//   - off-screen (left:-9999px): Playwright AND the old bot check both said visible.
//   - the styled checkbox (Ameren's terms switch): the real input is concealed, so NOT visible —
//     but it IS usable, via its visible label. Both halves matter: calling it usable-via-self
//     switches `force` off and the click hits a decoration (90ed1c3); calling it unusable fires
//     rescues that swap the control out (afba4a3).
//   - a dropdown widget's hidden backing input: usable via its widget face (14d1cef).
// And the MUST-EXCLUDE side: disabled, inside a disabled fieldset, aria-hidden behind a modal,
// a concealed checkbox with no visible label.
//
// The page is loaded WITHOUT the __name shim, on purpose: the in-page function must run bare.
//   npx tsx portal-bot/src/visibility.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { isTrulyVisible, isUsable, visibilityOf, type UsableVia } from "./visibility";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; }
  .switch { position: relative; display: inline-block; width: 40px; height: 20px; background: #ccc; border-radius: 10px; }
  .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .srOnly { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .collapse { overflow: hidden; height: 0; }
</style></head><body>
  <label for="normal">Name</label><input id="normal">
  <input id="zeroOpacity" style="opacity:0">
  <input id="tiny" style="width:1px;height:1px;padding:0;border:0">
  <input id="offscreen" style="position:absolute;left:-9999px">
  <input id="clipped" style="position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden">
  <input id="clipRect" class="srOnly">
  <input id="hiddenVis" style="visibility:hidden">
  <input id="displayNone" style="display:none">
  <div style="opacity:0"><input id="parentOpacity"></div>
  <div style="display:none"><input id="parentNone"></div>
  <div class="collapse"><input id="collapsed"></div>
  <p style="margin-top:900px"><label for="belowFold">Below the fold</label><input id="belowFold"></p>

  <!-- Ameren-shaped styled switch: concealed input, the LABEL carries the handler. -->
  <label class="switch" for="terms"><input type="checkbox" id="terms"><span></span></label> I accept the terms
  <!-- A concealed checkbox with NO visible label: nothing a person can click. -->
  <input type="checkbox" id="orphanBox" style="opacity:0">
  <div style="display:none"><label for="hiddenLabelBox">Hidden label</label></div><input type="checkbox" id="hiddenLabelBox" style="opacity:0">

  <!-- Telerik-shaped dropdown: hidden backing input, visible face. -->
  <div class="t-widget t-dropdown"><div class="t-dropdown-wrap"><span class="t-input">STAND-ALONE</span></div><input id="widgetBacking" style="display:none"></div>
  <!-- select2-shaped: native select hidden, widget is its next sibling. -->
  <select id="s2" class="select2-hidden-accessible" style="position:absolute;width:1px;height:1px;opacity:0"><option>A</option></select><span class="select2-container" style="display:inline-block;width:120px;height:24px">A</span>
  <!-- A dropdown-ish container showing nothing: must stay unusable. -->
  <div class="dropdown"><input id="deadWidget" style="display:none"></div>

  <input id="disabled" disabled>
  <fieldset disabled><legend>Owner</legend><input id="fieldsetDisabled"></fieldset>
  <input id="ariaDisabled" aria-disabled="true">
  <div aria-hidden="true"><input id="behindModal"></div>
  <div inert><input id="inertInput"></div>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
// NO __name shim here, deliberately.
const page = await (await browser.newContext()).newPage();
await page.goto(`http://127.0.0.1:${port}/`);

// [id, person can see it, engine may drive it, how]
const EXPECT: Array<[string, boolean, boolean, UsableVia]> = [
  ["normal", true, true, "self"],
  ["belowFold", true, true, "self"],
  ["zeroOpacity", false, false, "none"],
  ["tiny", false, false, "none"],
  ["offscreen", false, false, "none"],
  ["clipped", false, false, "none"],
  ["clipRect", false, false, "none"],
  ["hiddenVis", false, false, "none"],
  ["displayNone", false, false, "none"],
  ["parentOpacity", false, false, "none"],
  ["parentNone", false, false, "none"],
  ["collapsed", false, false, "none"],
  ["terms", false, true, "label"],
  ["orphanBox", false, false, "none"],
  ["hiddenLabelBox", false, false, "none"],
  ["widgetBacking", false, true, "widget-face"],
  ["s2", false, true, "widget-face"],
  ["deadWidget", false, false, "none"],
  ["disabled", true, false, "none"],
  ["fieldsetDisabled", true, false, "none"],
  ["ariaDisabled", true, false, "none"],
  ["behindModal", true, false, "none"],
  ["inertInput", true, false, "none"],
];

const rows: string[] = [];
for (const [id, visible, usable, via] of EXPECT) {
  const v = await visibilityOf(page.locator(`#${id}`));
  const pw = await page.locator(`#${id}`).isVisible();
  rows.push(`   ${id.padEnd(17)} pw=${String(pw).padEnd(5)} visible=${String(v.visible).padEnd(5)} usable=${String(v.usable).padEnd(5)} via=${v.via.padEnd(11)} ${v.reasons.join("; ")}`);
  check(`${id}: visible=${visible} usable=${usable} via=${via}`,
    v.known && v.visible === visible && v.usable === usable && v.via === via, JSON.stringify(v));
}
console.log(`\n${rows.join("\n")}\n`);

// The deliberate disagreements with Playwright — if any of these starts agreeing, someone has
// switched the predicate back to Playwright's answer.
const disagree: string[] = [];
for (const id of ["zeroOpacity", "tiny", "offscreen", "clipped", "collapsed", "parentOpacity", "orphanBox"]) {
  const pw = await page.locator(`#${id}`).isVisible();
  if (pw !== (await isTrulyVisible(page.locator(`#${id}`)))) disagree.push(id);
}
check("the known disagreements with Playwright are all still disagreements (opacity 0, 1x1, off-screen, clipped, collapsed parent, ancestor opacity)",
  disagree.length === 7, `disagreeing: ${JSON.stringify(disagree)}`);

check("isUsable agrees with the verdict (styled checkbox usable, off-screen not)",
  (await isUsable(page.locator("#terms"))) && !(await isUsable(page.locator("#offscreen"))));

const missing = await visibilityOf(page.locator("#doesNotExist"));
check("an element that is not there is UNKNOWN, not a confident hidden", !missing.known && !missing.usable, JSON.stringify(missing));

// A styled checkbox usable via its label is actually tickable through that label.
await page.locator("label[for=terms]").click();
check("...and clicking the label (what 'via: label' tells the engine to do) ticks it",
  await page.locator("#terms").isChecked());

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} visibility check(s) FAILED.`); process.exit(1); }
console.log("All visibility checks passed.");
process.exit(0);
