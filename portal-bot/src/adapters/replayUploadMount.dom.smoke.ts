// AN UPLOAD STEP TAGS ITS SLOT AFTER THE SLOT MOUNTS, AND NEVER WAITS 30 s ON AN ATTRIBUTE.
//
// Replay tagged upload controls ONCE (data-al-upl="f0"...) and then setInputFiles waited 30 s per
// retry for a tag nothing would ever set: a client-rendered step shows a spinner and mounts its file
// slots after it, so at tag time there was no slot. 7 of 8 SPA scoreboard cells died on "upload
// plan_set: Plan set (PDF) *" at ~174 s each, with <input type=file> present and UNTAGGED in the
// failure capture (replay skeptic MF4).
//
// MUST-PASS: the slot mounts 6 s after the page (well past every settle before the step) — the file is attached to it, quickly.
// MUST-EXCLUDE: the page's only slot is labelled differently ("Site plan") — the step is skipped,
//   named, within seconds, and the document goes to NO other slot.
//
// Run: npx tsx portal-bot/src/adapters/replayUploadMount.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-mount-"));
const pdf = path.join(dir, "plan-set.pdf");
fs.writeFileSync(pdf, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

const page = (label: string) => `<!doctype html><html><head><title>Apply</title></head><body>
  <h1>Step 3: Documents</h1><div id="app"><p><label for="notes">Notes</label><input id="notes"></p><div id="slot" class="spinner">Loading…</div></div>
  <script>
    // The page's other controls are live at once; the upload widget mounts behind its own spinner.
    setTimeout(function () {
      document.getElementById('slot').outerHTML =
        '<div class="form-group"><label for="doc1">${label}</label><input type="file" id="doc1" accept=".pdf"></div>';
    }, 6000);
  </script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(url.pathname === "/other" ? page("Site plan *") : page("Plan set (PDF) *"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const recipe = (p: string): PortalRecipe => ({
  id: "upload-mount", scopeType: "ahj", profileKey: "or|x|", state: "OR", ahj: "X", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}${p}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}${p}`, note: "open" } as RecipeStep,
    { action: "upload", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", note: "upload plan_set: Plan set (PDF) *" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
  ],
} as unknown as PortalRecipe);

const browser = await chromium.launch();
try {
  for (const p of ["/spa", "/other"]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const pg = await ctx.newPage();
    const adapter = new RecipeAdapter(recipe(p), {}, { plan_set: pdf }, {} as never);
    (adapter as unknown as { page: unknown }).page = pg;
    const t0 = Date.now();
    const r = await adapter.fillApplication({} as ProjectRecord).catch((e) => ({ ok: false, message: String(e) }));
    const secs = (Date.now() - t0) / 1000;
    const files = await pg.evaluate(() => Array.from(document.querySelectorAll("input[type=file]")).map((i) => (i as HTMLInputElement).files?.length ?? 0)).catch(() => [] as number[]);
    const warnings = (adapter as unknown as { driftWarnings: string[] }).driftWarnings.join(" | ");
    await ctx.close();
    if (p === "/spa") {
      check(`MUST-PASS: the slot that mounts after a spinner gets the plan set (${secs.toFixed(1)} s)`, files[0] === 1 && secs < 20, `files=${JSON.stringify(files)} ${secs.toFixed(1)}s ${String(r.message).slice(0, 160)} ${warnings.slice(0, 200)}`);
    } else {
      check(`MUST-EXCLUDE: no slot named like the step -> nothing attached anywhere (${secs.toFixed(1)} s)`, files.every((n) => n === 0), `files=${JSON.stringify(files)}`);
      check("MUST-EXCLUDE: ...named, within seconds (not 3 x 30 s)", secs < 25 && /no matching file slot/.test(warnings), `${secs.toFixed(1)}s warnings=${warnings.slice(0, 240)}`);
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} upload-mount check(s) FAILED.`); process.exit(1); }
console.log("\nAll upload-mount checks passed (real Chromium).");
process.exit(0);
