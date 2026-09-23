// A 50MB DOCUMENT STILL REACHES THE PORTAL — UNDER ITS CLEAN NAME — AND A REFUSED ATTACH IS
// REPORTED, NEVER SWALLOWED.
//
// (1) Replay built every upload payload as an in-memory BUFFER (to present the clean display
//     name instead of the UUID-prefixed stored name). Playwright refuses a buffer of 50MB or
//     more ("Cannot set buffer larger than 50Mb"), and the unrecorded-upload sweep caught the
//     throw and moved on: a large plan set or single-line diagram was simply not attached.
//     A large file is now staged as a temp file named with the display name and handed over
//     by PATH; the staged copy lives until the adapter closes (the browser reads a path-backed
//     file only when the portal uploads it — possibly at the human's final submit).
//
// (2) Whatever the reason, a sweep attach that fails now leaves a drift warning naming the
//     document and the slot. It was `.catch(() => false)` and a bare continue.
//
// (3) The left-open review window the HUMAN closes. close() is never called for it, so the
//     staged copies stayed on disk until a later large file happened to trigger the 7-day
//     prune. trackOpenAdapter's context "close" handler now releases them — without calling
//     close() on a context that is already gone.
//
// Real Chromium, local HTML only, no portal, no LLM. Writes ~104MB of temp files, removed.
//   npx tsx portal-bot/src/adapters/uploadLargeFile.dom.smoke.ts
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { INLINE_UPLOAD_LIMIT, removeUploadStaging } from "./uploadPayload";
import { trackOpenAdapter } from "../index";

let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  checks++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Two native slots. The page records name + size of every file it is given, the way a
// portal's upload handler would see it.
const DOCS = `<!doctype html><html><body>
  <div class="field"><label for="planSetFile">Plan set (PDF)</label><input type="file" id="planSetFile" accept=".pdf"></div>
  <div class="field"><label for="oneLineFile">Single-line diagram</label><input type="file" id="oneLineFile" accept=".pdf"></div>
  <script>
    window.__attaches = [];
    document.querySelectorAll('input[type=file]').forEach(function (el) {
      el.addEventListener("change", function () {
        for (var i = 0; i < el.files.length; i++) window.__attaches.push({ slot: el.id, name: el.files[i].name, size: el.files[i].size });
      });
    });
  </script></body></html>`;

// A Browse widget that is broken: its click opens no file chooser, so the attach cannot land.
const BROKEN = `<!doctype html><html><body>
  <div class="field"><label for="browseSld">Single-line diagram</label><button type="button" id="browseSld">Browse</button></div>
</body></html>`;

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(q.url === "/broken" ? BROKEN : DOCS);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const tempRoot = path.resolve(os.tmpdir());
const dir = fs.mkdtempSync(path.join(tempRoot, "upload-large-"));
const BIG = INLINE_UPLOAD_LIMIT + 2 * 1024 * 1024; // 52MB: over Playwright's buffer ceiling
const bigFile = (uuid: string, name: string): string => {
  const p = path.join(dir, `${uuid}-${name}`);
  const fd = fs.openSync(p, "w");
  try {
    fs.writeSync(fd, "%PDF-1.4\n");
    fs.ftruncateSync(fd, BIG);
  } finally { fs.closeSync(fd); }
  return p;
};
const docs = {
  plan_set: bigFile("cf33f760-1a2b-4c3d-8e9f-0123456789ab", "zztest-big-plan-set.pdf"),
  sld: bigFile("9f8e7d6c-5b4a-4392-a1b0-c9d8e7f6a5b4", "zztest-big-single-line.pdf"),
};

