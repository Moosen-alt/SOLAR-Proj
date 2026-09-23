// ONE DOCUMENT PER SLOT, UNDER ITS OWN NAME — AND NO 30s WAIT ON A STEP NAV.
//
// Found recording a replay against a local fixture portal (scripts/demo-portal/):
//
// (1) The unrecorded-upload sweep runs before every advancing click and before review. Its
//     bookkeeping only knew about ITS OWN attaches, so a slot a RECORDED upload step had just
//     filled was attached a second time, with a false "a slot the recipe has no step for"
//     warning. On a portal where each attach adds a row that is a DUPLICATE DOCUMENT on a
//     live application. And the sweep handed the browser the raw stored path, so the portal
//     received "<uuid>-...-plan-set.pdf" while the recorded step presented "...-plan-set.pdf".
//
// (2) waitForUploadAccepted read Number(el.getAttribute("aria-valuenow")) on every visible
//     [class*="progress"] / [class*="upload"] element. A MISSING attribute is Number(null) = 0,
//     so a Bootstrap-style ".progress" step nav read as a stalled 0% upload: every attach
//     waited the full 30s and reported "the portal was still taking a document (0%)".
//
// (3) The first fix for (1) keyed "a recorded step filled this slot" by data-al-upl — and a
//     re-tag left a STALE key on a skipped Browse trigger while handing the same key to an
//     unrecorded one, so the unrecorded slot read as filled and was never attached. Keys are
//     now valid only for the pass that assigned them (tagUploadControls clears them first).
//
// Real Chromium, local HTML only, no portal, no LLM.
//   npx tsx portal-bot/src/adapters/uploadSweepNoDuplicate.dom.smoke.ts
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  checks++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

// A ROW-ADDING PORTAL. Each attach files a row and then CLEARS the input (so "the input
// already holds a file" cannot be what protects it — only knowing a recorded step filled it).
// Three slots:
//   planSetFile  native input, HAS a recorded upload step
//   browseSite   a Browse widget whose input is created on click and removed after the
//                change — HAS a recorded (file-chooser) upload step
//   oneLineFile  native input, NO recorded step — the sweep's legitimate job
const ROWS = `<!doctype html><html><head><style>body{font:14px sans-serif;padding:16px}.field{margin:10px 0}</style></head><body>
  <h1>Documents</h1>
  <div class="field"><label for="planSetFile">Plan set (PDF)<span>*</span></label>
    <input type="file" id="planSetFile" accept=".pdf,application/pdf"></div>
  <div class="field"><label for="browseSite">Site plan</label>
    <button type="button" id="browseSite">Browse</button></div>
  <div class="field"><label for="browseLetter">Structural engineering letter</label>
    <button type="button" id="browseLetter">Browse</button></div>
  <div class="field"><label for="oneLineFile">Single-line diagram<span>*</span></label>
    <input type="file" id="oneLineFile" accept=".pdf,application/pdf"></div>
  <table><tbody id="rows"></tbody></table>
  <script>
    window.__attaches = [];
    function fileRow(slot, input) {
      for (var i = 0; i < input.files.length; i++) {
        window.__attaches.push({ slot: slot, name: input.files[i].name });
        var tr = document.createElement("tr");
        tr.innerHTML = "<td>" + slot + "</td><td>" + input.files[i].name + "</td>";
        document.getElementById("rows").appendChild(tr);
      }
    }
    ["planSetFile", "oneLineFile"].forEach(function (id) {
      var el = document.getElementById(id);
      el.addEventListener("change", function () { fileRow(id, el); el.value = ""; });
    });
    document.getElementById("browseSite").addEventListener("click", function () {
      var btn = this, f = document.createElement("input");
      f.type = "file"; f.accept = ".pdf";
      f.addEventListener("change", function () { fileRow("browseSite", f); f.remove(); });
      btn.parentElement.appendChild(f);
      f.click();
    });
    // The jQuery-file-upload / Kendo shape: the created input STAYS in the container (and is
    // cleared), so the slot the sweep sees next is that input, not the button.
    document.getElementById("browseLetter").addEventListener("click", function () {
      var btn = this, f = btn.parentElement.querySelector('input[type="file"]');
      if (!f) {
        f = document.createElement("input");
        f.type = "file"; f.accept = ".pdf";
        f.addEventListener("change", function () { fileRow("browseLetter", f); f.value = ""; });
        btn.parentElement.appendChild(f);
      }
      f.click();
    });
  </script>
</body></html>`;

