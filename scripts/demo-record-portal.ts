// ---------------------------------------------------------------------------
// ACT 4, RECORDED: THE REAL REPLAY ENGINE FILLS A PORTAL AND STOPS AT REVIEW.
//
// The runbook's Act 4 is the product's most important promise — it fills the portal for
// you, and it never files for you. Showing it live needs a portal; a real one is off the
// table in a demo (no credentials, no outbound traffic, and a real portal is a real filing).
// This records it instead, against scripts/demo-portal/portal.ts — a clearly fictional
// "Demo Utility Co" served on 127.0.0.1 — bound to one of the demo kit's synthetic projects.
//
// WHAT IS REAL AND WHAT IS NOT, stated plainly because the video will be shown as evidence:
//   REAL product code  · performLogin (portal-bot/src/adapters/loginFlow.ts) — the same
//                        portal-agnostic login RecipeAdapter.login() calls after it opens
//                        the browser;
//                      · RecipeAdapter.openSubmission → fillApplication (runAll: drift
//                        precheck, bound-value resolution, cascade waits, upload, the
//                        executeClick final-submit allowlist, the stopForReview marker,
//                        the review-screen read-back) → uploadFiles → stopAtReview — the
//                        exact sequence runAdapter (portal-bot/src/index.ts) drives;
//                      · resolveRecipeFieldValues + clientStagingOverlay +
//                        submissionDocumentsByType — the bindings and document set that
//                        prepareSubmission hands stageWithRecipe.
//   NOT run            · stageWithRecipe / runAdapter / openPortal. openPortal refuses on
//                        this install (PORTAL_AUTOMATION=off, which this script leaves
//                        alone) and has no video or network-route hooks, so the recorder
//                        launches the browser itself and hands the page to the adapter —
//                        the same pattern every *.dom.smoke.ts uses. The credential is a
//                        fixture literal below, not the encrypted credential store.
//   FICTIONAL          · the portal and the recipe (hand-written, portal_recipes-shaped).
//
// SAFETY
//   · REFUSES (exit 2), reading the source DB read-only before anything is copied, unless:
//     the DB is <cwd>/backend/data/…; it holds ONLY the "Solaris Demo Co" client; and the
//     bound project belongs to that company with ZIP 99999. A real homeowner's project — or a
//     production database passed with --db — cannot be recorded (scripts/demo-portal/guards.ts).
//   · REFUSES before the portal or a browser starts unless the recipe's final-submit step,
//     put through the engine's real executeClick on a page-less guided-manual adapter, is
//     refused by the guided-manual final-submit rule — not the fee gate, not anything else
//     (scripts/demo-portal/gateProbe.ts). During the run the same probe watches the real
//     adapter, and the gate the engine actually answered with is printed and is a save condition.
//   · The database is COPIED to a temp dir and the copy is opened (openDatabase migrates,
//     which is a write). The source — normally the demo kit's DB — is only ever read. The temp
//     dir (DB copy, raw video, engine shots) is removed in a finally on every exit path.
//   · Node-side network traps: fetch, http/https request/get, net/tls connect and
//     dns.lookup throw on any non-loopback host, and are counted.
//   · Browser-side: every non-loopback request is aborted by a context route and counted;
//     the browser's proxy is a dead loopback port so traffic outside the page (if any)
//     cannot leave either.
//   · The video is written to a temp dir and moved to --out ONLY when: the replay reached
//     review (ok), the engine stopped the final submit by the guided-manual final-submit rule
//     (observed, see above), finalSubmitClicked is false from every source, the fixture server saw no
//     request to its submit endpoint and no non-GET request at all, no request was aborted,
//     and the Node traps caught nothing. Otherwise it is deleted and the script exits 1.
//   · Uploads may only come from inside the current directory (the kit); anything else
//     stops the attach.
//
// Usage (cwd = a demo kit folder — the kit's own, or a scratch copy):
//   npx tsx <repo>/scripts/demo-record-portal.ts --out act4-portal.webm
//     [--project <id>]      default: the Terrence Boyd demo project (must be Solaris Demo Co, ZIP 99999)
//     [--db <path>]         default: backend/data/autopilot.sqlite; must be in <cwd>/backend/data
//                           (read-only guard, then copied — the source is never opened read-write)
//     [--shots <dir>]       also save key-step PNGs there
//     [--slowmo <ms>]       default 20 — per browser action. The engine makes many protocol
//                           calls per step; 0 already runs ~65s (its own 3s settle per page
//                           paces the video), and 50+ pushes past 90s
//     [--headed]            show the browser (default headless; video records either way)
//   npx tsx scripts/demo-record-portal.ts --selftest   # the save-gate predicate, no browser
// ---------------------------------------------------------------------------
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
// Side-effect free (a type-only playwright import), so it is safe ahead of the traps.
import { installLoopbackOnlyRoute, isLoopbackHost } from "./demo-portal/network";

