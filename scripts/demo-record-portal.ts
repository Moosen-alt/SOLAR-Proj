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
//     REFUSED — by any of the engine's click gates — and never clicked. Which gate answered
//     (the fee gate, the submit-keyword / page-aware block, the shared final-submit gate) is
//     observed (scripts/demo-portal/gateProbe.ts) and REPORTED, never required by name: the
//     engine's gate order has changed under this recorder before, and every refusal is the
//     safe outcome. During the run the same probe watches the real adapter; a clicked, thrown
//     or never-evaluated flagged step refuses the video (scripts/lib/realRunGuard.ts).
//   · The database is COPIED to a temp dir and the copy is opened (openDatabase migrates,
//     which is a write). The source — normally the demo kit's DB — is only ever read. The temp
//     dir (DB copy, raw video, engine shots) is removed in a finally on every exit path.
//   · Node-side network traps: fetch, http/https request/get, net/tls connect and
//     dns.lookup throw on any non-loopback host, and are counted.
//   · Browser-side: every non-loopback request is aborted by a context route and counted;
//     the browser's proxy is a dead loopback port so traffic outside the page (if any)
//     cannot leave either.
//   · The video is written to a temp dir and moved to --out ONLY when: the replay reached
//     review (ok), the engine REFUSED the final submit by one of its click gates
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
//     [--mask]              also mask the project's values on screen (the real-run look, on the
//                           fictional portal; scripts/lib/piiMask.ts)
//   npx tsx scripts/demo-record-portal.ts --selftest   # the save-gate predicate, no browser
//
// REAL RUN (a real, UNFILED project on a real portal, a person present, supervised):
//   npx tsx scripts/demo-record-portal.ts --real-run --i-am-present --headed \
//       --db <copy of the production DB> --project <id> --out real-run.webm [--shots <dir>]
//       [--recipe <id>]             default: the project's complete UTILITY-track recipe
//                                   (findCompleteRecipeForProject — track-scoped, hard rule 5)
//       [--mask-values-from <id>]   default: --project. Values are counted, never printed
//       [--mask-selectors a,b,c]    extra CSS regions to box (the account header, a list)
//       [--login-wait <s>]          default 300: how long to wait for the person to finish
//                                   login / MFA in the browser before giving up
//   What changes in a real run, and only there (scripts/lib/realRunGuard.ts is the gate):
//     · REFUSED unless --i-am-present, --headed, masking on, PORTAL_ALLOW_FINAL_SUBMIT unset
//       (not "0" — unset), no run approval anywhere, and the recipe's shape valid;
//     · the demo-only database guards are skipped (it IS a real project); the DB is still
//       copied and only the copy is opened;
//     · the Node-side traps and the browser route allow the recipe's own host(s), and nothing
//       else Node-side; the browser may load a portal's CDN assets, every host is listed in the
//       report; a browser POST whose URL reads as a filing or a payment
//       (isSubmitOrPayRequestUrl) is ABORTED and counted — the video is refused if any occurred;
//     · MASKING IS ON: every known value of the project and its credential's user name is
//       boxed on screen at record time (rendering only — the portal's state is what the bot
//       filled; scripts/lib/piiMask.ts, proven on the replica by
//       scripts/demoMaskReplica.dom.smoke.ts). A person still reviews every frame before use;
//     · login: the stored credential is used when there is one; MFA / a missing credential
//       hands the browser to the person present and waits (--login-wait);
//     · the video is kept only if the engine stopped at the review screen with the flagged
//       final-submit step either refused by a click gate or skipped for want of a
//       target (the recorder's shape: selector {} + optional), finalSubmitClicked false from
//       every source, and zero submit/pay POSTs. The draft the portal autosaved is the
//       operator's to delete afterwards.
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
// Pure (no network, no browser): the one question asked of the flagged final step.
import { REFUSAL_GATES, flaggedFinalStepOutcome } from "./lib/realRunGuard";

