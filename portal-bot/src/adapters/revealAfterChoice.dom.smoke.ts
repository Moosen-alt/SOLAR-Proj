// A CHOICE THAT REVEALS A REQUIRED SECRET BOX, IN REAL CHROMIUM (live PGE PowerClerk learn,
// 2026-09-28, bundle 2026-09-28_22-32-23_pge_ylgx).
//
// On "Description of Service" the planner ticked "New net metering system at a location
// currently served by PGE". PowerClerk then REVEALED two required boxes — "PGE Account Number
// for point of interconnection" and "Meter Number". The learner's post-fill re-scan (d3) saw
// both (p006-rescan1.json lists them) and recorded a step for each, bound by name — but at
// learn time it typed "" into them, because the secret was never read from the project. The
// portal's review page then said "Missing Required Fields: PGE Account Number for point of
// interconnection; Meter Number", and nothing in the run's own accounting had said so: the
// required-field sweep excludes secret-looking boxes.
//
// What this pins:
//   1. the learn types THIS project's account and meter numbers into the revealed boxes, read
//      BY NAME at fill time (the same binding the replay resolves);
//   2. the recorded steps carry no literal (value "", field = the binding), recorded AFTER the
//      choice that revealed them, so a replay fills them in order;
//   3. the secret reaches no planner request, no recorded step, no result message and no JSON
//      artifact of the debug bundle — and every screenshot taken while it is on the page
//      (planner vision, review, bundle PNGs) masks it;
//   4. a replay of the learned steps on ANOTHER project types that project's values;
//   5. a project with no value on file leaves the box blank AND says so, by label;
//   6. a page whose choice reveals nothing costs no extra planner call.
//
// Run: npx tsx portal-bot/src/adapters/revealAfterChoice.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanRequest, type LearnPlanner } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const CHOICE = "New net metering system at a location currently served by PGE";
const ACCT_LABEL = "PGE Account Number for point of interconnection";

