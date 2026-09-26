// A RETRY NEVER RELOADS A PAGE THAT A POST PRODUCED (hard rule 1).
//
// replay's retry loop reloaded the page after a timed-out step. A reload of a document that a
// POST rendered (no redirect) RE-SENDS the POST: an ASP.NET full postback, or a filing whose
// result renders in place. In the replay skeptic's modal probe, filing POSTs 2-4 were ~13/16/21 s
// apart — the retry backoff plus reload cycles after the first filing.
//
// MUST-EXCLUDE: a POST that renders its result (no redirect), then a step that times out ->
//   exactly ONE POST, and the run names why it did not reload.
// MUST-PASS: a GET page whose control times out may still be reloaded (it is served again).
//
// Run: npx tsx portal-bot/src/adapters/replayReloadGuard.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

let posts = 0;
const gets: Record<string, number> = {};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "POST") {
    posts++;
    // The result renders IN PLACE — no redirect, so the document is a POST result.
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><h1>Parcel search results</h1><p>1 parcel found.</p></body></html>");
    return;
  }
  gets[url.pathname] = (gets[url.pathname] ?? 0) + 1;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Portal</title></head><body><h1>Step 2: Parcel</h1>
    <form method="post" action="/lookup"><label for="q">Parcel Number</label><input id="q" name="q">
    <button id="go" type="submit">Look up parcel</button></form></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const recipe = (steps: RecipeStep[]): PortalRecipe => ({
  id: "reload-guard", scopeType: "ahj", profileKey: "or|x|", state: "OR", ahj: "X", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/form`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps,
} as unknown as PortalRecipe);
const missing = { action: "click", selector: { css: "#does-not-exist", role: "button", name: "Add Parcel Row" }, note: "add parcel row" } as RecipeStep;

const browser = await chromium.launch();
try {
  const run = async (steps: RecipeStep[]) => {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(3000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    const adapter = new RecipeAdapter(recipe(steps), {}, {}, {} as never);
    (adapter as unknown as { page: unknown }).page = page;
    const r = await adapter.fillApplication({} as ProjectRecord).catch((e) => ({ ok: false, message: String(e) }));
    await ctx.close();
    return { r, warnings: (adapter as unknown as { driftWarnings: string[] }).driftWarnings.join(" | ") };
  };

  // MUST-EXCLUDE: POST result rendered in place, then a step that never resolves.
  posts = 0;
  const a = await run([
    { action: "goto", value: `${base}/form`, note: "open" } as RecipeStep,
    { action: "click", selector: { css: "#go", role: "button", name: "Look up parcel" }, note: "look up parcel" } as RecipeStep,
    missing,
    { action: "stopForReview" } as RecipeStep,
  ]);
  check("MUST-EXCLUDE: the POST is sent exactly once (the retry loop never re-sends it)", posts === 1, `POSTs=${posts} ${String(a.r.message).slice(0, 160)}`);
  check("MUST-EXCLUDE: the run names why it did not reload", /NOT RELOADED .*result of a POST/.test(a.warnings), `warnings=${a.warnings.slice(0, 300)}`);

  // MUST-PASS: a GET page with the same timing-out step is reloaded.
  posts = 0;
  gets["/form2"] = 0;
  const b = await run([
    { action: "goto", value: `${base}/form2`, note: "open" } as RecipeStep,
    { action: "fill", selector: { css: "#q", label: "Parcel Number" }, value: "27S13W04-00812", note: "Parcel Number" } as RecipeStep,
    missing,
    { action: "stopForReview" } as RecipeStep,
  ]);
  check("MUST-PASS: a GET page whose control times out is reloaded (served more than once)", (gets["/form2"] ?? 0) >= 2 && posts === 0,
    `GETs=${gets["/form2"]} POSTs=${posts} warnings=${b.warnings.slice(0, 200)}`);
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} replay-reload-guard check(s) FAILED.`); process.exit(1); }
console.log("\nAll replay-reload-guard checks passed (real Chromium).");
process.exit(0);