// ── 1. Network traps, before anything else is imported ─────────────────────────────────
const nodeNetworkAttempts: string[] = [];
// Hosts a REAL RUN may reach from Node (the recipe's own, added only after the real-run guard
// has passed with the recipe read). Empty for the fictional recording: loopback only.
const allowedHosts = new Set<string>();
const hostAllowed = (h: string | undefined | null): boolean => isLoopbackHost(h) || allowedHosts.has(String(h ?? "").trim().toLowerCase());
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
    if (!hostAllowed(h)) refuse(`${scheme}.request`, h);
    return (origRequest as (...a: unknown[]) => unknown)(...args);
  };
  (mod as { get: unknown }).get = (...args: unknown[]) => {
    const h = hostOfRequestArgs(args);
    if (!hostAllowed(h)) refuse(`${scheme}.get`, h);
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
      if (!hostAllowed(host)) refuse(`${name}.${fn}`, host);
      return orig.apply(mod, args);
    };
  }
}
{
  const origLookup = dns.lookup.bind(dns);
  (dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
    if (!hostAllowed(host)) refuse("dns.lookup", host);
    return (origLookup as (...a: unknown[]) => unknown)(host, ...rest);
  };
  const origP = dns.promises.lookup.bind(dns.promises);
  (dns.promises as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
    if (!hostAllowed(host)) refuse("dns.promises.lookup", host);
    return (origP as (...a: unknown[]) => unknown)(host, ...rest);
  };
}
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let h = "";
    try { h = new URL(u).hostname; } catch { h = u; }
    if (!hostAllowed(h)) refuse("fetch", h);
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
   *  never reached executeClick. ONE question is asked of it: was the flagged step refused, by
   *  ANY gate, and never clicked? Every refusal path is the expected safe outcome and is
   *  reported by name (scripts/lib/realRunGuard.ts REFUSAL_GATES); "clicked", "threw",
   *  "not-evaluated" (with a target) and no evidence at all refuse the video. */
  finalSubmitGates: string[];
  /** "fictional" (default): the Act 4 recording on the demo portal. "real": a supervised real
   *  portal run, where the three fields below carry the evidence the fixture server gave. */
  mode?: "fictional" | "real";
  /** real: the recipe's flagged final-submit step has NO selector (the recorder writes
   *  `selector: {}` + optional), so the engine skipped it for want of a target and the click
   *  gate was never consulted. "not-evaluated" is acceptable ONLY together with this. */
  finalSubmitStepHasNoTarget?: boolean;
  /** real: browser POSTs whose URL reads as a filing or a payment (isSubmitOrPayRequestUrl),
   *  aborted at the route and counted. Must be 0. */
  submitOrPayRequests?: number;
}
export function recordingVerdict(e: RecordingEvidence): { keep: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const real = e.mode === "real";
  if (!e.replayOk) reasons.push("the replay did not complete cleanly to the review screen");
  if (!e.reachedReviewUrl) reasons.push(real ? "the page does not name itself the review step" : "the browser is not on the review page");
  // ONE question: was the flagged final step refused, by any gate, and never clicked?
  const refused = e.finalSubmitGates.length > 0 && e.finalSubmitGates.every((g) => REFUSAL_GATES.has(g));
  // real: the recorder-shaped step (no selector, optional) is skipped by the engine before any
  // gate — accepted only when that is what the recipe holds; a step WITH a target that never
  // reached the gate is a step that was not refused.
  const skippedNoTarget = real && e.finalSubmitStepHasNoTarget === true && e.finalSubmitGates.length === 1 && e.finalSubmitGates[0] === "not-evaluated";
  if (!refused && !skippedNoTarget) {
    reasons.push(real
      ? `the final-submit step was neither refused by a click gate nor skipped for want of a target (engine answered: ${JSON.stringify(e.finalSubmitGates)}; step has no target: ${e.finalSubmitStepHasNoTarget === true})`
      : `the final-submit step was not refused by the engine's click gates (engine answered: ${JSON.stringify(e.finalSubmitGates)})`);
  }
  // Unknown is not reassurance: every source must say false explicitly.
  if (e.finalSubmitClickedSources.length === 0 || e.finalSubmitClickedSources.some((v) => v !== false)) {
    reasons.push(`finalSubmitClicked was not false from every source (${JSON.stringify(e.finalSubmitClickedSources)})`);
  }
  if (real) {
    if (e.submitOrPayRequests === undefined) reasons.push("the submit/pay request count is unknown");
    else if (e.submitOrPayRequests > 0) reasons.push(`${e.submitOrPayRequests} browser POST(s) to a submit/pay-looking URL were attempted (aborted)`);
  } else {
    if (e.submitRequests > 0) reasons.push(`the fixture server received ${e.submitRequests} submit request(s)`);
    if (e.nonGetRequests > 0) reasons.push(`the fixture server received ${e.nonGetRequests} non-GET request(s)`);
  }
  if (e.abortedRequests > 0) reasons.push(`${e.abortedRequests} non-loopback browser request(s) were attempted (aborted)`);
  if (e.nodeNetworkAttempts > 0) reasons.push(`${e.nodeNetworkAttempts} Node network attempt(s) outside the allowed hosts were trapped`);
  return { keep: reasons.length === 0, reasons };
}