// A BOOTSTRAP-SHAPED WIZARD: a ".progress" step nav and an "upload-area" wrapper, neither of
// which states any value. Nothing on this page is an upload in progress.
const NAV = `<!doctype html><html><head><style>body{font:14px sans-serif;padding:16px}
  .progress{display:flex;gap:6px;height:24px;background:#eee}.upload-area{border:1px dashed #999;padding:12px}</style></head><body>
  <nav class="progress wizard-progress"><span class="progress-step">1. Customer</span><span class="progress-step">2. Documents</span></nav>
  <h1>Documents</h1>
  <div class="upload-area"><label for="planSetFile">Plan set (PDF)</label><input type="file" id="planSetFile" accept=".pdf"></div>
</body></html>`;

// A STALE KEY MUST NOT CREDIT ANOTHER SLOT. The unrecorded Browse slot comes FIRST, the
// recorded one (selected the way the learner records a Browse widget: by its data-al-upl tag)
// SECOND, and the recorded widget's created input persists in its container. The re-tag the
// sweep runs then skips the recorded trigger (its container now holds an input) — and it kept
// its old key "b1" while the counter handed "b1" to the UNRECORDED trigger. The recorded mark
// on the old holder of "b1" made the unrecorded slot read as filled: swept=0, and the
// single-line diagram was never attached. A duplicate turned into a missing document.
const STALE = `<!doctype html><html><body>
<div class="field"><label for="browseSld">Single-line diagram</label><button type="button" id="browseSld">Browse</button></div>
<div class="field"><label for="browseLetter">Structural engineering letter</label><button type="button" id="browseLetter">Browse</button></div>
<script>
window.__attaches = [];
function widget(id){
  document.getElementById(id).addEventListener("click", function(){
    var btn = this, f = btn.parentElement.querySelector('input[type="file"]');
    if (!f) { f = document.createElement("input"); f.type = "file";
      f.addEventListener("change", function(){ for (var i=0;i<f.files.length;i++) window.__attaches.push({slot:id,name:f.files[i].name}); f.value=""; });
      btn.parentElement.appendChild(f); }
    f.click();
  });
}
widget("browseSld"); widget("browseLetter");
</script></body></html>`;

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(q.url === "/nav" ? NAV : q.url === "/stale" ? STALE : ROWS);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const tempRoot = path.resolve(os.tmpdir());
const dir = fs.mkdtempSync(path.join(tempRoot, "upload-sweep-dup-"));
// Stored the way the backend stores project documents: a UUID prefix for on-disk uniqueness.
const stored = (uuid: string, name: string): string => {
  const p = path.join(dir, `${uuid}-${name}`);
  fs.writeFileSync(p, `%PDF-1.4\n% ${name}\n`);
  return p;
};
const docs = {
  plan_set: stored("cf33f760-1a2b-4c3d-8e9f-0123456789ab", "zztest-plan-set.pdf"),
  site_plan: stored("0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f", "zztest-site-plan.pdf"),
  sld: stored("9f8e7d6c-5b4a-4392-a1b0-c9d8e7f6a5b4", "zztest-single-line.pdf"),
  structural_letter: stored("5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9", "zztest-structural-letter.pdf"),
};