// ── 1. Network traps, before anything else is imported ─────────────────────────────────
const nodeNetworkAttempts: string[] = [];
function hostOfRequestArgs(args: unknown[]): string {
  const a = args[0];
  if (typeof a === "string") { try { return new URL(a).hostname; } catch { return a; } }
  if (a instanceof URL) return a.hostname;
  if (a && typeof a === "object") {
    const o = a as { hostname?: string; host?: string };
    return String(o.hostname ?? o.host ?? "localhost").replace(/:\d+$/, "");
  }
  return "localhost";
}
function refuse(kind: string, host: string): never {
  nodeNetworkAttempts.push(`${kind} ${host}`);
  throw new Error(`[demo-record-portal] blocked non-loopback ${kind} to ${host} — this recording must not touch the network`);
}
for (const [mod, scheme] of [[http, "http"], [https, "https"]] as Array<[typeof http, string]>) {
  const origRequest = mod.request.bind(mod);
  const origGet = mod.get.bind(mod);
  (mod as { request: unknown }).request = (...args: unknown[]) => {
    const h = hostOfRequestArgs(args);
    if (!isLoopbackHost(h)) refuse(`${scheme}.request`, h);
    return (origRequest as (...a: unknown[]) => unknown)(...args);
  };
  (mod as { get: unknown }).get = (...args: unknown[]) => {
    const h = hostOfRequestArgs(args);
    if (!isLoopbackHost(h)) refuse(`${scheme}.get`, h);
    return (origGet as (...a: unknown[]) => unknown)(...args);
  };
}
for (const [mod, name] of [[net, "net"], [tls, "tls"]] as Array<[Record<string, unknown>, string]>) {
  for (const fn of ["connect", "createConnection"]) {
    const orig = mod[fn] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof orig !== "function") continue;
    mod[fn] = (...args: unknown[]) => {
      // (options) | (port, host?) | (path) — a unix/pipe path is local by definition.
      const a = args[0];
      const host = typeof a === "object" && a !== null
        ? ((a as { path?: string }).path ? "localhost" : String((a as { host?: string }).host ?? "localhost"))
        : typeof args[1] === "string" ? args[1] : "localhost";
      if (!isLoopbackHost(host)) refuse(`${name}.${fn}`, host);
      return orig.apply(mod, args);
    };
  }
}
{
  const origLookup = dns.lookup.bind(dns);
  (dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
    if (!isLoopbackHost(host)) refuse("dns.lookup", host);
    return (origLookup as (...a: unknown[]) => unknown)(host, ...rest);
  };
  const origP = dns.promises.lookup.bind(dns.promises);
  (dns.promises as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
    if (!isLoopbackHost(host)) refuse("dns.promises.lookup", host);
    return (origP as (...a: unknown[]) => unknown)(host, ...rest);
  };
}
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let h = "";
    try { h = new URL(u).hostname; } catch { h = u; }
    if (!isLoopbackHost(h)) refuse("fetch", h);
    return origFetch(input, init);
  }) as typeof fetch;
}
syncBuiltinESMExports();

