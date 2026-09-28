// =================================================================================================
// THE FILLED FORMS STAY ON SCREEN WHEN THE CHAIN HAS ALREADY BUILT THE PACKET.
//
// Operator 09-27: "the files that it finds don't stay if you leave the project and come back".
// Operator 09-28: "the PDFs go away if I click out of the project".
//
// selectProject() nulls state.applicationDocs / state.filledForms, then runs the panel loaders.
// loadStageResults() fills state.applicationDocs from GET /stage-results whenever the audit trail
// has an `application_docs.generated` row — which the automatic chain writes within seconds of a
// project's creation, and every page-open GET /application-docs writes again. The 09-27 background
// loader then bails on `|| state.applicationDocs` BEFORE it POSTs /filled-forms, so
// state.filledForms stays null and renderFilledForms() returns "" — the download links, the
// "none on file / Find official form / Upload blank PDF" card, all of it, gone from the page while
// every PDF is still on disk. The SSE `stage_steps_done` handler re-selects the open project, so
// it also happens the moment the chain finishes, with no click.
//
// The whole shipped dashboard.js runs here in real Chromium against a stubbed /api. The one
// discriminating input is GET /stage-results answering with a non-null applicationDocs; scenario
// A's FIRST open alone discriminates — the board round trip is the operator's report, for fidelity.
//
//   A (chain already ran):            stage-results.applicationDocs = pkg  → link MUST show, POST /filled-forms MUST run
//   B (control, chain not yet logged): stage-results.applicationDocs = null → link shows today (the harness can show it)
//   C (the form search is in flight):  a packet row carries `inFlight` → the forms card says "Checking the
//                                      AHJ's required official forms… (started HH:MM UTC)" and its Find
//                                      button is disabled (one search per AHJ/path at a time)
//
// The `{}` default stub makes the live-readiness panel log a TypeError; safeRender isolates it and it
// is not what this smoke reads (the submit-gate stub is a minimal blocked gate).
//
// Discovered from disk by scripts/run-dom-smokes.ts: `npm run portal:test:dom`.
// Alone: `npx tsx frontend/appDocsRoundTrip.dom.smoke.ts`
// DASHBOARD_REPO_DIR / DASHBOARD_FRONTEND_DIR point it at another checkout or frontend/ (the kill).
// =================================================================================================
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.DASHBOARD_REPO_DIR || path.resolve(HERE, "..");
const FRONTEND = process.env.DASHBOARD_FRONTEND_DIR || path.join(REPO, "frontend");
const require = createRequire(path.join(REPO, "package.json"));
const { chromium } = require("playwright");

let passed = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); }
  return fn();
}

const PID = "p1";
const project = {
  id: PID, homeownerName: "Test Homeowner", projectAddress: "1 Test St", ahj: "City of Testville", state: "OR",
  utility: "Test Power", status: "ready_to_stage", stageDetail: "", systemSizeDcKw: 7.2, systemSizeAcKw: 6.5,
  createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z", parserSnapshot: {},
};
const detail = { project, projectNotes: [], qcResults: [], corrections: [], submissions: [], documents: [], auditLogs: [], permitStatusChecks: [], reviewItems: [], notes: [] };
const pkg = {
  profile: { id: "process-testville", name: "City of Testville", requiresAhjApplication: true, notes: [] },
  docs: [{ id: "cover", title: "Cover sheet", fileName: "cover.pdf", required: true, documentType: "cover" }],
  missingFields: [], missingDocuments: [], missingDocumentsStatus: "resolved", html: "<p>pkg</p>",
};
const filledForms = {
  projectId: PID, ahj: "City of Testville",
  forms: [{ formId: "tmpl-abc", formName: "Building Permit Application", status: "filled", verified: true, templateId: "abc", filledFieldCount: 12 }],
};

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };

