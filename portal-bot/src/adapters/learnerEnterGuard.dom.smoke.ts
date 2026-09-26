// THE LEARNER'S OWN ENTER, ASKED THE SHARED QUESTION (hard rule 1).
//
// pressEnterInLastFilledField is the learner's search fallback. It asks enterRefusalInPage — the
// same in-page Enter question replay's gate and comboboxFill ask — but nothing pinned that call
// (close2-safety checker, kill2.log K2d: with the learner's answer forced to "" enterSubmitGuard
// and terminalPage stayed green, because the older >5-fillable-fields refusal caught them first).
// This drives the private method directly on a <=5-field page, so ONLY the shared question can
// refuse.
//
// MUST-EXCLUDE (no POST, no press step): jsKeydown — a "Parcel Number" box whose keydown maps
//   Enter to the form's "Submit Application" (not a positively identified search box, and the form
//   holds a submit-worded control); searchAlsoFiles — a type=search box whose form also holds
//   "Submit Application".
// MUST-PASS: a type=search box in a form whose only button is "Search" -> Enter pressed, POST
//   /search, a press step recorded.
// CLOSE3 SKEPTIC MF1: MUST-EXCLUDE enterFormScope (the box in its own form, "Submit Application"
//   elsewhere on the page); MUST-PASS enterFormScopeOk (same box, only Search / Save Draft / Next,
//   a step bar naming "Review and Submit").
//
// Run: npx tsx portal-bot/src/adapters/learnerEnterGuard.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import type { RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGES: Record<string, string> = {
  jsKeydown: `<h1>Step 2: Project Details</h1>
    <form method="post" action="/other"><label for="q">Parcel Number</label>
      <input id="q" name="q" onkeydown="if(event.key==='Enter'){event.preventDefault();this.form.requestSubmit(document.getElementById('f'));}">
      <button type="submit" formaction="/search">Search</button><button id="f" type="submit" formaction="/submit">Submit Application</button></form>`,
  searchAlsoFiles: `<h1>Step 2: Project Details</h1>
    <form method="post" action="/other"><label for="q">Find a parcel</label>
      <input id="q" name="q" type="search" onkeydown="if(event.key==='Enter'){event.preventDefault();this.form.requestSubmit(document.getElementById('f'));}">
      <button type="submit" formaction="/search">Search</button><button id="f" type="submit" formaction="/submit">Submit Application</button></form>`,
  // CLOSE3 SKEPTIC MF1: a type=search box in its OWN small form; "Submit Application" sits outside
  // that form and a document keydown maps Enter to it. The scope is the page, not the form.
  enterFormScope: `<h1>Step 3: Project Details</h1><form role="search" method="post" action="/search" onsubmit="return false"><label for="q">Find a parcel</label><input type="search" id="q" name="q"></form>
    <label for="nm">Contact Name</label><input id="nm"><button type="button" id="sb">Submit Application</button>
    <script>document.getElementById("sb").addEventListener("click", () => { fetch("/api/apply/42", {method:"POST", body:"x=1"}).catch(()=>{}); });
      document.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("sb").click(); });</script>`,
  // MUST-PASS: the same box, the page's other controls only Search / Save / Next, and a 7-step bar
  // naming "Review and Submit" (EnerGov CSS prints it on every page) — not the review page.
  enterFormScopeOk: `<nav aria-label="Application steps"><ol><li>Locations</li><li>Type</li><li>Contacts</li><li>More Info</li><li>Attachments</li><li>Signature</li><li>Review and Submit</li></ol></nav>
    <h1>Step 3: Project Details</h1><form role="search" method="post" action="/search"><label for="q">Find a parcel</label><input type="search" id="q" name="q"></form>
    <label for="nm">Contact Name</label><input id="nm"><button type="button">Search</button> <button type="button">Save Draft</button> <button type="button">Next</button>`,
  searchOnly: `<h1>Property Search</h1>
    <form method="post" action="/search"><label for="q">Find a parcel</label><input id="q" name="q" type="search">
      <button type="submit">Search</button></form>`,
};
const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "POST") { posts.push(url.pathname); res.writeHead(303, { location: "/results" }); res.end(); return; }
  if (url.pathname === "/results") { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><html><body><h1>Search Results</h1><table><tr><td>row</td></tr></table></body></html>"); return; }
  const m = url.searchParams.get("m") || "searchOnly";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Portal</title></head><body>${PAGES[m] ?? ""}</body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const planner: LearnPlanner = async () => ({ fills: [], atReview: false });

const browser = await chromium.launch();
try {
  for (const m of Object.keys(PAGES)) {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(5000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/form?m=${m}`);
    await page.locator("#q").fill("12-34");
    const adapter = new AutoLearnAdapter("Learner Enter Guard", planner, { maxPages: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = adapter as any;
    a.page = page;
    const steps: RecipeStep[] = [{ action: "fill", phase: "fill", selector: { css: "#q" }, value: "12-34", note: "Parcel Number" } as RecipeStep];
    posts.length = 0;
    let pressed: unknown = null;
    try { pressed = await a.pressEnterInLastFilledField(steps, [{ fieldType: "text", label: "Parcel Number" }]); }
    catch (e) { pressed = `threw ${String(e).slice(0, 120)}`; }
    await page.waitForTimeout(600);
    await ctx.close().catch(() => null);
    const pressSteps = steps.filter((s) => String(s.action) === "press").length;
    if (m === "searchOnly" || m === "enterFormScopeOk") {
      check(`MUST-PASS ${m}: the learner presses Enter in a type=search box (POST /search, a press step recorded)`, pressed === true && posts.join(",") === "/search" && pressSteps === 1,
        `pressed=${String(pressed)} POSTs=[${posts.join(",")}] pressSteps=${pressSteps}`);
    } else {
      check(`MUST-EXCLUDE ${m}: the learner does not press Enter (no POST, no press step)`, pressed === false && posts.length === 0 && pressSteps === 0,
        `pressed=${String(pressed)} POSTs=[${posts.join(",")}] pressSteps=${pressSteps}`);
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} learner-enter-guard check(s) FAILED.`); process.exit(1); }
console.log("\nAll learner-enter-guard checks passed (real Chromium).");
process.exit(0);