// ── 2. The save gate — pure, so it can be proven to refuse without a browser ───────────
export interface RecordingEvidence {
  replayOk: boolean;
  /** Every place the run reports whether the final submit was clicked. */
  finalSubmitClickedSources: Array<boolean | undefined>;
  submitRequests: number;
  nonGetRequests: number;
  abortedRequests: number;
  nodeNetworkAttempts: number;
  reachedReviewUrl: boolean;
  /** Which click gate the ENGINE answered the final-submit step with, observed on the real
   *  adapter during the run (scripts/demo-portal/gateProbe.ts); "not-evaluated" when the step
   *  never reached executeClick. The captions say the guided-manual rule stopped the engine,
   *  so that — and only that — is what a kept video may show. */
  finalSubmitGates: string[];
}
export function recordingVerdict(e: RecordingEvidence): { keep: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!e.replayOk) reasons.push("the replay did not complete cleanly to the review screen");
  if (!e.reachedReviewUrl) reasons.push("the browser is not on the review page");
  if (e.finalSubmitGates.length === 0 || e.finalSubmitGates.some((g) => g !== "final-submit-guided-manual")) {
    reasons.push(`the final-submit step was not stopped by the guided-manual final-submit rule the captions describe (engine answered: ${JSON.stringify(e.finalSubmitGates)})`);
  }
  // Unknown is not reassurance: every source must say false explicitly.
  if (e.finalSubmitClickedSources.length === 0 || e.finalSubmitClickedSources.some((v) => v !== false)) {
    reasons.push(`finalSubmitClicked was not false from every source (${JSON.stringify(e.finalSubmitClickedSources)})`);
  }
  if (e.submitRequests > 0) reasons.push(`the fixture server received ${e.submitRequests} submit request(s)`);
  if (e.nonGetRequests > 0) reasons.push(`the fixture server received ${e.nonGetRequests} non-GET request(s)`);
  if (e.abortedRequests > 0) reasons.push(`${e.abortedRequests} non-loopback browser request(s) were attempted (aborted)`);
  if (e.nodeNetworkAttempts > 0) reasons.push(`${e.nodeNetworkAttempts} non-loopback Node network attempt(s) were trapped`);
  return { keep: reasons.length === 0, reasons };
}

/** The recorder's own preflight: the recipe's final-submit step(s) through the engine's real
 *  executeClick on a page-less guided-manual adapter. Null when every one is refused by the
 *  guided-manual final-submit rule and nothing was clicked; otherwise why not. */
async function finalSubmitPreflightProblem(steps: import("../shared/src/types").RecipeStep[]): Promise<{ problem: string | null; gates: string[] }> {
  const { RecipeAdapter, PAY_FEE_REPLAY_GATE } = await import("../portal-bot/src/adapters/recipeAdapter");
  const { preflightFinalSubmitSteps, describeGate } = await import("./demo-portal/gateProbe");
  const { demoPortalRecipe } = await import("./demo-portal/recipe");
  const recipe = { ...demoPortalRecipe("http://127.0.0.1:9"), steps };
  const res = await preflightFinalSubmitSteps(new RecipeAdapter(recipe, {}, {}, { autoSubmit: false }), steps, PAY_FEE_REPLAY_GATE);
  const gates = res.observations.map((o) => o.gate);
  if (res.clickAttempted) return { problem: "the engine attempted to click a final-submit step in guided-manual mode", gates };
  if (!res.observations.length) return { problem: "the recipe has no isFinalSubmit step for the engine to refuse", gates };
  const wrong = res.observations.filter((o) => o.gate !== "final-submit-guided-manual");
  if (wrong.length) return { problem: wrong.map((o) => `"${o.note.slice(0, 60)}": ${describeGate(o)}`).join("; "), gates };
  return { problem: null, gates };
}