/** The recorder's own preflight: the recipe's final-submit step(s) through the engine's real
 *  executeClick on a page-less guided-manual adapter. ONE question: was every flagged step
 *  refused, by any gate, and never clicked? `problem` is null when so; `gates` names the gate(s)
 *  that answered, and `reasons` carries the engine's own words for a refusal in the flagged
 *  branch (its "final submit NOT clicked — …" drift warning), so the report says WHY, not
 *  only that. Nothing here requires one gate by name: the engine's gate order has changed
 *  under this recorder before, and every refusal is the safe outcome. */
async function finalSubmitPreflightProblem(steps: import("../shared/src/types").RecipeStep[]): Promise<{ problem: string | null; gates: string[]; reasons: string[] }> {
  const { RecipeAdapter, PAY_FEE_REPLAY_GATE } = await import("../portal-bot/src/adapters/recipeAdapter");
  const { preflightFinalSubmitSteps } = await import("./demo-portal/gateProbe");
  const { demoPortalRecipe } = await import("./demo-portal/recipe");
  const recipe = { ...demoPortalRecipe("http://127.0.0.1:9"), steps };
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
  const res = await preflightFinalSubmitSteps(adapter, steps, PAY_FEE_REPLAY_GATE);
  const outcome = flaggedFinalStepOutcome(res.observations, res.clickAttempted);
  const warnings = (adapter as unknown as { driftWarnings?: unknown }).driftWarnings;
  const reasons = Array.isArray(warnings) ? warnings.map(String).filter((w) => /final submit NOT clicked/i.test(w)) : [];
  return { problem: outcome.problem, gates: outcome.gates, reasons };
}

