// A FIELD'S OWN TEXT IS NEVER ITS LABEL, ON ANY ROUTE (hard rule 2; recorder skeptic F5).
//
// Two holes the recorder skeptic showed with real Chromium (probes G-a, G-b, H):
//   1. <label for=m>Meter <select id=m>..1009283745..</select></label>: controlLabelInPage and
//      fieldIdentityInPage returned the raw label[for] textContent — "Meter --1009283745" — so the
//      option text reached selector.name and note, and BARE_METER_LABEL stopped matching (the step
//      was recorded sensitive:false WITH the literal). Only the wrapping-label route stripped it.
//   2. A select2 face over <select name=meterNumber> with <label for>Meter Number</label>: the
//      recorder's custom-dropdown path took identity and label from the WIDGET — role=combobox,
//      name from aria-labelledby -> the rendered selection (the current value) — so the meter number
//      was stored as a literal, sensitive:false.
//
// MUST-EXCLUDE: both shapes are sensitive in the recorder (and the label-wrapped one in
//   humanCapture), with no option text and no previously selected value anywhere in selector, note
//   or fingerprint.
// MUST-PASS: the same shapes over a "Utility" select keep label 'Utility' and value 'PGE'.
//
// CLOSE-MUSTFIX MF3: the rendered-value rule is generic (isRenderedValueOf) — a plain ARIA
// combobox labelled "lbl cur" with #cur a sibling showing the prior value, and a PrimeFaces-shaped
// <id>_label; plus should-fix (c): a sensitive step keeps no digit run of 6+ in its kept text.
//
// Run: npx tsx portal-bot/src/recorderLabelLeak.dom.smoke.ts
import "./smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../shared/src/portalSafety";
import { captureScript, createRecorderSink, type RecordedPayload } from "./recordRecipe";
import { armHumanCaptureOnPage } from "./humanCapture";
import type { RecipeStep } from "../../shared/src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail.replace(/1009283745|5550001111/g, "<SECRET>")}`); }
};

const SECRET = "1009283745";
const PREVIOUS = "5550001111";
const html = (b: string) => `<!doctype html><html><body><form onsubmit="return false">${b}</form></body></html>`;
const wrapFor = (lbl: string, opt: string) => html(`<label for="m">${lbl} <select id="m" name="m"><option value="">--</option><option>${opt}</option></select></label>`);
const select2 = (lbl: string, name: string, opt: string) => html(`
    <label for="meter">${lbl}</label>
    <select id="meter" name="${name}" class="select2-hidden-accessible" aria-hidden="true" tabindex="-1"><option value="">Select...</option><option value="${opt}">${opt}</option></select>
    <span class="select2 select2-container"><span class="selection"><span id="sel" class="select2-selection select2-selection--single" role="combobox" aria-haspopup="true" aria-expanded="true" aria-labelledby="select2-meter-container" aria-owns="select2-meter-results"><span class="select2-selection__rendered" id="select2-meter-container" role="textbox" aria-readonly="true" title="${PREVIOUS}">${PREVIOUS}</span></span></span></span>
    <span class="select2-container select2-container--open"><span class="select2-dropdown"><span class="select2-results"><ul class="select2-results__options" role="listbox" id="select2-meter-results"><li class="select2-results__option" role="option" id="opt1">${opt}</li></ul></span></span></span>
    <script>document.getElementById('opt1').addEventListener('click', function () { var s = document.getElementById('meter'); s.value = '${opt}'; document.getElementById('select2-meter-container').textContent = '${opt}'; });</script>`);
// CLOSE-MUSTFIX MF3 (checker's bypassLabel.probe.ts, verbatim): a GENERIC ARIA combobox — neither
// select2 nor chosen — labelled aria-labelledby="lbl cur", #cur a SIBLING span that renders the
// currently selected value. The same shape over a "Utility" widget whose prior value is WORDS
// ("Pacific Power"), so the digit redaction on sensitive steps cannot mask the structural rule.
const ariaSibling = (lbl: string, name: string, prior: string, opt: string) => html(`<label id="lbl">${lbl}</label><input type="hidden" name="${name}" id="${name}">
    <div id="cb" role="combobox" aria-expanded="true" aria-controls="lb" aria-labelledby="lbl cur" tabindex="0">&#9662;</div><span id="cur">${prior}</span>
    <ul role="listbox" id="lb"><li role="option" id="opt1">${opt}</li></ul>
    <script>document.getElementById('opt1').addEventListener('click',function(){document.getElementById('cur').textContent='${opt}';document.getElementById('${name}').value='${opt}';});</script>`);