async function selftest(): Promise<number> {
  const good: RecordingEvidence = {
    replayOk: true, finalSubmitClickedSources: [false, false, false], submitRequests: 0, nonGetRequests: 0,
    abortedRequests: 0, nodeNetworkAttempts: 0, reachedReviewUrl: true, finalSubmitGates: ["final-submit-guided-manual"],
  };
  const cases: Array<[string, Partial<RecordingEvidence>, boolean]> = [
    ["clean run is kept", {}, true],
    ["a stop by the FEE gate refuses (captions would lie)", { finalSubmitGates: ["fee-gate"] }, false],
    ["a final-submit step that never reached the click gate refuses", { finalSubmitGates: ["not-evaluated"] }, false],
    ["no final-submit gate evidence refuses", { finalSubmitGates: [] }, false],
    ["a submit POST refuses", { submitRequests: 1, nonGetRequests: 1 }, false],
    ["a submit GET to the endpoint refuses", { submitRequests: 1 }, false],
    ["finalSubmitClicked true refuses", { finalSubmitClickedSources: [false, true, false] }, false],
    ["finalSubmitClicked unknown refuses", { finalSubmitClickedSources: [false, undefined] }, false],
    ["no finalSubmitClicked evidence refuses", { finalSubmitClickedSources: [] }, false],
    ["a failed replay refuses", { replayOk: false }, false],
    ["not on the review page refuses", { reachedReviewUrl: false }, false],
    ["an aborted off-host request refuses", { abortedRequests: 1 }, false],
    ["a trapped Node network call refuses", { nodeNetworkAttempts: 1 }, false],
  ];
  let bad = 0;
  for (const [label, patch, want] of cases) {
    const got = recordingVerdict({ ...good, ...patch }).keep;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} - ${label} (keep=${got})`);
  }
  // The traps themselves, exercised for real: each must throw before any socket opens.
  const before = nodeNetworkAttempts.length;
  const probes: Array<[string, () => unknown]> = [
    ["http.request", () => http.request("http://example.invalid/")],
    ["https.get", () => https.get({ hostname: "example.invalid", path: "/" })],
    ["net.connect", () => net.connect(80, "example.invalid")],
    ["dns.lookup", () => dns.lookup("example.invalid", () => {})],
  ];
  for (const [label, fn] of probes) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) bad++;
    console.log(`  ${threw ? "ok  " : "FAIL"} - trap blocks ${label}`);
  }
  console.log(`  ${nodeNetworkAttempts.length - before === probes.length ? "ok  " : "FAIL"} - traps counted ${nodeNetworkAttempts.length - before}/${probes.length}`);
  if (nodeNetworkAttempts.length - before !== probes.length) bad++;
  nodeNetworkAttempts.splice(before);
  // Which gate the ENGINE uses on the recipe's final submit — the real executeClick, no browser.
  const { demoPortalRecipe } = await import("./demo-portal/recipe");
  const steps = demoPortalRecipe("http://127.0.0.1:9").steps;
  const current = await finalSubmitPreflightProblem(steps);
  const okCurrent = current.problem === null && current.gates.join() === "final-submit-guided-manual";
  if (!okCurrent) bad++;
  console.log(`  ${okCurrent ? "ok  " : "FAIL"} - the recipe's final submit is refused by the guided-manual final-submit rule (engine: ${current.gates.join(", ") || "none"}${current.problem ? `; ${current.problem}` : ""})`);
  // Discrimination: the recorder's own "submit/pay-like" wording must read as the FEE gate, or
  // the probe could not tell the two apart and the check above would prove nothing.
  const oldNote = steps.map((s) => s.isFinalSubmit ? { ...s, note: `BLOCKED — human clicked a submit/pay-like control ("Submit application") here; not replayable.` } : s);
  const old = await finalSubmitPreflightProblem(oldNote);
  const okOld = old.problem !== null && old.gates.join() === "fee-gate";
  if (!okOld) bad++;
  console.log(`  ${okOld ? "ok  " : "FAIL"} - the recorder's "submit/pay-like" wording is caught as the FEE gate and refused (engine: ${old.gates.join(", ") || "none"})`);
  console.log(bad ? `\n${bad} selftest check(s) FAILED` : "\nselftest passed");
  return bad ? 1 : 0;
}

// ── 3. Arguments ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const TERRENCE_BOYD = "0c435dcc-283d-4fb9-91ac-28c207815cd4";
// A fixture-only login for the fictional portal. It is not, and never was, a credential for
// anything: the portal accepts any non-empty pair. Deliberately NOT read from the
// credential store — this install has none, and a demo must not need one.
const FIXTURE_CREDENTIAL = { username: "demo.installer", password: "fictional-portal-only" };
// Mirrors portal-bot/src/browser.ts NAME_SHIM (not exported there). Without it, every
// function the engine serialises into page.evaluate throws under tsx and reads as "found
// nothing" — see memory note "Playwright evaluate needs the __name shim".
const NAME_SHIM = "globalThis.__name = globalThis.__name || function (fn) { return fn; };";

