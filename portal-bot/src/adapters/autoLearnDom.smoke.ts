import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { extractFieldsInPage, tagUploadControls, AutoLearnAdapter, EXTRACT_SEL, type LearnPlanner } from "./autoLearnAdapter";
import { frameSelectorFor } from "../safeAction";

// REAL-BROWSER smoke for the universal extraction layer against the DOM shapes that
// break naive scrapers: open shadow roots (web-component portals) and child iframes
// with no name/id — including a CROSS-ORIGIN one (a second local origin).
// Run: npm run portal:test:dom   (needs the Playwright chromium install)

process.env.AUTOLEARN_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autolearn-dom-smoke-"));

const CHILD_HTML = `<!doctype html><html><body>
  <label for="xf">Cross Origin Field</label><input id="xf" name="xoriginField">
</body></html>`;

function serve(html: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); });
    s.listen(0, "127.0.0.1", () => {
      const a = s.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${a.port}`, close: () => s.close() });
    });
  });
}

const child = await serve(CHILD_HTML);
const PARENT_HTML = `<!doctype html><html><body>
  <h2>Applicant</h2>
  <label for="lite">Light Name</label><input id="lite" name="liteName">
  <div id="host"></div>
  <!-- cross-origin child frame with NO name/id — must be keyed by src pathname -->
  <iframe src="${child.url}/embed/form?session=tok123"></iframe>
  <script>
    const root = document.getElementById('host').attachShadow({mode:'open'});
    root.innerHTML =
      '<h3>Shadow Section</h3>' +
      '<label for="sh">Shadow Email</label><input id="sh" name="shadowEmail" required>' +
      '<input type="file" id="shup"><label for="shup">Shadow Plan Set *</label>';
  </script>
</body></html>`;
const parent = await serve(PARENT_HTML);

const browser = await chromium.launch();
const page = await browser.newPage();
// Same esbuild __name shim openPortal injects — serialized in-page functions need it.
await page.addInitScript({ content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };" });
await page.goto(parent.url);
await page.waitForTimeout(200);

let failures = 0;
// check() AWAITS its callback. It used to be synchronous while some callbacks were async, so
// those printed "ok" BEFORE their assertion ran — a failure became an unhandled rejection with no
// "FAIL -" line. Every call is awaited.
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (err) { failures++; console.error(`  FAIL - ${name}\n`, err); }
};

// 1) Main-document extraction sees light + shadow fields, with labels + sections.
const mainRaws = await page.$$eval(EXTRACT_SEL, extractFieldsInPage);
await check("shadow-DOM field extracted with its in-root label", () => {
  const f = mainRaws.find((r) => r.name === "shadowEmail");
  assert.ok(f, "shadowEmail extracted");
  assert.equal(f!.label, "Shadow Email");
  assert.equal(f!.required, true);
});
await check("shadow field's SECTION hops the shadow boundary sensibly", () => {
  const f = mainRaws.find((r) => r.name === "shadowEmail");
  assert.ok(f!.section === "Shadow Section" || (f!.section || "").length > 0, `section derived (got "${f!.section}")`);
});

// 2) Upload tagging sees the shadow-root file input.
const slots = await page.evaluate(tagUploadControls);
await check("shadow-DOM file input tagged as an upload slot", () => {
  assert.ok(slots.some((s) => /shadow plan set/i.test(s.label) || s.kind === "input"), `slots: ${JSON.stringify(slots)}`);
});

// 3) extractAllFrames keys the unnamed cross-origin frame by src pathname.
const planned: string[] = [];
const planner: LearnPlanner = async (req) => {
  planned.push(...req.fields.map((f) => f.label));
  return { fills: [], atReview: true };
};
const adapter = new AutoLearnAdapter("DOM Smoke Portal", planner);
(adapter as unknown as { page: unknown }).page = page;
const raws = await (adapter as unknown as { extractAllFrames: (s: string) => Promise<Array<{ name?: string; frame?: string }>> })
  .extractAllFrames(EXTRACT_SEL);
await check("cross-origin unnamed frame's field extracted with a src: frame key", () => {
  const f = raws.find((r) => r.name === "xoriginField");
  assert.ok(f, `xoriginField extracted (saw: ${raws.map((r) => r.name).join(",")})`);
  assert.equal(f!.frame, "src:/embed/form", "frame keyed by src pathname (no session token)");
});

// 4) frameSelectorFor + frameLocator actually reach INTO the cross-origin frame.
await check("frameSelectorFor(src:) builds a working frameLocator", async () => {
  assert.equal(frameSelectorFor("src:/embed/form"), 'iframe[src*="/embed/form"]');
});
await page.frameLocator(frameSelectorFor("src:/embed/form")).getByLabel("Cross Origin Field").fill("reached");
const filled = await page.frames()[1].$eval("#xf", (e) => (e as HTMLInputElement).value);
await check("fill through the src-keyed frameLocator lands cross-origin", () => {
  assert.equal(filled, "reached");
});

// 5) Name/id keys keep their original selector shape (regression).
await check("frameSelectorFor(name) unchanged for named frames", () => {
  assert.equal(frameSelectorFor("ACADialogFrame"), 'iframe[name="ACADialogFrame"], iframe[id="ACADialogFrame"]');
});

// 6) PATCH-BY-DEMONSTRATION capture: arm the page, act like a human, assert what lands.
const { armHumanCaptureOnPage } = await import("../humanCapture");
const patchPage = await browser.newPage();
await patchPage.setContent(`<!doctype html><html><body>
  <label for="sched">Schedule</label>
  <select id="sched"><option value="">Select…</option><option value="s7">Schedule 7</option></select>
  <label for="acct">Account Number</label><input id="acct" name="accountNumber">
  <button type="button">Save Draft</button>
  <button type="button">Submit Application</button>
  <button type="button">Pay Now</button>
  <button type="button">Submit</button>
  <button type="button">Continue</button>
</body></html>`);
const captured: Array<{ action: string; note?: string; value?: string; sensitive?: boolean }> = [];
const armed = await armHumanCaptureOnPage(patchPage, (step) => captured.push(step as never));
await check("capture arms on a live page", () => assert.equal(armed, true));

await patchPage.selectOption("#sched", "s7");
await patchPage.fill("#acct", "ACCT-12345");
await patchPage.locator("#acct").dispatchEvent("change");
await patchPage.getByRole("button", { name: "Save Draft" }).click();
await patchPage.getByRole("button", { name: "Submit Application" }).click();
await patchPage.getByRole("button", { name: "Pay Now" }).click();
// A BARE "Submit" click (PGE PowerClerk's real final button) must not be captured AND must
// DISARM capture — the application is being filed, so nothing after it belongs in the recipe.
await patchPage.getByRole("button", { name: "Submit", exact: true }).click();
await patchPage.getByRole("button", { name: "Continue" }).click();
await patchPage.selectOption("#sched", ""); // post-submit change — must also be ignored
await patchPage.waitForTimeout(300);

await check("human select captured with its label + value", () => {
  const sel = captured.find((c) => c.action === "select");
  assert.ok(sel, `captured: ${JSON.stringify(captured)}`);
  assert.equal(sel!.value, "s7");
});
await check("sensitive field flagged for the merge-time strip, value confined to its own step", () => {
  // Contract: the typed secret rides IN MEMORY on the sensitive step only, so the
  // backend merge can bind it to a project field key — appendHumanPatchSteps then
  // strips the literal unconditionally before anything is persisted (covered by
  // backend/test/humanPatch.test.ts). Capture-side, what must hold is: the step is
  // flagged sensitive (the strip trigger), its note says so, and the secret leaks
  // into NO other captured step.
  const fills = captured.filter((c) => c.action === "fill");
  assert.ok(fills.length >= 1, "fill captured");
  for (const fill of fills) {
    assert.equal(fill.sensitive, true, "flagged sensitive");
    assert.ok((fill.note || "").includes("SENSITIVE"), "note marks the strip-at-merge contract");
  }
  const nonSensitive = captured.filter((c) => c.sensitive !== true);
  assert.ok(!JSON.stringify(nonSensitive).includes("ACCT-12345"), "secret never rides an unflagged step");
});
await check("navigation click captured; submit/pay clicks NEVER captured as replayable steps", () => {
  const clicks = captured.filter((c) => c.action === "click" && (c.note || "") !== "__human_submit_observed__");
  assert.equal(clicks.length, 1, `clicks: ${JSON.stringify(clicks)}`);
  assert.ok((clicks[0].note || "").includes("Save Draft"));
});
await check("bare Submit click emits the submit-observed signal, then DISARMS capture", () => {
  const markers = captured.filter((c) => (c.note || "") === "__human_submit_observed__");
  assert.equal(markers.length, 1, `expected one submit-observed marker: ${JSON.stringify(captured)}`);
  assert.ok(!captured.some((c) => (c.note || "").includes("Continue")), `Continue leaked: ${JSON.stringify(captured)}`);
  const selects = captured.filter((c) => c.action === "select");
  assert.equal(selects.length, 1, `post-submit select change leaked: ${JSON.stringify(selects)}`);
});

// IN-PAGE PREDICATES MUST NOT REFERENCE __name. The bundler's keepNames transform wraps
// any function it can infer a name for — `const f = (x) => …` and `const f = function (x)
// {…}` alike — as `__name(fn, "f")`, which does not exist in the browser. A predicate that
// hits it throws ReferenceError on every poll: waitForInteractiveControls could never
// return true and burned its full 12s budget on EVERY page of every portal (measured 9/9
// x 12s = 108s in one Accela run), and two other guards were silently catch-to-false.
// Only fully inline anonymous callbacks survive, so exercise the real helpers in a real
// browser rather than trusting review.
{
  const probe = await browser.newPage();
  await probe.setContent("<html><body><input type='text' style='width:120px;height:24px'><button>Go</button></body></html>");

  const { waitForInteractiveControls } = await import("../safeAction");
  const t0 = Date.now();
  const ready = await waitForInteractiveControls(probe, 4000);
  const ms = Date.now() - t0;
  await check("waitForInteractiveControls resolves on a page WITH a visible control (no __name throw)", () => {
    assert.equal(ready, true, "readiness gate must see the visible input");
    assert.ok(ms < 2000, `must resolve promptly, took ${ms}ms (a __name ReferenceError burns the whole budget)`);
  });

  // Guard the whole class: any inline predicate shaped like the ones we ship must run.
  const namedArrowThrows = await probe.evaluate(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const helper = (n: number): number => n + 1;
      return helper(1) !== 2;
    } catch { return true; }
  }).catch(() => true);
  await check("a named helper inside an in-page callback is the known-bad shape", () => {
    assert.equal(namedArrowThrows, true, "if this ever passes, keepNames stopped rewriting and the rule can relax");
  });
  await probe.close();
}

await browser.close();
child.close();
parent.close();
fs.rmSync(process.env.AUTOLEARN_RUN_DIR!, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} DOM-extraction smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll DOM-extraction smoke tests passed (real Chromium).");