async function scenario(name: string, stageResultsDocs: unknown): Promise<void> {
  console.log(`\n--- ${name} ---`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  const counts = { appDocsGet: 0, filledPost: 0, stageResults: 0, detail: 0 };
  const consoleErrors: string[] = [];
  page.on("pageerror", (e: Error) => consoleErrors.push(String(e && e.message || e)));
  page.on("console", (m: { type(): string; text(): string }) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await page.route("**/*", async (route: any) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (u.hostname === "dash.test" && !p.startsWith("/api") && p !== "/health") {
      const f = path.join(FRONTEND, p === "/" ? "dashboard.html" : p.slice(1));
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) });
      return route.fulfill({ status: 404, body: "" });
    }
    if (u.hostname !== "dash.test") return route.abort();
    if (p === "/health") return json({ ok: true });
    if (p === "/api/events") return route.abort();
    if (p === "/api/projects") return json({ projects: [project], total: 1 });
    if (p === `/api/projects/${PID}`) { counts.detail++; return json(detail); }
    if (p === `/api/projects/${PID}/stage-results`) { counts.stageResults++; return json({ applicationDocs: stageResultsDocs, reviewerReport: null, historicalReport: null }); }
    if (p === `/api/projects/${PID}/application-docs`) { counts.appDocsGet++; return json(pkg); }
    if (p === `/api/projects/${PID}/filled-forms` && req.method() === "POST") { counts.filledPost++; return json(filledForms); }
    if (p === `/api/projects/${PID}/documents`) return json({ documents: [] });
    if (p === `/api/projects/${PID}/submit-gate`) return json({ decision: "blocked", headline: "stub gate", nextAction: "", checks: [], canPrepareSubmission: false, blockers: [] });
    if (p === "/api/users") return json([]);
    if (p === "/api/clients") return json({ clients: [] });
    return json({});
  });

  await page.goto(`http://dash.test/dashboard.html#/project/${PID}`, { waitUntil: "domcontentloaded" });
  // The packet band paints when state.applicationDocs is set (from stage-results or the GET). It
  // sits inside a closed stage accordion, so "attached", not "visible".
  const painted = await until(() => counts.detail >= 1) && await page.waitForSelector("#applicationDocs .kx-preflight", { state: "attached", timeout: 15000 }).then(() => true).catch(() => false);
  check(`${name}: the AHJ packet band painted (harness sanity)`, painted, consoleErrors.slice(0, 3).join(" | "));
  // Let the background loader run to its end: a GET of application-docs and/or the POST.
  await until(() => counts.appDocsGet >= 1 || counts.filledPost >= 1, 8000);
  await sleep(1200);
  const links1 = await page.locator(`#applicationDocs a[href*="/filled-forms/"]`).count();
  const findBtn1 = await page.locator("#findAhjFormBtn").count();
  console.log(`  after first open: detail=${counts.detail} stage-results=${counts.stageResults} GET application-docs=${counts.appDocsGet} POST filled-forms=${counts.filledPost} links=${links1} findBtn=${findBtn1}`);
  check(`${name}: opening the project POSTs /filled-forms (the forms are loaded)`, counts.filledPost >= 1, `POST count ${counts.filledPost}`);
  check(`${name}: the filled PDF download link is on the page after the first open`, links1 >= 1, `links=${links1}`);

  // The operator's round trip: out to the board, back in through the same project's card.
  await page.evaluate(() => { window.location.hash = "#/dashboard"; });
  const card = await page.waitForSelector(`#projectBoard [data-board-pid="${PID}"]`, { timeout: 10000 }).catch(() => null);
  check(`${name}: the board shows the project's card`, Boolean(card));
  const before = { detail: counts.detail, appDocsGet: counts.appDocsGet, filledPost: counts.filledPost };
  if (card) await card.click();
  await until(() => counts.detail > before.detail, 8000);
  await page.waitForSelector("#applicationDocs .kx-preflight", { state: "attached", timeout: 15000 }).catch(() => null);
  await until(() => counts.appDocsGet > before.appDocsGet || counts.filledPost > before.filledPost, 8000);
  await sleep(1200);
  const links2 = await page.locator(`#applicationDocs a[href*="/filled-forms/"]`).count();
  console.log(`  after round trip: detail=${counts.detail} GET application-docs=${counts.appDocsGet} POST filled-forms=${counts.filledPost} links=${links2}`);
  check(`${name}: coming back to the project still shows the filled PDF link`, links2 >= 1, `links=${links2}`);
  check(`${name}: coming back re-loaded the forms (POST /filled-forms ran again)`, counts.filledPost > before.filledPost, `POST count ${before.filledPost} -> ${counts.filledPost}`);
  if (consoleErrors.length) console.log(`  (page errors, stub noise isolated by safeRender: ${consoleErrors.slice(0, 2).join(" | ").slice(0, 300)})`);
  await browser.close();
}