async function main(): Promise<number> {
  if (has("selftest")) return await selftest();

  const outArg = arg("out");
  if (!outArg || !/\.webm$/i.test(outArg)) {
    console.error("usage: demo-record-portal.ts --out <path.webm> [--project <id>] [--db <path>] [--shots <dir>] [--slowmo <ms>] [--headed]");
    return 2;
  }
  const out = path.resolve(outArg);
  const projectId = arg("project") || TERRENCE_BOYD;
  const shotsDir = arg("shots") ? path.resolve(String(arg("shots"))) : "";
  const slowMo = Math.max(0, Number(arg("slowmo") ?? 20));
  const headless = !has("headed");
  // Test-only: have the RECORDER (not the engine) click submit after the replay, to prove
  // the save gate refuses a recording that shows a submit. Never used for a real recording.
  const injectSubmit = has("inject-submit-click");

  // No LLM, whatever the shell carries: gap-fill is never enabled here, and this makes sure.
  for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|OPENAI|CLAUDE)_/i.test(k)) delete process.env[k];

  // ── 4. Refuse anything that is not a demo kit — READ-ONLY, before a byte is copied ─────
  // The database must be the current folder's own (<cwd>/backend/data/…): uploads are only
  // allowed from inside the current folder, so a database from elsewhere would bind documents
  // this run cannot attach — and "the kit" must mean one thing. It must hold ONLY the demo
  // company, and the project must be that company's, at the demo ZIP: a --project id copied
  // off a production board, or a production database passed with --db, is refused here, before
  // it is copied anywhere.
  const kitRoot = path.resolve(process.cwd());
  const srcDb = path.resolve(arg("db") || path.join("backend", "data", "autopilot.sqlite"));
  if (!fs.existsSync(srcDb)) { console.error(`No database at ${srcDb}. Run from a demo kit folder.`); return 2; }
  if (path.dirname(srcDb).toLowerCase() !== path.join(kitRoot, "backend", "data").toLowerCase()) {
    console.error(`[demo-record] REFUSED: the database (${srcDb}) must be this folder's own backend/data database — run from the demo kit folder.`);
    return 2;
  }
  {
    const { demoOnlyDatabaseProblem, demoProjectProblem } = await import("./demo-portal/guards");
    const Database = (await import("better-sqlite3")).default;
    const ro = new Database(srcDb, { readonly: true, fileMustExist: true });
    let problem: string | null = null;
    try {
      const view = { get: <T>(sql: string, params: unknown[] = []) => ro.prepare(sql).get(...(params as never[])) as T | undefined };
      problem = demoOnlyDatabaseProblem(view) ?? demoProjectProblem(view, projectId);
    } finally { ro.close(); }
    if (problem) { console.error(`[demo-record] REFUSED: ${problem}`); return 2; }
  }

  // ── 5. Copy the DB; open only the copy. Everything from here cleans up in `finally`. ────
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "demo-record-"));
  const cleanups: Array<() => Promise<unknown> | unknown> = [];
  try {
    return await recordInto(work, cleanups, { out, projectId, shotsDir, slowMo, headless, injectSubmit, srcDb, kitRoot });
  } finally {
    // Every exit path — a refusal, a thrown error, a kept or discarded video — lands here.
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp; best effort */ }
  }
}

interface RecordOptions {
  out: string; projectId: string; shotsDir: string; slowMo: number; headless: boolean;
  injectSubmit: boolean; srcDb: string; kitRoot: string;
}