async function selftest(): Promise<number> {
  const good: RecordingEvidence = {
    replayOk: true, finalSubmitClickedSources: [false, false, false], submitRequests: 0, nonGetRequests: 0,
    abortedRequests: 0, nodeNetworkAttempts: 0, reachedReviewUrl: true, finalSubmitGates: ["final-submit-guided-manual"],
  };
  const cases: Array<[string, Partial<RecordingEvidence>, boolean]> = [
    ["clean run is kept", {}, true],
    // ONE question: refused by ANY gate and never clicked. Every refusal path is kept (and reported).
    ["MUST-PASS: a stop by the FEE gate is a refusal — kept", { finalSubmitGates: ["fee-gate"] }, true],
    ["MUST-PASS: a stop by the page-aware / submit-keyword / shared final-submit gate ('other-refusal') is a refusal — kept", { finalSubmitGates: ["other-refusal"] }, true],
    ["MUST-EXCLUDE: a flagged step the engine CLICKED refuses", { finalSubmitGates: ["clicked"] }, false],
    ["MUST-EXCLUDE: a flagged step whose click THREW (may have reached the portal) refuses", { finalSubmitGates: ["threw"] }, false],
    ["MUST-EXCLUDE: two flagged steps, one refused and one clicked, refuse", { finalSubmitGates: ["other-refusal", "clicked"] }, false],
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
    // REAL RUN: the recorder-shaped final submit (no target) is skipped, not refused.
    ["real: guided-manual refusal is kept", { mode: "real", submitOrPayRequests: 0 }, true],
    ["real: a flagged step with NO target, skipped (not-evaluated), is kept", { mode: "real", finalSubmitGates: ["not-evaluated"], finalSubmitStepHasNoTarget: true, submitOrPayRequests: 0 }, true],
    ["real MUST-EXCLUDE: not-evaluated with a step that HAS a target refuses", { mode: "real", finalSubmitGates: ["not-evaluated"], finalSubmitStepHasNoTarget: false, submitOrPayRequests: 0 }, false],
    ["real MUST-PASS: a stop by the FEE gate or another click gate is a refusal — kept", { mode: "real", finalSubmitGates: ["fee-gate", "other-refusal"], submitOrPayRequests: 0 }, true],
    ["real MUST-EXCLUDE: a clicked flagged step refuses", { mode: "real", finalSubmitGates: ["clicked"], submitOrPayRequests: 0 }, false],
    ["real MUST-EXCLUDE: one submit/pay POST refuses", { mode: "real", submitOrPayRequests: 1 }, false],
    ["real MUST-EXCLUDE: an unknown submit/pay count refuses", { mode: "real" }, false],
    ["real MUST-EXCLUDE: finalSubmitClicked unknown refuses", { mode: "real", submitOrPayRequests: 0, finalSubmitClickedSources: [false, undefined] }, false],
    ["real MUST-EXCLUDE: not on a review page refuses", { mode: "real", submitOrPayRequests: 0, reachedReviewUrl: false }, false],
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
  // The ENGINE's real executeClick on the recipe's final submit, no browser: refused by SOME
  // gate, never clicked — which gate is reported, not required.
  const { demoPortalRecipe } = await import("./demo-portal/recipe");
  const steps = demoPortalRecipe("http://127.0.0.1:9").steps;
  const current = await finalSubmitPreflightProblem(steps);
  const okCurrent = current.problem === null && current.gates.length === 1 && REFUSAL_GATES.has(current.gates[0]);
  if (!okCurrent) bad++;
  console.log(`  ${okCurrent ? "ok  " : "FAIL"} - the recipe's flagged final submit is refused and never clicked (engine: ${current.gates.join(", ") || "none"}${current.reasons.length ? `; ${current.reasons.join(" | ").slice(0, 200)}` : ""}${current.problem ? `; ${current.problem}` : ""})`);
  // MUST-EXCLUDE, on the pure decision: a flagged step that a gate did NOT refuse is a problem.
  const clicked = flaggedFinalStepOutcome([{ gate: "clicked", note: "x" }], false);
  const attempted = flaggedFinalStepOutcome([{ gate: "other-refusal", note: "x" }], true);
  const none = flaggedFinalStepOutcome([], false);
  const okExclude = !clicked.refused && !attempted.refused && !none.refused && flaggedFinalStepOutcome([{ gate: "other-refusal" }], false).refused && flaggedFinalStepOutcome([{ gate: "fee-gate" }], false).refused;
  if (!okExclude) bad++;
  console.log(`  ${okExclude ? "ok  " : "FAIL"} - MUST-EXCLUDE: a clicked / attempted / absent flagged step is not a refusal; fee-gate and other-refusal are`);
  // Discrimination: the recorder's own "submit/pay-like" wording must read as the FEE gate, or
  // the probe could not tell gates apart and the gate it reports would be a guess. (Still a
  // refusal: the video would be kept, with "fee-gate" in its report.)
  const oldNote = steps.map((s) => s.isFinalSubmit ? { ...s, note: `BLOCKED — human clicked a submit/pay-like control ("Submit application") here; not replayable.` } : s);
  const old = await finalSubmitPreflightProblem(oldNote);
  const okOld = old.problem === null && old.gates.join() === "fee-gate";
  if (!okOld) bad++;
  console.log(`  ${okOld ? "ok  " : "FAIL"} - the probe DISCRIMINATES: the "submit/pay-like" wording is attributed to the FEE gate (engine: ${old.gates.join(", ") || "none"})`);
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
    console.error("usage: demo-record-portal.ts --out <path.webm> [--project <id>] [--db <path>] [--shots <dir>] [--slowmo <ms>] [--headed] [--mask]\n" +
      "       demo-record-portal.ts --real-run --i-am-present --headed --db <copy> --project <id> --out <path.webm> [--recipe <id>] [--mask-values-from <id>] [--mask-selectors a,b] [--login-wait <s>]");
    return 2;
  }
  const out = path.resolve(outArg);
  const realRun = has("real-run");
  const projectId = arg("project") || (realRun ? "" : TERRENCE_BOYD);
  const shotsDir = arg("shots") ? path.resolve(String(arg("shots"))) : "";
  const slowMo = Math.max(0, Number(arg("slowmo") ?? 20));
  const headless = !has("headed");
  // Masking: ON for anything but the fictional portal; on the fictional portal only with --mask.
  const maskOn = realRun ? !has("no-mask") : has("mask") && !has("no-mask");
  const maskValuesFrom = arg("mask-values-from") || projectId;
  const maskSelectors = String(arg("mask-selectors") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const loginWaitS = Math.max(10, Number(arg("login-wait") ?? 300));
  const recipeId = arg("recipe") || "";
  // Test-only: have the RECORDER (not the engine) click submit after the replay, to prove
  // the save gate refuses a recording that shows a submit. Never used for a real recording.
  const injectSubmit = has("inject-submit-click") && !realRun;

  // ── 3b. THE REAL-RUN GUARD, phase 1 — before any database is looked for. ─────────────
  {
    const { realRunRefusals } = await import("./lib/realRunGuard");
    const refusals = realRunRefusals({ realRun, iAmPresent: has("i-am-present"), env: process.env, runApproval: null, headed: !headless, maskOn });
    if (refusals.length) { for (const r of refusals) console.error(`[demo-record] REFUSED: ${r}`); return 2; }
    if (realRun && !projectId) { console.error("[demo-record] REFUSED: --real-run needs --project <id>"); return 2; }
  }

  // No LLM, whatever the shell carries: gap-fill is never enabled here, and this makes sure.
  for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|OPENAI|CLAUDE)_/i.test(k)) delete process.env[k];

  // ── 4. Refuse anything that is not a demo kit — READ-ONLY, before a byte is copied ─────
  // The database must be the current folder's own (<cwd>/backend/data/…): uploads are only
  // allowed from inside the current folder, so a database from elsewhere would bind documents
  // this run cannot attach — and "the kit" must mean one thing. It must hold ONLY the demo
  // company, and the project must be that company's, at the demo ZIP: a --project id copied
  // off a production board, or a production database passed with --db, is refused here, before
  // it is copied anywhere.
  // A REAL RUN is the one case where the database is a real one (a copy of production, passed
  // with --db) — the guard above has already required a person present; these demo-only checks
  // are skipped, and the copy-then-open discipline below still holds.
  const kitRoot = path.resolve(process.cwd());
  const srcDb = path.resolve(arg("db") || path.join("backend", "data", "autopilot.sqlite"));
  if (!fs.existsSync(srcDb)) { console.error(`No database at ${srcDb}. ${realRun ? "Pass --db <a copy of the production database>." : "Run from a demo kit folder."}`); return 2; }
  if (!realRun) {
    if (path.dirname(srcDb).toLowerCase() !== path.join(kitRoot, "backend", "data").toLowerCase()) {
      console.error(`[demo-record] REFUSED: the database (${srcDb}) must be this folder's own backend/data database — run from the demo kit folder.`);
      return 2;
    }
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
    return await recordInto(work, cleanups, {
      out, projectId, shotsDir, slowMo, headless, injectSubmit, srcDb, kitRoot,
      realRun, maskOn, maskValuesFrom, maskSelectors, loginWaitS, recipeId,
    });
  } finally {
    // Every exit path — a refusal, a thrown error, a kept or discarded video — lands here.
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp; best effort */ }
  }
}

