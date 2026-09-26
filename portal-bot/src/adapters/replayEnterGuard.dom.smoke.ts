// A RECIPE "PRESS ENTER" IS A CLICK ON THE FORM'S DEFAULT BUTTON (hard rule 1).
//
// guardedPress judged the FOCUSED box's label ("Parcel Number"), not the button Enter activates.
// The replay skeptic's fixture (enter-probe.log): fill + press Enter in a text box whose form's only
// button is "Submit Application" -> POST /submit with PORTAL_ALLOW_FINAL_SUBMIT unset and no
// approval, and the run reported ok=true. enterSubmit/enterSubmitGuard guard the LEARNER's walk,
// not a recorded replay press step.
//
// MUST-PASS: default button "Search" -> POST /search (the Enter is pressed).
// MUST-EXCLUDE: default button "Submit Application" / "Submit" / "File", and a button-less form
//   whose action is a filing endpoint -> no POST, a named refusal.
// Also the shared in-page question comboboxFill asks before its own Enter (MUST-PASS/EXCLUDE).
//
// Run: npx tsx portal-bot/src/adapters/replayEnterGuard.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../../shared/src/portalSafety";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: string[] = [];
const BUTTONS: Record<string, string> = {
  search: `<button type="submit" formaction="/search">Search</button>`,
  submitApplication: `<button type="submit" formaction="/submit">Submit Application</button>`,
  submit: `<input type="submit" formaction="/submit" value="Submit">`,
  file: `<button formaction="/submit">File</button>`,
  // No button at all: implicit submission posts to the form's own action.
  noButtonFilingAction: "",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "POST") {
    posts.push(url.pathname);
    res.writeHead(303, { location: "/done" });
    res.end();
    return;
  }
  if (url.pathname === "/done") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><h1>Thank you</h1></body></html>");
    return;
  }
  const m = url.searchParams.get("m") || "search";
  const action = m === "noButtonFilingAction" ? "/SubmitApplication" : "/other";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Portal</title></head><body><h1>Step 2: Project Details</h1>
    <form method="post" action="${action}"><label for="q">Parcel Number</label><input id="q" name="q">${BUTTONS[m] ?? ""}</form>
    <form method="post" action="/submit"><div class="combo"><input type="search" id="cs" aria-label="Find a county"></div>
      <button type="submit">Submit Application</button></form>
    <form method="post" action="/lookup"><div class="combo"><input type="search" id="cs2" aria-label="Find a county"></div>
      <button type="submit">Look up</button></form></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const recipe = (m: string): PortalRecipe => ({
  id: "enter-guard", scopeType: "ahj", profileKey: "or|x|", state: "OR", ahj: "X", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/form?m=${m}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/form?m=${m}`, note: "open" },
    { action: "fill", selector: { css: "#q", label: "Parcel Number" }, value: "12-34", note: "Parcel Number" } as RecipeStep,
    { action: "press", selector: { css: "#q", label: "Parcel Number" }, value: "Enter", note: "Parcel Number" } as RecipeStep,
    { action: "stopForReview" },
  ],
} as unknown as PortalRecipe);

const browser = await chromium.launch();
try {
  for (const m of Object.keys(BUTTONS)) {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    const adapter = new RecipeAdapter(recipe(m), {}, {}, {} as never);
    (adapter as unknown as { page: unknown }).page = page;
    posts.length = 0;
    let ok = false;
    let msg = "";
    try { const r = await adapter.fillApplication({} as ProjectRecord); ok = r.ok; msg = String(r.message).slice(0, 200); }
    catch (e) { msg = `threw ${String(e).slice(0, 160)}`; }
    await ctx.close().catch(() => null);
    const refusals = adapter.guardRefusals.join(" | ");
    if (m === "search") {
      check("MUST-PASS default button 'Search': the Enter is pressed and posts /search", posts.join(",") === "/search", `POSTs=[${posts.join(",")}] ${msg}`);
    } else {
      check(`MUST-EXCLUDE ${m}: no POST`, posts.length === 0, `POSTs=[${posts.join(",")}] ${msg}`);
      check(`MUST-EXCLUDE ${m}: a named refusal, and the run does not report success`,
        !ok && /(Enter|default button)/.test(refusals) && /replay safety gate refused/.test(msg), `ok=${ok} refusals=${refusals || "(none)"} msg=${msg}`);
    }
  }

  // The shared question comboboxFill asks before pressing Enter in a widget's search box.
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  await page.goto(`${base}/form?m=search`);
  await page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE);
  const ask = (sel: string) => page.locator(sel).evaluate((el, g) => (globalThis as unknown as Record<string, { implicitSubmitRefusalInPage: (e: Element) => string }>)[g].implicitSubmitRefusalInPage(el), PORTAL_SAFETY_GLOBAL);
  const inFiling = await ask("#cs");
  const inLookup = await ask("#cs2");
  await ctx.close();
  check("MUST-EXCLUDE combobox search box in a form whose default button is 'Submit Application': Enter refused", /submit-worded/.test(inFiling), `got ${JSON.stringify(inFiling)}`);
  check("MUST-PASS combobox search box in a form whose default button is 'Look up': Enter allowed", inLookup === "", `got ${JSON.stringify(inLookup)}`);
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} replay-enter-guard check(s) FAILED.`); process.exit(1); }
console.log("\nAll replay-enter-guard checks passed (real Chromium).");
process.exit(0);