// THE SEARCH IS RUNNING NOW (backend formAcquisitionPlan's in-flight registry): the packet's
// acquiredAtStagingDocuments carry `inFlight`, the forms card says "Checking the AHJ's required
// official forms… (started HH:MM UTC)" and holds its Find button — a click mid-search used to start a
// second, identical six-minute search (Beaverton, 09-28: three passes at once).
async function inFlightScenario(): Promise<void> {
  const name = "C: the form search is in flight (packet row inFlight, no filled form yet)";
  console.log(`\n--- ${name} ---`);
  const searching = {
    ...pkg,
    acquiredAtStagingDocuments: [{
      docType: "building_application", label: "Structural (non-prescriptive) permit application, filled", lane: "permit",
      why: "Stage is searching for it now (started 22:13 UTC) — the form research for City of Testville is in flight", via: "research", sourceUrl: "",
      inFlight: { since: "2026-09-28T22:13:43.000Z" },
    }],
  };
  const noForms = { projectId: PID, ahj: "City of Testville", forms: [] };
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  await page.route("**/*", async (route: any) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (u.hostname === "dash.test" && !p.startsWith("/api") && p !== "/health") {
      const f = path.join(FRONTEND, p === "/" ? "dashboard.html" : p.slice(1));
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) });
      return route.fulfill({ status: 404, body: "" });
    }
    if (u.hostname !== "dash.test") return route.abort();
    if (p === "/health") return json({ ok: true });
    if (p === "/api/events") return route.abort();
    if (p === "/api/projects") return json({ projects: [project], total: 1 });
    if (p === `/api/projects/${PID}`) return json(detail);
    if (p === `/api/projects/${PID}/stage-results`) return json({ applicationDocs: searching, reviewerReport: null, historicalReport: null });
    if (p === `/api/projects/${PID}/application-docs`) return json(searching);
    if (p === `/api/projects/${PID}/filled-forms` && req.method() === "POST") return json(noForms);
    if (p === `/api/projects/${PID}/documents`) return json({ documents: [] });
    if (p === `/api/projects/${PID}/submit-gate`) return json({ decision: "blocked", headline: "stub gate", nextAction: "", checks: [], canPrepareSubmission: false, blockers: [] });
    if (p === "/api/users") return json([]);
    if (p === "/api/clients") return json({ clients: [] });
    return json({});
  });
  await page.goto(`http://dash.test/dashboard.html#/project/${PID}`, { waitUntil: "domcontentloaded" });
  const btn = await page.waitForSelector("#findAhjFormBtn", { state: "attached", timeout: 15000 }).catch(() => null);
  check(`${name}: the forms card (with its Find button) is on the page`, Boolean(btn));
  const disabled = btn ? await btn.isDisabled() : false;
  const status = await page.locator("#findAhjFormStatus").textContent().catch(() => "");
  console.log(`  findBtn disabled=${disabled} status="${status}"`);
  check(`${name}: the Find button is held while the search runs`, disabled);
  check(`${name}: the card says the search is running, with its start time`, /Checking the AHJ's required official forms… \(started 22:13 UTC\)/.test(String(status || "")), `status="${status}"`);
  await browser.close();
}

await scenario("A: chain already logged application_docs.generated (stage-results carries the packet)", pkg);
await scenario("B: control — stage-results has no packet yet", null);
await inFlightScenario();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log("\nAll app-docs round-trip checks passed (real Chromium, shipped dashboard.html + dashboard.js).");