async function recordInto(work: string, cleanups: Array<() => Promise<unknown> | unknown>, o: RecordOptions): Promise<number> {
  const { out, projectId, shotsDir, slowMo, headless, injectSubmit, srcDb, kitRoot } = o;
  const dbCopy = path.join(work, "autopilot.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(srcDb + suffix)) fs.copyFileSync(srcDb + suffix, dbCopy + suffix);
  }
  process.env.AUTOPILOT_DB_PATH = dbCopy;
  const engineShots = path.join(work, "engine-shots");
  process.env.REPLAY_RUN_DIR = engineShots;
  const videoTmp = path.join(work, "video");

  const { openDatabase } = await import("../backend/src/db");
  const { getProjectDetail } = await import("../backend/src/repository");
  const { resolveRecipeFieldValues } = await import("../backend/src/portalRecipes");
  const { clientStagingOverlay } = await import("../backend/src/clients");
  const { submissionDocumentsByType } = await import("../backend/src/submissionDocuments");
  const { RecipeAdapter } = await import("../portal-bot/src/adapters/recipeAdapter");
  const { performLogin } = await import("../portal-bot/src/adapters/loginFlow");
  const { chromium } = await import("playwright");
  const { startDemoPortal } = await import("./demo-portal/portal");
  const { demoPortalRecipe } = await import("./demo-portal/recipe");
  const { captionInitScript, FINAL_CAPTION, CAPTION_FOOTER } = await import("./demo-portal/captions");
  const { PAY_FEE_REPLAY_GATE } = await import("../portal-bot/src/adapters/recipeAdapter");
  const { probeClickGates, describeGate } = await import("./demo-portal/gateProbe");

  // PREFLIGHT, before the portal or a browser exists: the recipe's final-submit step through
  // the engine's real executeClick. A recipe the FEE gate (or anything but the guided-manual
  // final-submit rule) would stop cannot produce the video the captions describe.
  {
    const pre = await finalSubmitPreflightProblem(demoPortalRecipe("http://127.0.0.1:9").steps);
    if (pre.problem) { console.error(`[demo-record] REFUSED before recording: ${pre.problem}`); return 2; }
    console.log(`[demo-record] preflight: the engine refuses the final submit by ${pre.gates.join(", ")}`);
  }

  const db = await openDatabase();
  cleanups.push(() => db.close());
  if (path.resolve(String(process.env.AUTOPILOT_DB_PATH)) !== dbCopy) { console.error("DB path changed under us; refusing."); return 2; }

  // ── 5. The project, its bindings and its documents — the staging path's own calls ──
  const detail = getProjectDetail(db, projectId);
  // A UTILITY track, like the NEM staging path (prepareSubmission passes the portal type).
  const overlay = clientStagingOverlay(db, detail.project.clientId, "utility");
  const stagedProject = Object.keys(overlay).length > 0
    ? { ...detail.project, parserSnapshot: { ...detail.project.parserSnapshot, ...overlay } }
    : detail.project;
  const fieldValues = resolveRecipeFieldValues(db, stagedProject, "utility");
  const docsByType = submissionDocumentsByType(db, stagedProject);
  const boundCount = Object.values(fieldValues).filter((v) => String(v ?? "").trim()).length;
  console.log(`[demo-record] project ${projectId}: ${boundCount} non-empty bindings of ${Object.keys(fieldValues).length}; ${Object.keys(docsByType).length} document type(s)`);

  const attached: Array<{ docType: string; file: string }> = [];
  const beforeUpload = (docType: string, file: string): void => {
    const abs = path.resolve(file);
    if (!abs.toLowerCase().startsWith(kitRoot.toLowerCase() + path.sep)) {
      throw new Error(`refusing to attach ${docType}: ${path.basename(abs)} is outside the kit folder`);
    }
    if (!fs.existsSync(abs)) throw new Error(`refusing to attach ${docType}: file missing`);
    attached.push({ docType, file: abs });
  };

  // ── 6. Portal + browser ───────────────────────────────────────────────────────────
  const portal = await startDemoPortal();
  let portalOpen = true;
  const closePortal = async (): Promise<void> => { if (portalOpen) { portalOpen = false; await portal.close(); } };
  cleanups.push(closePortal);
  // The test-only submit click may only ever land on this process's own loopback fixture.
  if (injectSubmit && !/^http:\/\/127\.0\.0\.1:\d+$/.test(portal.baseUrl)) {
    throw new Error("--inject-submit-click refused: the portal is not the local fixture");
  }
  const recipe = demoPortalRecipe(portal.baseUrl);

  const browser = await chromium.launch({
    headless,
    slowMo,
    // Belt and braces for "nothing leaves": the page's requests are routed below; anything
    // the browser does outside a page is pointed at a closed loopback port.
    proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1,localhost" },
    args: [
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=TranslateUI,AutofillAddressProfileSavePrompt,AutofillServerCommunication,OptimizationHints,MediaRouter",
      "--disable-save-password-bubble",
      "--no-default-browser-check",
      "--no-first-run",
    ],
  });
  let browserOpen = true;
  const closeBrowser = async (): Promise<void> => { if (browserOpen) { browserOpen = false; await browser.close(); } };
  cleanups.push(closeBrowser);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: videoTmp, size: { width: 1440, height: 900 } },
  });
  let contextOpen = true;
  const closeContext = async (): Promise<void> => { if (contextOpen) { contextOpen = false; await context.close(); } };
  cleanups.push(closeContext);
  const routeCounters = await installLoopbackOnlyRoute(context);
  await context.addInitScript({ content: NAME_SHIM });
  await context.addInitScript({ content: captionInitScript() });
  const page = await context.newPage();

  const shots: string[] = [];
  const shot = async (name: string): Promise<void> => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    const p = path.join(shotsDir, name);
    await page.screenshot({ path: p }).catch(() => {});
    shots.push(p);
  };
  const hold = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const caption = (headline: string, sub: string, now = "", tone = "normal") =>
    page.evaluate(([h, s, n, t]) => (window as unknown as { __demoCaption?: { set: (...a: string[]) => void } }).__demoCaption?.set(h, s, n, t), [headline, sub, now, tone]).catch(() => {});

  const t0 = Date.now();
  let loginResult: { ok: boolean; status: string; message: string } = { ok: false, status: "error", message: "not run" };
  let fillResult: { ok: boolean; message?: string; data?: Record<string, unknown> } = { ok: false, message: "not run" };
  let reviewResult: { ok: boolean; message?: string; data?: Record<string, unknown> } = { ok: false, message: "not run" };
  let adapterFlag: boolean | undefined;
  let reviewRows: Array<{ label: string; value: string }> = [];
  let finalUrl = "";
  let runError = "";
  let gateObservations: import("./demo-portal/gateProbe").ClickGateObservation[] = [];
  try {
    // Title card.
    await page.goto(`${portal.baseUrl}/intro`);
    await hold(4500);
    await shot("01-intro.png");

    // What RecipeAdapter.login() does once its browser is open: go to the portal URL and
    // run the shared login flow.
    await page.goto(recipe.portalUrl);
    await hold(1200);
    loginResult = await performLogin(page, FIXTURE_CREDENTIAL);
    console.log(`[demo-record] login: ${loginResult.status} — ${loginResult.message}`);
    if (!loginResult.ok) throw new Error(`login did not succeed: ${loginResult.status}`);

    // The rest of runAdapter's sequence, on the adapter the staging path would build.
    const adapter = new RecipeAdapter(recipe, fieldValues, docsByType, { autoSubmit: false, beforeUpload });
    (adapter as unknown as { page: unknown }).page = page;
    // Watch which click gate the engine answers each click with (see gateProbe.ts).
    const gates = probeClickGates(adapter, PAY_FEE_REPLAY_GATE);
    cleanups.push(() => gates.restore());
    gateObservations = gates.observations;
    try {
      const openResult = await adapter.openSubmission(stagedProject);
      fillResult = openResult.ok ? await adapter.fillApplication(stagedProject) : openResult;
      await adapter.uploadFiles(stagedProject, []);
      reviewResult = await adapter.stopAtReview();
    } finally {
      gates.restore();
    }
    adapterFlag = adapter.finalSubmitClicked;
    finalUrl = page.url();

    // Independent read-back: what the portal's own review page now shows.
    reviewRows = await page.$$eval("table.summary tr", (trs) => trs
      .map((tr) => ({ label: (tr.querySelector("th")?.textContent || "").trim(), value: (tr.querySelector("td")?.textContent || "").trim() }))
      .filter((r) => r.value !== "" || r.label === "")).catch(() => []);

    if (injectSubmit) {
      // TEST ONLY — the recorder clicks, to prove the gate below refuses the video.
      await page.locator("#submitApplication").click().catch(() => {});
      await hold(1500);
    } else {
      await caption("The engine has stopped. The rest is a person's job.", FINAL_CAPTION, "✔ Submit application: NOT clicked — left for a person", "final");
      await page.evaluate(() => {
        const b = document.getElementById("submitApplication");
        if (!b) return;
        b.style.outline = "4px dashed #c62828";
        b.style.outlineOffset = "6px";
        const tag = document.createElement("span");
        tag.textContent = "A person clicks this. The automation cannot.";
        tag.style.cssText = "align-self:center;font-weight:700;color:#c62828;margin-right:18px;font-size:15px;";
        b.parentElement?.insertBefore(tag, b);
        b.scrollIntoView({ block: "center" });
      }).catch(() => {});
      await hold(1200);
      await shot("99-stopped-at-review.png");
      await hold(6500);
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    console.error(`[demo-record] run error: ${runError}`);
  }
  const wallMs = Date.now() - t0;
  const video = page.video();
  await closeContext(); // finalises the .webm
  await closeBrowser();
  await closePortal();

  // ── 7. The gate ──────────────────────────────────────────────────────────────────
  // The ENGINE's own answer on the final-submit step(s), as observed during this run.
  const finalSubmitObs = gateObservations.filter((g) => g.isFinalSubmit);
  for (const g of finalSubmitObs) console.log(`[demo-record] final submit "${g.note.slice(0, 50)}": ${describeGate(g)}`);
  if (!finalSubmitObs.length) console.log("[demo-record] final submit: the step never reached the engine's click gate");
  const evidence: RecordingEvidence = {
    finalSubmitGates: finalSubmitObs.length ? finalSubmitObs.map((g) => g.gate) : ["not-evaluated"],
    replayOk: !runError && loginResult.ok && fillResult.ok === true && reviewResult.ok === true,
    finalSubmitClickedSources: [
      adapterFlag,
      reviewResult.data?.finalSubmitClicked as boolean | undefined,
      // runAdapter's own derivation, reproduced: a clicked allowlisted submit shows up here.
      (reviewResult.ok && reviewResult.data?.finalSubmitClicked === true) || adapterFlag === true ? true : false,
    ],
    submitRequests: portal.submitPosts().length,
    nonGetRequests: portal.nonGetRequests().length,
    abortedRequests: routeCounters.aborted,
    nodeNetworkAttempts: nodeNetworkAttempts.length,
    reachedReviewUrl: /\/apply\/review$/.test(finalUrl),
  };
  const verdict = recordingVerdict(evidence);

  let savedBytes = 0;
  const rawVideo = video ? await video.path().catch(() => "") : "";
  if (verdict.keep && rawVideo && fs.existsSync(rawVideo)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(rawVideo, out);
    savedBytes = fs.statSync(out).size;
  }

  // Engine page shots → the shots folder, named for a reader.
  if (shotsDir && fs.existsSync(engineShots)) {
    const runDirs = fs.readdirSync(engineShots).map((d) => path.join(engineShots, d)).filter((d) => fs.statSync(d).isDirectory());
    let n = 2;
    for (const dir of runDirs) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".png")).sort()) {
        const dest = path.join(shotsDir, `${String(n).padStart(2, "0")}-engine-${f.replace(/^p\d+-/, "")}`);
        fs.copyFileSync(path.join(dir, f), dest);
        shots.push(dest);
        n++;
      }
    }
  }

  const data = fillResult.data ?? {};
  const list = (k: string): string[] => (Array.isArray(data[k]) ? (data[k] as unknown[]).map(String) : []);
  const LEARN_LITERAL = /LEARN-TIME|learn-time@|Learntown|1 Learn-Time/i;
  const report = {
    kept: verdict.keep,
    refusedBecause: verdict.reasons,
    out: verdict.keep ? out : null,
    videoBytes: savedBytes,
    wallSeconds: Math.round(wallMs / 100) / 10,
    resolution: "1440x900",
    slowMo,
    headless,
    login: `${loginResult.status}`,
    replayOk: fillResult.ok,
    replayMessage: String(fillResult.message ?? "").slice(0, 600),
    stopAtReview: String(reviewResult.message ?? "").slice(0, 300),
    stepsInRecipe: recipe.steps.length,
    executed: data.executed,
    skipped: list("skipped"),
    fieldsVerified: list("fieldsVerified").length,
    fieldsUnverified: list("fieldsUnverified"),
    requiredFieldsSeen: list("requiredFieldsSeen").length,
    requiredStillEmpty: list("requiredStillEmpty"),
    unresolvedFields: list("unresolvedFields"),
    driftWarnings: list("driftWarnings"),
    agingNotes: list("agingNotes"),
    attached: attached.map((a) => `${a.docType}: ${path.basename(a.file)}`),
    reviewPageRows: reviewRows.filter((r) => r.label).length,
    reviewPageMissing: reviewRows.filter((r) => /missing/i.test(r.value)).map((r) => r.label),
    reviewPageLearnLiterals: reviewRows.filter((r) => LEARN_LITERAL.test(r.value)).map((r) => r.label),
    finalSubmitClickedSources: evidence.finalSubmitClickedSources,
    finalSubmitStoppedBy: finalSubmitObs.map((g) => ({ gate: g.gate, reason: describeGate(g), feeGateMatched: g.feeGateMatched, autoSubmitConsulted: g.autoSubmitConsulted })),
    clickGateObservations: gateObservations.map((g) => `${g.gate}: ${g.note.slice(0, 50)}`),
    fixtureRequests: portal.log.length,
    fixtureSubmitRequests: evidence.submitRequests,
    fixtureNonGetRequests: evidence.nonGetRequests,
    browserLoopbackRequests: routeCounters.loopback,
    browserAbortedRequests: routeCounters.aborted,
    browserAbortedHosts: [...new Set(routeCounters.abortedHosts)],
    nodeNetworkAttempts,
    finalUrlPath: finalUrl ? new URL(finalUrl).pathname : "",
    shots,
    footer: CAPTION_FOOTER,
    runError,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!verdict.keep) {
    console.error(`[demo-record] VIDEO NOT SAVED: ${verdict.reasons.join("; ")}`);
  } else {
    console.log(`[demo-record] saved ${out} (${savedBytes} bytes)`);
  }
  // The DB copy, the temp video and the engine shots are removed by main()'s finally.
  return verdict.keep ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