interface RecordOptions {
  out: string; projectId: string; shotsDir: string; slowMo: number; headless: boolean;
  injectSubmit: boolean; srcDb: string; kitRoot: string;
  realRun: boolean; maskOn: boolean; maskValuesFrom: string; maskSelectors: string[]; loginWaitS: number; recipeId: string;
}

async function recordInto(work: string, cleanups: Array<() => Promise<unknown> | unknown>, o: RecordOptions): Promise<number> {
  const { out, projectId, shotsDir, slowMo, headless, injectSubmit, srcDb, kitRoot, realRun, maskOn } = o;
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
  const { resolveRecipeFieldValues, findCompleteRecipeForProject, getPortalRecipe } = await import("../backend/src/portalRecipes");
  const { clientStagingOverlay } = await import("../backend/src/clients");
  const { submissionDocumentsByType } = await import("../backend/src/submissionDocuments");
  const { getDecryptedCredentialByUrl } = await import("../backend/src/portalCredentials");
  const { RecipeAdapter } = await import("../portal-bot/src/adapters/recipeAdapter");
  const { performLogin } = await import("../portal-bot/src/adapters/loginFlow");
  const { chromium } = await import("playwright");
  const { startDemoPortal } = await import("./demo-portal/portal");
  const { demoPortalRecipe } = await import("./demo-portal/recipe");
  const { captionInitScript, FINAL_CAPTION, CAPTION_FOOTER } = await import("./demo-portal/captions");
  const { PAY_FEE_REPLAY_GATE } = await import("../portal-bot/src/adapters/recipeAdapter");
  const { probeClickGates, describeGate } = await import("./demo-portal/gateProbe");
  const { piiMaskInitScript, piiMaskShapesFor, piiMaskValues } = await import("./lib/piiMask");
  const { realRunRefusals, recipeTargetHosts } = await import("./lib/realRunGuard");
  const { isSubmitOrPayRequestUrl, isReviewPageText } = await import("../shared/src/portalSafety");

  // PREFLIGHT, before the portal or a browser exists: the recipe's final-submit step through
  // the engine's real executeClick. ONE question — refused by some gate, never clicked? — and
  // the gate that answered is reported. A flagged step no gate refuses cannot be recorded.
  // (Fictional only: a real recipe's flagged step is the recorder's shape — no selector — and
  // the real-run verdict accepts "skipped for want of a target" for exactly that step.)
  if (!realRun) {
    const pre = await finalSubmitPreflightProblem(demoPortalRecipe("http://127.0.0.1:9").steps);
    if (pre.problem) { console.error(`[demo-record] REFUSED before recording: ${pre.problem}`); return 2; }
    console.log(`[demo-record] preflight: the engine refuses the final submit by ${pre.gates.join(", ")}${pre.reasons.length ? ` (${pre.reasons.join(" | ").slice(0, 200)})` : ""}`);
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
    // Fictional: only the kit's own files. Real: the project's documents live where the
    // database says (PROJECT_DOCS_DIR); they must exist, and nothing else is attached.
    if (!realRun && !abs.toLowerCase().startsWith(kitRoot.toLowerCase() + path.sep)) {
      throw new Error(`refusing to attach ${docType}: ${path.basename(abs)} is outside the kit folder`);
    }
    if (!fs.existsSync(abs)) throw new Error(`refusing to attach ${docType}: file missing`);
    attached.push({ docType, file: abs });
  };

  // ── 6. The recipe and the portal ────────────────────────────────────────────────────
  let portal: Awaited<ReturnType<typeof startDemoPortal>> | null = null;
  let portalOpen = false;
  const closePortal = async (): Promise<void> => { if (portal && portalOpen) { portalOpen = false; await portal.close(); } };
  let recipe: import("../shared/src/types").PortalRecipe;
  let credential: { username: string; password: string } | null = null;
  let realHosts: string[] = [];
  if (realRun) {
    // The TRACK-SCOPED lookup (hard rule 5): a utility recipe for the project's utility. A
    // permit recipe can never be launched from here.
    const found = o.recipeId
      ? getPortalRecipe(db, o.recipeId)
      : findCompleteRecipeForProject(db, { scopeType: "utility", state: detail.project.state, utility: detail.project.utility });
    if (!found) { console.error(`[demo-record] REFUSED: no complete UTILITY-track recipe for ${JSON.stringify(detail.project.utility)} / ${detail.project.state}. Learn it first (or pass --recipe <id>).`); return 2; }
    if (found.scopeType !== "utility") { console.error(`[demo-record] REFUSED: recipe ${found.id} is a ${found.scopeType} recipe — a real run records the utility track only.`); return 2; }
    recipe = found;
    realHosts = recipeTargetHosts(recipe);
    // THE REAL-RUN GUARD, phase 2 — with the recipe read: its hosts and its shape.
    const refusals = realRunRefusals({ realRun, iAmPresent: true, env: process.env, runApproval: null, headed: !headless, maskOn, targetHosts: realHosts, recipeSteps: recipe.steps });
    if (refusals.length) { for (const r of refusals) console.error(`[demo-record] REFUSED: ${r}`); return 2; }
    for (const h of realHosts) allowedHosts.add(h);
    console.log(`[demo-record] REAL RUN: recipe ${recipe.id} (${recipe.portalPlatform || "portal"}, v${recipe.version}, ${recipe.steps.length} steps) → host(s) ${realHosts.join(", ")}`);
    credential = getDecryptedCredentialByUrl(db, detail.project.clientId ?? "", recipe.portalUrl || "");
    console.log(`[demo-record] credential: ${credential ? "stored login found (never printed)" : "none stored — you will log in yourself in the browser"}`);
  } else {
    portal = await startDemoPortal();
    portalOpen = true;
    cleanups.push(closePortal);
    // The test-only submit click may only ever land on this process's own loopback fixture.
    if (injectSubmit && !/^http:\/\/127\.0\.0\.1:\d+$/.test(portal.baseUrl)) {
      throw new Error("--inject-submit-click refused: the portal is not the local fixture");
    }
    recipe = demoPortalRecipe(portal.baseUrl);
    credential = FIXTURE_CREDENTIAL;
  }

  // ── 6b. The mask: every known value of the project and the login, counted, never printed.
  let maskValueCount = 0;
  let maskScript = "";
  if (maskOn) {
    const src = o.maskValuesFrom && o.maskValuesFrom !== projectId ? getProjectDetail(db, o.maskValuesFrom).project : stagedProject;
    const values = piiMaskValues({
      project: { ...src, parserSnapshot: { ...(src.parserSnapshot as Record<string, unknown>), ...overlay } },
      credential: { username: credential?.username ?? "" },
      extra: [],
    });
    maskValueCount = values.length;
    maskScript = piiMaskInitScript({ values, shapes: piiMaskShapesFor(recipe.portalPlatform), extraSelectors: o.maskSelectors });
    console.log(`[demo-record] masking ON: ${maskValueCount} known value(s), ${o.maskSelectors.length} extra selector(s), platform shape "${recipe.portalPlatform || "generic"}"`);
  }

  // ── 7. Browser ──────────────────────────────────────────────────────────────────────
  const browser = await chromium.launch({
    headless,
    slowMo,
    // Belt and braces for "nothing leaves": the page's requests are routed below; anything
    // the browser does outside a page is pointed at a closed loopback port. A real run needs
    // the real host, so there the route below is the (counting) guard instead.
    ...(realRun ? {} : { proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1,localhost" } }),
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
  // Fictional: loopback only, everything else aborted and counted. Real: every host is
  // counted (a portal loads CDN assets), and a POST whose URL reads as a filing or a payment
  // is ABORTED and counted — the one request this recording must never let out.
  const routeCounters = realRun ? { loopback: 0, aborted: 0, abortedHosts: [] as string[] } : await installLoopbackOnlyRoute(context);
  const hostsSeen = new Map<string, number>();
  let submitOrPayRequests = 0;
  if (realRun) {
    await context.route("**/*", async (route) => {
      const req = route.request();
      let host = "";
      try { host = new URL(req.url()).hostname; } catch { host = req.url().slice(0, 40); }
      hostsSeen.set(host, (hostsSeen.get(host) ?? 0) + 1);
      if (req.method() !== "GET" && req.method() !== "HEAD" && isSubmitOrPayRequestUrl(req.url())) {
        submitOrPayRequests++;
        console.error(`[demo-record] ABORTED a ${req.method()} to a submit/pay-looking URL on ${host}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
  }
  await context.addInitScript({ content: NAME_SHIM });
  if (!realRun) await context.addInitScript({ content: captionInitScript() });
  if (maskScript) await context.addInitScript({ content: maskScript });
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
  let finalTitle = "";
  let reviewPageNamed = false;
  let runError = "";
  let gateObservations: import("./demo-portal/gateProbe").ClickGateObservation[] = [];
  try {
    if (!realRun) {
      // Title card.
      await page.goto(`${portal!.baseUrl}/intro`);
      await hold(4500);
      await shot("01-intro.png");
    }

    // What RecipeAdapter.login() does once its browser is open: go to the portal URL and
    // run the shared login flow.
    await page.goto(recipe.portalUrl);
    await hold(1200);
    loginResult = await performLogin(page, credential ?? undefined);
    console.log(`[demo-record] login: ${loginResult.status} — ${loginResult.message}`);
    if (!loginResult.ok && realRun) {
      // The person present finishes it (MFA, a challenge, no stored credential). Done when
      // no password box is showing on one of the recipe's own hosts.
      console.log(`[demo-record] waiting up to ${o.loginWaitS}s for you to finish the login in the browser window…`);
      const deadline = Date.now() + o.loginWaitS * 1000;
      let done = false;
      while (Date.now() < deadline) {
        await hold(2000);
        const pw = await page.locator("input[type=password]:visible").count().catch(() => 1);
        let host = "";
        try { host = new URL(page.url()).hostname.toLowerCase(); } catch { /* about:blank */ }
        if (pw === 0 && allowedHosts.has(host)) { done = true; break; }
      }
      if (!done) throw new Error(`login was not completed within ${o.loginWaitS}s`);
      loginResult = { ok: true, status: "human", message: "completed by the person present" };
      await shot("01-logged-in.png");
    }
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
    finalTitle = await page.title().catch(() => "");
    reviewPageNamed = await page.evaluate(() => document.body?.innerText || "").then((t) => isReviewPageText(t)).catch(() => false);

    if (!realRun) {
      // Independent read-back: what the fictional portal's own review page now shows.
      reviewRows = await page.$$eval("table.summary tr", (trs) => trs
        .map((tr) => ({ label: (tr.querySelector("th")?.textContent || "").trim(), value: (tr.querySelector("td")?.textContent || "").trim() }))
        .filter((r) => r.value !== "" || r.label === "")).catch(() => []);
    }

    if (injectSubmit) {
      // TEST ONLY — the recorder clicks, to prove the gate below refuses the video.
      await page.locator("#submitApplication").click().catch(() => {});
      await hold(1500);
    } else if (realRun) {
      await hold(1200);
      await shot("99-stopped-at-review.png");
      console.log("[demo-record] the engine has stopped at the review screen; closing the browser in 6s (nothing is submitted; delete the portal's autosaved draft yourself afterwards)");
      await hold(6000);
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

  // ── 8. The gate ──────────────────────────────────────────────────────────────────
  // The ENGINE's own answer on the final-submit step(s), as observed during this run.
  const finalSubmitObs = gateObservations.filter((g) => g.isFinalSubmit);
  for (const g of finalSubmitObs) console.log(`[demo-record] final submit "${g.note.slice(0, 50)}": ${describeGate(g)}`);
  if (!finalSubmitObs.length) console.log("[demo-record] final submit: the step never reached the engine's click gate");
  // The engine's own words for a refusal in the flagged branch (the shared final-submit gate).
  const finalSubmitRefusalReasons = (Array.isArray(fillResult.data?.driftWarnings) ? (fillResult.data!.driftWarnings as unknown[]).map(String) : []).filter((w) => /final submit NOT clicked/i.test(w));
  for (const w of finalSubmitRefusalReasons) console.log(`[demo-record] engine: ${w.slice(0, 220)}`);
  const flaggedSteps = recipe.steps.filter((s) => s.isFinalSubmit === true);
  const finalSubmitStepHasNoTarget = flaggedSteps.length === 1 && Object.keys((flaggedSteps[0].selector ?? {}) as object).length === 0;
  const evidence: RecordingEvidence = {
    mode: realRun ? "real" : "fictional",
    finalSubmitGates: finalSubmitObs.length ? finalSubmitObs.map((g) => g.gate) : ["not-evaluated"],
    finalSubmitStepHasNoTarget,
    replayOk: !runError && loginResult.ok && fillResult.ok === true && reviewResult.ok === true,
    finalSubmitClickedSources: [
      adapterFlag,
      reviewResult.data?.finalSubmitClicked as boolean | undefined,
      // runAdapter's own derivation, reproduced: a clicked allowlisted submit shows up here.
      (reviewResult.ok && reviewResult.data?.finalSubmitClicked === true) || adapterFlag === true ? true : false,
    ],
    submitRequests: portal ? portal.submitPosts().length : 0,
    nonGetRequests: portal ? portal.nonGetRequests().length : 0,
    submitOrPayRequests: realRun ? submitOrPayRequests : undefined,
    abortedRequests: routeCounters.aborted,
    nodeNetworkAttempts: nodeNetworkAttempts.length,
    // Fictional: the fixture's review URL. Real: the page names itself the review step, or its
    // URL/title says review — the adapter's own report alone is not the evidence.
    reachedReviewUrl: realRun ? (reviewPageNamed || /review/i.test(`${finalUrl} ${finalTitle}`)) : /\/apply\/review$/.test(finalUrl),
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
    mode: evidence.mode,
    kept: verdict.keep,
    refusedBecause: verdict.reasons,
    out: verdict.keep ? out : null,
    videoBytes: savedBytes,
    wallSeconds: Math.round(wallMs / 100) / 10,
    resolution: "1440x900",
    slowMo,
    headless,
    masked: maskOn,
    maskValueCount,
    maskSelectorCount: o.maskSelectors.length,
    login: `${loginResult.status}`,
    replayOk: fillResult.ok,
    replayMessage: String(fillResult.message ?? "").slice(0, 600),
    stopAtReview: String(reviewResult.message ?? "").slice(0, 300),
    recipe: realRun ? { id: recipe.id, platform: recipe.portalPlatform, version: recipe.version, hosts: realHosts } : "fictional",
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
    reviewPageNamed,
    finalSubmitClickedSources: evidence.finalSubmitClickedSources,
    finalSubmitStepHasNoTarget,
    finalSubmitStoppedBy: finalSubmitObs.map((g) => ({ gate: g.gate, reason: describeGate(g), feeGateMatched: g.feeGateMatched, autoSubmitConsulted: g.autoSubmitConsulted })),
    finalSubmitRefusalReasons,
    clickGateObservations: gateObservations.map((g) => `${g.gate}: ${g.note.slice(0, 50)}`),
    fixtureRequests: portal ? portal.log.length : 0,
    fixtureSubmitRequests: evidence.submitRequests,
    fixtureNonGetRequests: evidence.nonGetRequests,
    browserLoopbackRequests: routeCounters.loopback,
    browserAbortedRequests: routeCounters.aborted,
    browserAbortedHosts: [...new Set(routeCounters.abortedHosts)],
    browserHostsSeen: realRun ? Object.fromEntries(hostsSeen) : undefined,
    submitOrPayRequestsAborted: realRun ? submitOrPayRequests : undefined,
    nodeNetworkAttempts,
    finalUrlPath: finalUrl ? new URL(finalUrl).pathname : "",
    shots,
    footer: realRun ? "Real portal, real unfiled project, masked on screen at record time. A person reviews every frame before use." : CAPTION_FOOTER,
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