// PowerClerk-shaped, one URL, two wizard steps (PowerClerk renders every step at one URL).
// The review step ECHOES the typed account and meter as text, as real review pages do — the
// harshest case for "the secret never leaves the process".
const page1 = (reveal: boolean, dropFirst = false): string => `<!doctype html><html><head><title>Edit Project</title></head><body>
<div id="step1">
  <h2>Description of Service</h2>
  <fieldset class="form-group">
    <legend>Description of Service *</legend>
    <input type="radio" id="svcCurrent" name="svc" required><label for="svcCurrent">${CHOICE}</label>
    <input type="radio" id="svcNew" name="svc"><label for="svcNew">New net metering system at a location that is NOT YET served by PGE</label>
  </fieldset>
  <div id="reveal"></div>
  <div class="form-group"><label for="amps">Main Service Entrance Rating (Amps)</label><input id="amps" type="text"></div>
  <button id="next" type="button">Next</button>
</div>
<div id="step2" style="display:none">
  <h2>Review</h2>
  <p>Please review your application before submitting.</p>
  <p>Account: <span id="rvAcct"></span> Meter: <span id="rvMtr"></span></p>
  <button id="submit" type="button">Submit Application</button>
</div>
<script>
  var saved = {};
  ${reveal ? `
  // PowerClerk RENDERS the dependent block only after the choice's own round-trip (Vue v-if):
  // before the choice the boxes are not hidden, they do not exist — the live p006 plan's
  // fieldsSeen has neither. Per-field autosave commits on BLUR only.
  document.getElementById('svcCurrent').addEventListener('change', function () {
    setTimeout(function () {
      var host = document.getElementById('reveal');
      if (host.children.length) return;
      host.innerHTML =
        '<div class="form-group"><label for="acct">${ACCT_LABEL}</label><span class="text-danger"> * </span>' +
        '<input id="acct" type="text" required></div>' +
        '<div class="form-group"><label for="mtr">Meter Number</label><span class="text-danger"> * </span>' +
        '<input id="mtr" type="text" required></div>';
      ['acct', 'mtr'].forEach(function (id) {
        var first = ${dropFirst ? "true" : "false"};
        document.getElementById(id).addEventListener('blur', function () {
          // ?drop=1: the portal's first save round-trip hands the box back EMPTY (a re-render
          // dropping the value) — the read-back must see it and re-type by name.
          if (first) { first = false; this.value = ''; saved[id] = ''; return; }
          saved[id] = this.value;
        });
      });
    }, 400);
  });
  document.getElementById('svcNew').addEventListener('change', function () {
    document.getElementById('reveal').innerHTML = '';
  });` : ""}
  // PowerClerk renders ONE step at a time: Next replaces the step, and the review echoes what the
  // portal SAVED (the blur autosave) — so a value typed but never committed reviews as blank.
  document.getElementById('next').addEventListener('click', function () {
    ${reveal ? `document.getElementById('rvAcct').textContent = saved.acct || '';
    document.getElementById('rvMtr').textContent = saved.mtr || '';` : ""}
    document.getElementById('step1').remove();
    document.getElementById('step2').style.display = 'block';
  });
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(page1(!String(req.url || "").startsWith("/noreveal"), /[?&]drop=1\b/.test(String(req.url || ""))));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// Project A's secrets. The meter number carries letters on purpose: redactStatusText only masks
// digit runs, so it proves the secret scrub is its own layer.
const A = { accountNumber: "7734009155", meterNumber: "MX4471Q" };
const B = { accountNumber: "5550001111", meterNumber: "QZ9981K" };
const SECRETS = [A.accountNumber, A.meterNumber];
const leaks = (text: string): string[] => SECRETS.filter((s) => text.toLowerCase().includes(s.toLowerCase()));

// The planner the backend would build: it never holds a secret, so it cannot fill one. It
// answers the choice and the rating, advances, and calls review when the page says review.
function makePlanner(requests: Array<Omit<LearnPlanRequest, "screenshotBase64"> & { hadShot: boolean }>): LearnPlanner {
  return async (req) => {
    const { screenshotBase64, ...rest } = req;
    requests.push({ ...rest, hadShot: !!screenshotBase64 });
    if (/please review/i.test(req.bodyText)) return { fills: [], atReview: true };
    if (req.alreadyFilledLabels.length > 0) return { fills: [], atReview: false }; // a re-scan
    const at = (label: string, type?: string) => req.fields.findIndex((f) => f.label === label && (!type || f.fieldType === type));
    const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
    if (at(CHOICE, "radio") >= 0) fills.push({ selectorIndex: at(CHOICE, "radio"), value: "true" });
    if (at("Main Service Entrance Rating (Amps)") >= 0) fills.push({ selectorIndex: at("Main Service Entrance Rating (Amps)"), value: "200", field: "mainServiceRating" });
    const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(f.label));
    return { fills, advanceSelectorIndex: next >= 0 ? next : undefined, atReview: false };
  };
}

// Every screenshot the learner takes, with what its mask covered at that moment.
type Shot = { secretOnPage: boolean; masked: number; reviewTextMasked: boolean };
function spyScreenshots(page: Page, shots: Shot[], secret: string): void {
  const orig = page.screenshot.bind(page);
  (page as unknown as { screenshot: unknown }).screenshot = async (opts?: Parameters<Page["screenshot"]>[0]) => {
    // On the page = in a box's value or in the rendered text (the review echo).
    const onPage = await page.evaluate((s) => {
      if (String(document.body ? document.body.innerText : "").indexOf(s) >= 0) return true;
      for (const el of Array.from(document.querySelectorAll("input"))) if ((el as HTMLInputElement).value === s) return true;
      return false;
    }, secret).catch(() => false);
    let masked = 0;
    for (const m of (opts?.mask ?? [])) masked += await m.count().catch(() => 0);
    const reviewShown = await page.locator("#step2").isVisible().catch(() => false);
    const reviewTextMasked = !reviewShown || (await page.locator("#rvAcct[data-al-secret], #rvAcct:has([data-al-secret])").count().catch(() => 0)) > 0;
    shots.push({ secretOnPage: onPage, masked, reviewTextMasked });
    return orig(opts);
  };
}

function bundleText(dir: string): string {
  let out = "";
  for (const name of fs.readdirSync(dir)) {
    if (/\.(png|zip)$/i.test(name)) continue; // raw renders — masked (PNG) / documented raw (trace)
    out += `\n--- ${name}\n` + fs.readFileSync(path.join(dir, name), "utf8");
  }
  return out;
}

const T0 = Date.now();
const lap = (what: string): void => console.log(`  [${((Date.now() - T0) / 1000).toFixed(0)}s] ${what}`);
const browser = await chromium.launch();

const runDirs: string[] = [];
async function learnOn(url: string, project: Partial<ProjectRecord>, tag: string) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `reveal-smoke-${tag}-`));
  runDirs.push(runDir);
  // The bundle folder is chosen at CONSTRUCTION — build the adapter before any await, so the
  // three learns that run side by side each keep their own.
  process.env.AUTOLEARN_RUN_DIR = runDir;
  const requests: Array<Omit<LearnPlanRequest, "screenshotBase64"> & { hadShot: boolean }> = [];
  const adapter = new AutoLearnAdapter("PGE PowerClerk (reveal smoke)", makePlanner(requests), { policyProfile: "none" });
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  await page.goto(url);
  const shots: Shot[] = [];
  spyScreenshots(page, shots, String(project.accountNumber ?? "\u0000"));
  (adapter as unknown as { page: unknown }).page = page;
  const result = await adapter.learn({} as never, project as ProjectRecord);
  // What the portal SAVED (blur autosave) — the boxes themselves are gone once review renders.
  const saved = await page.evaluate(() => (globalThis as unknown as { saved?: Record<string, string> }).saved ?? {}).catch(() => ({} as Record<string, string>));
  return { page, context, result, requests, shots, saved, dir: adapter.debug?.dir ?? "" };
}

// Three learns side by side (each walks the portal's own entry look first, ~60 s apiece):
// A = the reveal on a project with secrets, E = the reveal with none on file, N = no reveal.
lap("learns A, E, N");
const [a, e, n] = await Promise.all([
  learnOn(`${base}/app?drop=1`, A as Partial<ProjectRecord>, "a"),
  learnOn(`${base}/app`, {} as Partial<ProjectRecord>, "e"),
  learnOn(`${base}/noreveal`, A as Partial<ProjectRecord>, "n"),
]);
lap("learns done");

// ---- 1-3: the reveal learn on project A --------------------------------------------------
const acctValue = String(a.saved.acct ?? "");
const mtrValue = String(a.saved.mtr ?? "");
const idx = (pred: (s: RecipeStep) => boolean) => a.result.steps.findIndex(pred);
const choiceAt = idx((s) => s.note === CHOICE);
const acctAt = idx((s) => s.note === ACCT_LABEL);
const mtrAt = idx((s) => s.note === "Meter Number");

await check("the learn reaches review", () => assert.equal(a.result.reachedReview, true, a.result.message));
// A's page drops each box's FIRST save (?drop=1), so a pass here also proves the read-back
// re-typed the secret by name after the portal blanked it.
await check("the revealed account box was typed AND saved with THIS project's account number (by name, at fill time)", () =>
  assert.equal(acctValue, A.accountNumber, `portal saved account = ${JSON.stringify(acctValue.replace(/\w/g, "#"))}`));
await check("the revealed meter box was typed AND saved with THIS project's meter number", () =>
  assert.equal(mtrValue, A.meterNumber, `portal saved meter length ${mtrValue.length}`));
await check("both secret steps are recorded AFTER the choice that revealed them, bound by name, no literal", () => {
  assert.ok(choiceAt >= 0, "the choice step was recorded");
  assert.ok(acctAt > choiceAt && mtrAt > choiceAt, `order: choice ${choiceAt}, account ${acctAt}, meter ${mtrAt}`);
  const acct = a.result.steps[acctAt];
  const mtr = a.result.steps[mtrAt];
  assert.deepEqual({ s: acct.sensitive, v: acct.value, f: acct.field }, { s: true, v: "", f: "accountNumber" });
  assert.deepEqual({ s: mtr.sensitive, v: mtr.value, f: mtr.field }, { s: true, v: "", f: "meterNumber" });
});
await check("the secret is in no planner request (fields, body text, filled labels)", () =>
  assert.deepEqual(leaks(JSON.stringify(a.requests)), [], "a planner request carried a secret"));
await check("the secret is in no recorded step and not in the result message", () =>
  assert.deepEqual(leaks(JSON.stringify(a.result.steps) + a.result.message + JSON.stringify(a.result.reviewScreen)), []));
await check("the secret is in no JSON artifact of the debug bundle (events, sidecars, page captures)", () => {
  assert.ok(a.dir && fs.existsSync(a.dir), `no debug bundle at ${a.dir}`);
  assert.deepEqual(leaks(bundleText(a.dir)), []);
});
await check("the review page was reached with the secret on it, and the planner still saw it only masked", () => {
  const withSecret = a.shots.filter((s) => s.secretOnPage);
  assert.ok(withSecret.length > 0, `no screenshot was taken after the secret was typed (${a.shots.length} shots) — the check below would prove nothing`);
  const unmasked = withSecret.filter((s) => s.masked < 2);
  assert.equal(unmasked.length, 0, `${unmasked.length}/${withSecret.length} screenshot(s) taken with the secret on the page masked fewer than its two boxes`);
  assert.ok(withSecret.every((s) => s.reviewTextMasked), "the review page echoes the account as text and that text was not masked");
});
await check("the planner was asked about the revealed boxes by LABEL (no value) on the re-scan", () => {
  const rescan = a.requests.find((r) => r.alreadyFilledLabels.length > 0);
  assert.ok(rescan, "no re-scan planner call");
  assert.ok(rescan!.fields.some((f) => f.label === ACCT_LABEL), "the re-scan did not list the revealed account box");
});

// ---- 4: replay the learned steps on project B ------------------------------------------
{
  const recipe = {
    id: "reveal-smoke", scopeType: "utility", profileKey: "or||pge", state: "OR", ahj: "", utility: "PGE",
    portalPlatform: "powerclerk", portalUrl: `${base}/app`, status: "complete", version: 1,
    steps: a.result.steps.filter((s) => !s.isFinalSubmit),
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
  } as unknown as PortalRecipe;
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const rp = await ctx.newPage();
  const replay = new RecipeAdapter(recipe, { ...B, mainServiceRating: "200" }, {}, { autoSubmit: false });
  (replay as unknown as { page: unknown }).page = rp;
  lap("replay B");
  const r = await replay.fillApplication({} as never);
  const bSaved = await rp.evaluate(() => (globalThis as unknown as { saved?: Record<string, string> }).saved ?? {}).catch(() => ({} as Record<string, string>));
  const bAcct = String(bSaved.acct ?? "");
  const bMtr = String(bSaved.mtr ?? "");
  await check("a replay of the learned steps on ANOTHER project types that project's values", () => {
    assert.equal(bAcct, B.accountNumber, `replay account box (${r.ok ? "ok" : "failed"}: ${String(r.message ?? "").slice(0, 200)})`);
    assert.equal(bMtr, B.meterNumber, "replay meter box");
  });
  await check("the replay never carries project A's secrets", () =>
    assert.deepEqual(leaks(JSON.stringify(r)), []));
  await ctx.close();
}

// ---- 5: a project with no account/meter on file -----------------------------------------
{
  const events = fs.existsSync(path.join(e.dir, "events.jsonl")) ? fs.readFileSync(path.join(e.dir, "events.jsonl"), "utf8") : "";
  await check("no value on file: the boxes stay blank and the bindings are still recorded", () => {
    assert.equal(String(e.saved.acct ?? ""), "");
    assert.ok(e.result.steps.some((s) => s.field === "accountNumber" && s.sensitive === true), "the account binding was not recorded");
  });
  await check("no value on file: the run SAYS which required secret boxes it left for a person (labels only)", () => {
    assert.match(events, /"type":"required_secret_unfilled"/, "no required_secret_unfilled event");
    assert.ok(events.includes(ACCT_LABEL) && events.includes("Meter Number"), "the event does not name both boxes");
    assert.match(e.result.message, /PGE Account Number for point of interconnection/, "the hand-off message does not name the account box");
  });
  await e.context.close();
}

// ---- 6: a choice that reveals nothing -----------------------------------------------------
await check("a page whose choice reveals nothing: one planner call for the page, one for review", () => {
  assert.equal(n.result.reachedReview, true, n.result.message);
  assert.equal(n.requests.length, 2, `planner calls: ${n.requests.map((r) => (r.alreadyFilledLabels.length ? "rescan" : /please review/i.test(r.bodyText) ? "review" : "page")).join(", ")}`);
});

lap("done");
await n.context.close();
await a.context.close();
await browser.close();
server.close();
for (const d of runDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

if (failures > 0) {
  console.error(`\n${failures} reveal-after-choice smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll reveal-after-choice smoke tests passed (real Chromium).");
process.exit(0);