const recipeFor = (url: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "sweep-dup", scopeType: "utility", profileKey: "zz|fixture|upload-sweep", state: "ZZ",
  ahj: "", utility: "Fixture", portalPlatform: "fixture", portalUrl: url, status: "complete", version: 1,
  steps, createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

type Internals = {
  page: unknown;
  driftWarnings: string[];
  executeStep(step: RecipeStep, pastReview: boolean): Promise<boolean>;
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

  // -------------------------------------------------------------------------------------
  // (1) Recorded uploads, then the sweep that runs before review.
  // -------------------------------------------------------------------------------------
  {
    const page = await context.newPage();
    await page.goto(`${base}/rows`);
    const steps = [
      { action: "upload", phase: "upload", field: "", note: "upload plan_set: Plan set (PDF)", docType: "plan_set", selector: { css: "#planSetFile" } },
      { action: "upload", phase: "upload", field: "", note: "upload site_plan: Site plan", docType: "site_plan", viaFileChooser: true, selector: { css: "#browseSite" } },
      { action: "upload", phase: "upload", field: "", note: "upload structural_letter: Structural engineering letter", docType: "structural_letter", viaFileChooser: true, selector: { css: "#browseLetter" } },
      { action: "stopForReview", phase: "review", note: "Stop at review — human submits manually." },
    ] as unknown as RecipeStep[];
    const adapter = new RecipeAdapter(recipeFor(`${base}/rows`, steps), {}, docs, { autoSubmit: false });
    (adapter as unknown as Internals).page = page;
    await adapter.fillApplication({} as never);
    const attaches = await page.evaluate(() => (window as unknown as { __attaches: Array<{ slot: string; name: string }> }).__attaches);
    const warnings = (adapter as unknown as Internals).driftWarnings;
    const bySlot = (slot: string) => attaches.filter((a) => a.slot === slot);
    console.log(`   attaches = ${JSON.stringify(attaches)}`);
    console.log(`   upload warnings = ${JSON.stringify(warnings.filter((w) => /attached|no step for/i.test(w)))}`);

    check("a slot a RECORDED upload step filled is attached exactly once (native input, cleared after attach)",
      bySlot("planSetFile").length === 1,
      `plan set was filed ${bySlot("planSetFile").length} times — the sweep re-attached a slot the recipe already filled`);
    check("...and so is a recorded Browse/file-chooser slot whose input the widget removes",
      bySlot("browseSite").length === 1,
      `site plan was filed ${bySlot("browseSite").length} times`);
    check("...and a recorded Browse slot whose created input PERSISTS in the container",
      bySlot("browseLetter").length === 1,
      `structural letter was filed ${bySlot("browseLetter").length} times — the chooser's own input was never marked`);
    check("the sweep still fills the slot the recipe genuinely has no step for, once",
      bySlot("oneLineFile").length === 1,
      `single-line diagram was filed ${bySlot("oneLineFile").length} times`);
    check("no false 'no step for' warning names a recorded slot",
      !warnings.some((w) => /no step for/i.test(w) && /plan set|site plan|structural/i.test(w)),
      JSON.stringify(warnings));
    check("...while the genuinely unrecorded slot is still reported",
      warnings.some((w) => /no step for/i.test(w) && /single-line/i.test(w)),
      JSON.stringify(warnings));
    check("every attach presents the display filename, never the stored UUID prefix",
      attaches.length > 0 && attaches.every((a) => !UUID_PREFIX.test(a.name)),
      JSON.stringify(attaches.map((a) => a.name)));
    check("the swept attach carries the same clean name the recorded path would give it",
      bySlot("oneLineFile")[0]?.name === "zztest-single-line.pdf",
      `got ${JSON.stringify(bySlot("oneLineFile")[0]?.name)}`);
    await page.close();
  }

  // A FRESH PAGE IS A FRESH SLOT: the recorded mark lives on the element, so the same adapter
  // sweeping a newly loaded page with the same labels must still fill it (the scope is this
  // page, not the run).
  {
    const page = await context.newPage();
    await page.goto(`${base}/rows`);
    const adapter = new RecipeAdapter(recipeFor(`${base}/rows`, []), {}, docs, { autoSubmit: false }) as unknown as Internals & { sweepUnrecordedUploads(): Promise<number> };
    adapter.page = page;
    await adapter.executeStep({ action: "upload", phase: "upload", field: "", note: "upload plan_set: Plan set (PDF)", docType: "plan_set", selector: { css: "#planSetFile" } } as unknown as RecipeStep, false);
    await page.reload();
    const swept = await adapter.sweepUnrecordedUploads();
    const attaches = await page.evaluate(() => (window as unknown as { __attaches: Array<{ slot: string }> }).__attaches);
    check("a reloaded page's slots are not 'already filled' by a mark on the previous page",
      attaches.some((a) => a.slot === "planSetFile"),
      `swept=${swept}; attaches after reload = ${JSON.stringify(attaches)}`);
    await page.close();
  }

  // A recorded Browse step selected by its data-al-upl key, AFTER an unrecorded Browse slot.
  {
    const page = await context.newPage();
    await page.goto(`${base}/stale`);
    const adapter = new RecipeAdapter(recipeFor(`${base}/stale`, []), {}, docs, { autoSubmit: false }) as unknown as Internals & { sweepUnrecordedUploads(): Promise<number> };
    adapter.page = page;
    const ok = await adapter.executeStep({ action: "upload", phase: "upload", field: "", note: "upload structural_letter: Structural engineering letter", docType: "structural_letter", viaFileChooser: true, selector: { css: '[data-al-upl="b1"]' } } as unknown as RecipeStep, false);
    const swept = await adapter.sweepUnrecordedUploads();
    const attaches = await page.evaluate(() => (window as unknown as { __attaches: Array<{ slot: string; name: string }> }).__attaches);
    const warnings = adapter.driftWarnings;
    const bySlot = (slot: string) => attaches.filter((a) => a.slot === slot);
    console.log(`   stale-key fixture: recorded ok=${String(ok)} swept=${swept} attaches=${JSON.stringify(attaches)}`);
    check("the recorded data-al-upl Browse step attached its document", ok === true && bySlot("browseLetter").length >= 1,
      `ok=${String(ok)} attaches=${JSON.stringify(attaches)}`);
    check("an UNRECORDED Browse slot before it is swept exactly once (a stale key must not mark it filled)",
      bySlot("browseSld").length === 1,
      `single-line diagram was filed ${bySlot("browseSld").length} times (swept=${swept}) — the stale key credited it with the recorded attach`);
    check("...and the recorded slot is not re-attached",
      bySlot("browseLetter").length === 1,
      `structural letter was filed ${bySlot("browseLetter").length} times`);
    check("the one 'no step for' warning names the unrecorded slot, not the recorded one",
      warnings.filter((w) => /no step for/i.test(w)).length === 1
        && warnings.some((w) => /no step for/i.test(w) && /single-line/i.test(w)),
      JSON.stringify(warnings));
    const dupKeys = await page.evaluate(() => {
      const keys = Array.from(document.querySelectorAll("[data-al-upl]")).map((e) => e.getAttribute("data-al-upl"));
      return keys.filter((k, i) => keys.indexOf(k) !== i);
    });
    check("after a re-tag no two elements share a data-al-upl key", dupKeys.length === 0, `duplicated keys: ${JSON.stringify(dupKeys)}`);
    await page.close();
  }

  // -------------------------------------------------------------------------------------
  // (2) A ".progress" nav with no aria-valuenow is not a stalled upload.
  // -------------------------------------------------------------------------------------
  {
    const page = await context.newPage();
    await page.goto(`${base}/nav`);
    const adapter = new RecipeAdapter(recipeFor(`${base}/nav`, []), {}, docs, { autoSubmit: false }) as unknown as Internals;
    adapter.page = page;
    const t0 = Date.now();
    const ok = await adapter.executeStep({ action: "upload", phase: "upload", field: "", note: "upload plan_set: Plan set (PDF)", docType: "plan_set", selector: { css: "#planSetFile" } } as unknown as RecipeStep, false);
    const ms = Date.now() - t0;
    console.log(`   attach on the .progress-nav page took ${ms} ms`);
    const held = await page.locator("#planSetFile").evaluate((el) => (el as HTMLInputElement).files?.length ?? 0);
    check("the attach itself landed", ok === true && held === 1, `ok=${String(ok)} files=${held}`);
    // The fixed path returns once no indicator APPEARS (UPLOAD_APPEAR_MS = 3s); the bug held
    // for the full UPLOAD_ACCEPT_MS (30s). 10s separates them with room for a slow machine.
    check("a value-less '.progress' nav / 'upload-area' does not hold the attach for ~30s",
      ms < 10_000, `the attach took ${ms} ms — it waited out a progress bar that does not exist`);
    check("...and reports no stalled upload",
      !adapter.driftWarnings.some((w) => /still taking a document/i.test(w)),
      JSON.stringify(adapter.driftWarnings));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
  if (path.dirname(path.resolve(dir)) === tempRoot) fs.rmSync(dir, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} of ${checks} upload-sweep check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${checks} upload-sweep checks passed (real Chromium, local HTML only).`);
process.exit(0);