const recipeFor = (url: string): PortalRecipe => ({
  id: "upload-large", scopeType: "utility", profileKey: "zz|fixture|upload-large", state: "ZZ",
  ahj: "", utility: "Fixture", portalPlatform: "fixture", portalUrl: url, status: "complete", version: 1,
  steps: [], createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

type Internals = {
  page: unknown;
  driftWarnings: string[];
  uploadStagingDirs: string[];
  executeStep(step: RecipeStep, pastReview: boolean): Promise<boolean>;
  sweepUnrecordedUploads(): Promise<number>;
  close(): Promise<void>;
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

  // (1) A recorded step and the sweep each attach a 52MB document.
  {
    const page = await context.newPage();
    await page.goto(`${base}/docs`);
    const adapter = new RecipeAdapter(recipeFor(`${base}/docs`), {}, docs, { autoSubmit: false }) as unknown as Internals;
    adapter.page = page;
    const recorded = await adapter.executeStep({ action: "upload", phase: "upload", field: "", note: "upload plan_set: Plan set (PDF)", docType: "plan_set", selector: { css: "#planSetFile" } } as unknown as RecipeStep, false)
      .catch((e: unknown) => { console.log(`   recorded step threw: ${String(e).split("\n")[0]}`); return false; });
    const swept = await adapter.sweepUnrecordedUploads();
    const attaches = await page.evaluate(() => (window as unknown as { __attaches: Array<{ slot: string; name: string; size: number }> }).__attaches);
    console.log(`   recorded=${String(recorded)} swept=${swept} attaches=${JSON.stringify(attaches)}`);
    console.log(`   warnings=${JSON.stringify(adapter.driftWarnings)}`);
    const one = (slot: string) => attaches.filter((a) => a.slot === slot);

    check("a RECORDED upload step attaches a >=50MB document", recorded === true && one("planSetFile").length === 1,
      `recorded=${String(recorded)} attaches=${JSON.stringify(one("planSetFile"))}`);
    check("the unrecorded-upload SWEEP attaches a >=50MB document", swept === 1 && one("oneLineFile").length === 1,
      `swept=${swept} attaches=${JSON.stringify(one("oneLineFile"))} — Playwright refused the buffer and the document was dropped`);
    check("...every byte of it", attaches.length === 2 && attaches.every((a) => a.size === BIG),
      JSON.stringify(attaches.map((a) => a.size)));
    check("...under the clean display name, never the UUID-prefixed stored name",
      one("planSetFile")[0]?.name === "zztest-big-plan-set.pdf" && one("oneLineFile")[0]?.name === "zztest-big-single-line.pdf",
      JSON.stringify(attaches.map((a) => a.name)));
    check("no attach failure was reported", !adapter.driftWarnings.some((w) => /could not attach/i.test(w)),
      JSON.stringify(adapter.driftWarnings));

    // The staged copies outlive the attach (the portal may read them at submit) and go with
    // the adapter's browser.
    const staged = [...adapter.uploadStagingDirs];
    check("both large attaches were staged, and the staged copies still exist after the attach",
      staged.length === 2 && staged.every((d) => fs.existsSync(d)), JSON.stringify(staged));
    await adapter.close();
    check("close() removes every staged copy", staged.length > 0 && staged.every((d) => !fs.existsSync(d)),
      JSON.stringify(staged.filter((d) => fs.existsSync(d))));
    check("...and never the stored originals", fs.existsSync(docs.plan_set) && fs.existsSync(docs.sld));
    await page.close();
  }

  // (2) A sweep attach that fails is reported, not swallowed.
  {
    const page = await context.newPage();
    await page.goto(`${base}/broken`);
    const small = path.join(dir, "cf33f760-1a2b-4c3d-8e9f-0123456789ab-zztest-small-single-line.pdf");
    fs.writeFileSync(small, "%PDF-1.4\n");
    const adapter = new RecipeAdapter(recipeFor(`${base}/broken`), {}, { sld: small }, { autoSubmit: false }) as unknown as Internals;
    adapter.page = page;
    const swept = await adapter.sweepUnrecordedUploads();
    console.log(`   broken widget: swept=${swept} warnings=${JSON.stringify(adapter.driftWarnings)}`);
    check("a failed sweep attach counts as nothing attached", swept === 0, `swept=${swept}`);
    check("...and leaves a drift warning naming the document and the slot",
      adapter.driftWarnings.some((w) => /could not attach sld/i.test(w) && /single-line/i.test(w)),
      JSON.stringify(adapter.driftWarnings));
    await adapter.close();
    await page.close();
  }

  // (3) The human closes the left-open review window: the staged copies go with it.
  {
    const humanCtx = await browser.newContext();
    await humanCtx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
    const page = await humanCtx.newPage();
    await page.goto(`${base}/docs`);
    const adapter = new RecipeAdapter(recipeFor(`${base}/docs`), {}, docs, { autoSubmit: false }) as unknown as Internals;
    adapter.page = page;
    const recorded = await adapter.executeStep({ action: "upload", phase: "upload", field: "", note: "upload plan_set: Plan set (PDF)", docType: "plan_set", selector: { css: "#planSetFile" } } as unknown as RecipeStep, false)
      .catch(() => false);
    const staged = [...adapter.uploadStagingDirs];
    // Count close() calls: the handler must release the staging, not re-close the context.
    let closeCalls = 0;
    const realClose = adapter.close.bind(adapter);
    adapter.close = async () => { closeCalls++; await realClose(); };
    const profileDir = path.join(dir, "zz-review-profile");
    fs.mkdirSync(profileDir, { recursive: true });
    trackOpenAdapter(profileDir, adapter as unknown as Parameters<typeof trackOpenAdapter>[1]);
    check("(left open) a staged copy exists while the review window is open",
      recorded === true && staged.length === 1 && staged.every((d) => fs.existsSync(d)), `recorded=${String(recorded)} ${JSON.stringify(staged)}`);
    await humanCtx.close(); // the HUMAN closing the window — not adapter.close()
    await new Promise((r) => setTimeout(r, 200));
    console.log(`   human close: staged=${JSON.stringify(staged)} remaining=${JSON.stringify(staged.filter((d) => fs.existsSync(d)))} closeCalls=${closeCalls}`);
    check("the human closing the review window removes the staged copies",
      staged.length === 1 && staged.every((d) => !fs.existsSync(d)), JSON.stringify(staged.filter((d) => fs.existsSync(d))));
    check("...without calling close() on the already-closed context", closeCalls === 0, `closeCalls=${closeCalls}`);
    check("...and never the stored original", fs.existsSync(docs.plan_set));
    for (const d of staged) removeUploadStaging(d); // a failed run must not leak the 52MB copy
  }
} finally {
  await browser.close();
  server.close();
  if (path.dirname(path.resolve(dir)) === tempRoot) fs.rmSync(dir, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} of ${checks} large-upload check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${checks} large-upload checks passed (real Chromium, local HTML only).`);
process.exit(0);