// PrimeFaces SelectOneMenu (by reading): the focus input's aria-labelledby is <id>_label, which
// renders the current selection; the real label is <label for="<id>_focus">.
const primefaces = (lbl: string, prior: string, opt: string) => html(`<label for="f:m_focus">${lbl}</label>
    <div id="f:m" class="ui-selectonemenu"><div class="ui-helper-hidden-accessible"><input id="f:m_focus" name="f:m_focus" role="combobox" aria-expanded="true" aria-controls="f:m_items" aria-labelledby="f:m_label" readonly></div>
    <div class="ui-helper-hidden-accessible"><select id="f:m_input" name="f:m_input" tabindex="-1"><option selected>${prior}</option><option>${opt}</option></select></div>
    <label id="f:m_label" class="ui-selectonemenu-label">${prior}</label>
    <ul role="listbox" id="f:m_items"><li role="option" id="opt1">${opt}</li></ul></div>`);
const PAGES: Record<string, string> = {
  "/aria-sibling": ariaSibling("Meter Number", "meterNumber", PREVIOUS, SECRET),
  "/aria-sibling-utility": ariaSibling("Utility", "utility", "Pacific Power", "PGE"),
  "/primefaces-meter": primefaces("Meter Number", PREVIOUS, SECRET),
  // should-fix (c): a label[for] that wraps a read-only span showing the STORED value.
  "/for-wraps-span": html(`<label for="acct">Account Number <span class="stored">${PREVIOUS}</span></label><input id="acct" name="acct">`),
  "/wrapfor-meter": wrapFor("Meter", SECRET),
  "/wrapfor-meter-number": wrapFor("Meter Number", SECRET),
  "/wrapfor-utility": wrapFor("Utility", "PGE"),
  "/s2-meter": select2("Meter Number", "meterNumber", SECRET),
  "/s2-utility": select2("Utility", "utility", "PGE"),
};
const server = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGES[String(q.url ?? "").split("?")[0]] ?? html("nf")); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();
const mk = async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  return ctx;
};
async function recorder(path: string, act: (p: Page) => Promise<void>): Promise<RecipeStep[]> {
  const ctx = await mk(); const p = await ctx.newPage();
  const steps: RecipeStep[] = [];
  const sink = createRecorderSink(steps, () => undefined, { startsFresh: true });
  await p.exposeBinding("__recordStep", (_s: unknown, payload: RecordedPayload) => sink(payload));
  await p.addInitScript({ content: PORTAL_SAFETY_IN_PAGE_SOURCE });
  await p.addInitScript(captureScript);
  await p.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  await act(p);
  await p.waitForTimeout(300);
  await ctx.close();
  return steps;
}
async function human(path: string, act: (p: Page) => Promise<void>): Promise<RecipeStep[]> {
  const ctx = await mk(); const p = await ctx.newPage();
  const got: RecipeStep[] = [];
  await p.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  await armHumanCaptureOnPage(p, (s) => got.push(s));
  await act(p);
  await p.waitForTimeout(300);
  await ctx.close();
  return got;
}
const leaks = (steps: RecipeStep[], lit: string) => steps.some((s) => JSON.stringify({ selector: s.selector, note: s.note, fingerprint: (s as { fingerprint?: unknown }).fingerprint, value: s.value }).includes(lit));
// humanCapture keeps a sensitive value in memory for the in-process binding only; the backend
// merge (appendHumanPatchSteps) deletes value from every sensitive step. What it must never carry
// is the value in the parts the merge keeps: selector, note, fingerprint.
const leaksKept = (steps: RecipeStep[], lit: string) => steps.some((s) => JSON.stringify({ selector: s.selector, note: s.note, fingerprint: (s as { fingerprint?: unknown }).fingerprint }).includes(lit));
const sel = (steps: RecipeStep[]) => steps.filter((s) => s.action === "select");

