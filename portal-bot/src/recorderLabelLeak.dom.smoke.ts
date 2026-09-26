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
const PAGES: Record<string, string> = {
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
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\n${failures} recorder-label-leak check(s) FAILED.`); process.exit(1); }
console.log("\nAll recorder-label-leak checks passed (real Chromium).");
process.exit(0);
