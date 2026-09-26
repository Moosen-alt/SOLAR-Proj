// COMBOBOXFILL'S OWN ENTER, DRIVEN FOR REAL (hard rule 1).
//
// fillCustomCombobox's last resort presses Enter in the widget's search box. That Enter is the
// form's implicit submission, so it must be judged like replay's recorded Enter
// (enterRefusalInPage). The close-mustfix checker showed the only test of it was a string search:
// with the check replaced by "" recipeAdapter.test stayed 51/51 green (kill.log KILL P3b). This
// smoke drives selectWithFallback -> fillCustomCombobox into the Enter branch on a free-text
// widget (typed text, no option rows) and watches the network.
//
// MUST-EXCLUDE (0 POSTs, a named refusal): the widget's form's default button is "Submit
//   Application"; and a form whose default is "Search" but which also holds "Submit Application"
//   (the conservative rule — a page script can map Enter to it).
// MUST-PASS: a form whose only button is "Look up" -> the Enter is pressed (POST /lookup), which
//   also proves this fixture reaches the Enter branch at all.
//
// Run: npx tsx portal-bot/src/comboboxEnterGuard.dom.smoke.ts
import "./smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import { selectWithFallback, lastComboboxEnterRefusal } from "./comboboxFill";
import * as combo from "./comboboxFill";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// A free-text widget that keeps its query: fillCustomCombobox clears a filter that matched no row
// (so a digit-signature pass can read the full list); this widget restores it, which is what a
// free-text combobox that commits on Enter looks like to the code under test.
const WIDGET = `<div class="combobox"><input id="cb" role="combobox" aria-label="County" autocomplete="off"></div>
  <script>(function(){var b=document.getElementById('cb'),last='';b.addEventListener('input',function(){if(!b.value&&last){b.value=last;}else{last=b.value;}});})();</script>`;
const PAGES: Record<string, string> = {
  defaultFiles: `<form method="post" action="/other">${WIDGET}<button type="submit" formaction="/submit">Submit Application</button></form>`,
  alsoFiles: `<form method="post" action="/other">${WIDGET}<button type="submit" formaction="/search">Search</button><button type="submit" formaction="/submit">Submit Application</button></form>`,
  lookupOnly: `<form method="post" action="/other">${WIDGET}<button type="submit" formaction="/lookup">Look up</button></form>`,
};
const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "POST") { posts.push(url.pathname); res.writeHead(303, { location: "/done" }); res.end(); return; }
  if (url.pathname === "/done") { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><html><body><h1>Done</h1></body></html>"); return; }
  const m = url.searchParams.get("m") || "lookupOnly";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Portal</title></head><body><h1>Step 2: Project Details</h1>${PAGES[m] ?? ""}</body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
try {
  for (const m of Object.keys(PAGES)) {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(5000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/form?m=${m}`);
    posts.length = 0;
    const picked = await selectWithFallback(page, page.locator("#cb"), "Coos").catch(() => false);
    await page.waitForTimeout(800);
    await ctx.close().catch(() => null);
    const refusal = combo.lastComboboxEnterRefusal;
    if (m === "lookupOnly") {
      check("MUST-PASS lookupOnly: the widget's Enter is pressed (the fixture reaches the Enter branch)", posts.join(",") === "/lookup", `POSTs=[${posts.join(",")}] picked=${picked} refusal=${JSON.stringify(refusal)}`);
    } else {
      check(`MUST-EXCLUDE ${m}: no POST from comboboxFill's Enter`, posts.length === 0, `POSTs=[${posts.join(",")}] picked=${picked}`);
      // Each case names its OWN reason (the module keeps the last refusal, so a stale one from the
      // previous case cannot satisfy this one).
      const own = m === "defaultFiles" ? /activates "Submit Application"/ : /also holds "Submit Application"/;
      check(`MUST-EXCLUDE ${m}: the refusal is named`, own.test(refusal), `refusal=${JSON.stringify(refusal)}`);
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
void lastComboboxEnterRefusal;
if (failures) { console.error(`\n${failures} combobox-enter-guard check(s) FAILED.`); process.exit(1); }
console.log("\nAll combobox-enter-guard checks passed (real Chromium).");
process.exit(0);