try {
  for (const path of ["/wrapfor-meter", "/wrapfor-meter-number"]) {
    const r = sel(await recorder(path, (p) => p.selectOption("#m", SECRET).then(() => undefined)));
    check(`MUST-EXCLUDE recorder ${path}: one sensitive select, no literal, no option text in selector/note/fingerprint`,
      r.length === 1 && r[0].sensitive === true && r[0].value === undefined && !leaks(r, SECRET), JSON.stringify(r));
    const h = sel(await human(path, (p) => p.selectOption("#m", SECRET).then(() => undefined)));
    check(`MUST-EXCLUDE humanCapture ${path}: sensitive, no option text in selector/note`,
      h.length === 1 && h[0].sensitive === true && !leaksKept(h, SECRET), JSON.stringify(h));
  }
  {
    const r = sel(await recorder("/wrapfor-utility", (p) => p.selectOption("#m", "PGE").then(() => undefined)));
    check("MUST-PASS recorder label-wrapped Utility: label 'Utility', value 'PGE', not sensitive",
      r.length === 1 && r[0].value === "PGE" && r[0].sensitive !== true && /^Utility$/.test(String(r[0].note)) && (r[0].selector as { name?: string })?.name === "Utility", JSON.stringify(r));
    const h = sel(await human("/wrapfor-utility", (p) => p.selectOption("#m", "PGE").then(() => undefined)));
    check("MUST-PASS humanCapture label-wrapped Utility: not sensitive, keeps its value",
      h.length === 1 && h[0].sensitive !== true && h[0].value === "PGE", JSON.stringify(h));
  }
  {
    const r = sel(await recorder("/s2-meter", (p) => p.click("#opt1")));
    check("MUST-EXCLUDE recorder select2 over meterNumber: sensitive, no literal, no option text, no previously selected value",
      r.length === 1 && r[0].sensitive === true && r[0].value === undefined && !leaks(r, SECRET) && !leaks(r, PREVIOUS), JSON.stringify(r));
    const s = sel(await recorder("/s2-utility", (p) => p.click("#opt1")));
    check("MUST-PASS recorder select2 over Utility: label 'Utility', value 'PGE'",
      s.length === 1 && s[0].value === "PGE" && s[0].sensitive !== true && /^Utility$/.test(String(s[0].note)) && !leaks(s, PREVIOUS), JSON.stringify(s));
  }
  {
    const r = sel(await recorder("/aria-sibling", (p) => p.click("#opt1")));
    check("MUST-EXCLUDE recorder generic ARIA combobox (aria-labelledby=\"lbl cur\"): sensitive, no literal, the prior value nowhere in selector/note/fingerprint",
      r.length === 1 && r[0].sensitive === true && r[0].value === undefined && !leaks(r, SECRET) && !leaks(r, PREVIOUS), JSON.stringify(r));
    const u = sel(await recorder("/aria-sibling-utility", (p) => p.click("#opt1")));
    check("MUST-PASS recorder generic ARIA combobox over Utility: label 'Utility' (not 'Utility Pacific Power'), value 'PGE'",
      u.length === 1 && u[0].value === "PGE" && u[0].sensitive !== true && (u[0].selector as { name?: string })?.name === "Utility" && !leaks(u, "Pacific Power"), JSON.stringify(u));
    const pf = sel(await recorder("/primefaces-meter", (p) => p.click("#opt1")));
    check("MUST-EXCLUDE recorder PrimeFaces-shaped SelectOneMenu (<id>_label renders the selection): sensitive, label from label[for], prior value nowhere",
      pf.length === 1 && pf[0].sensitive === true && pf[0].value === undefined && !leaks(pf, PREVIOUS) && !leaks(pf, SECRET) && /Meter Number/.test(String((pf[0].selector as { name?: string })?.name)), JSON.stringify(pf));
  }
  {
    const steps = (await recorder("/for-wraps-span", async (p) => { await p.fill("#acct", SECRET); await p.locator("#acct").blur(); })).filter((s) => s.action === "fill");
    check("MUST-EXCLUDE recorder label[for] wrapping the stored value: sensitive, no literal, the stored value nowhere in selector/note/fingerprint",
      steps.length === 1 && steps[0].sensitive === true && steps[0].value === undefined && !leaks(steps, SECRET) && !leaks(steps, PREVIOUS), JSON.stringify(steps));
  }
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\n${failures} recorder-label-leak check(s) FAILED.`); process.exit(1); }
console.log("\nAll recorder-label-leak checks passed (real Chromium).");
process.exit(0);
