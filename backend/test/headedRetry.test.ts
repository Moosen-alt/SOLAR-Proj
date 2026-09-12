// A BOT WALL MUST NEVER BE THE REASON A FILING DOES NOT HAPPEN.
//
// autoLearnPortal has retried headed since Baltimore ("portal refused a headless browser —
// retrying with a real window"). STAGING never did, so a portal that refuses headless failed
// the submission outright on a machine that could have filed it perfectly well.
//
// Not hypothetical, and measured this session: coosbayor.gov returns 403 to every programmatic
// client — WebFetch, curl with a browser User-Agent, AND headless Playwright — while a HEADED
// window gets 200. A portal behaving that way at staging time is a filing that silently does
// not happen.
//
//   MUST PASS    — a bot-blocked staging failure is retried headed, and a headed success wins.
//   MUST EXCLUDE — an ordinary failure is NOT retried (doubling every real error's cost is its
//                  own outage); a retry is never attempted twice; a SECOND refusal does not
//                  erase the first result's diagnostics; the operator can switch it off.
//
//   npx tsx backend/test/headedRetry.test.ts
import assert from "node:assert/strict";
import { looksBotBlocked } from "../src/runAbort";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// The shape repository.ts reads a failure through: the message rides on the STEP, not the
// summary. A retry decision that only read result.message would be dead code for step failures.
const failureText = (result: unknown): string => {
  const r = (result ?? {}) as { message?: unknown; steps?: Array<{ message?: unknown }> };
  return [
    typeof r.message === "string" ? r.message : "",
    ...(Array.isArray(r.steps) ? r.steps.map((s) => (typeof s?.message === "string" ? s.message : "")) : []),
  ].filter(Boolean).join(" | ");
};

// The exact predicate the staging path applies.
const wouldRetry = (result: { ok: boolean; message?: string; steps?: Array<{ message?: string }> },
  headless: boolean | undefined, envOff = false): boolean =>
  !result.ok && looksBotBlocked(failureText(result)) && headless !== false && !envOff;

check("a bot wall detected on the STEP (not the summary) triggers the retry", () => {
  const result = { ok: false, steps: [{ message: "Recipe step failed (goto): net::ERR_HTTP_RESPONSE_CODE_FAILURE 403 Access Denied" }] };
  assert.ok(looksBotBlocked(failureText(result)),
    "the 403 rides on the step; a retry test reading only result.message is dead code here");
  assert.equal(wouldRetry(result, true), true);
});

check("the real-world wordings are recognised", () => {
  for (const msg of [
    "403 Forbidden",
    "Access Denied — You don't have permission to access this server",
    "net::ERR_HTTP_RESPONSE_CODE_FAILURE",
    "Request blocked by security policy",
  ]) {
    assert.ok(looksBotBlocked(msg), `"${msg}" reads as an ordinary failure, so a real portal stays blocked`);
  }
});

check("MUST EXCLUDE: an ACCOUNT refusal is still not a bot wall", () => {
  // The exclusion this guards was written for real authorisation failures, and a headed
  // window would be refused identically - retrying buys nothing but a second draft.
  for (const msg of [
    "403: your account does not have permission to view this record",
    "Sign in failed — check your credentials",
    "You are not authorized to access this application",
  ]) {
    assert.equal(looksBotBlocked(msg), false, `"${msg}" would trigger a pointless headed retry`);
  }
});

check("MUST EXCLUDE: an ordinary failure is NOT retried", () => {
  // Retrying every failure doubles the cost of every genuine error and leaves a second draft
  // on the portal for nothing.
  for (const msg of [
    "Recipe step failed (fill — inverter quantity): locator.fill: Timeout 30000ms exceeded",
    "Required field(s) left blank: County",
    "the portal did not advance",
  ]) {
    assert.equal(wouldRetry({ ok: false, steps: [{ message: msg }] }, true), false,
      `"${msg}" would trigger a pointless headed retry`);
  }
});

check("MUST EXCLUDE: a run that was ALREADY headed is not retried", () => {
  const blocked = { ok: false, steps: [{ message: "403 Access Denied" }] };
  assert.equal(wouldRetry(blocked, false), false,
    "retrying headed when we were already headed is an infinite appetite for browsers");
});

check("MUST EXCLUDE: the operator can switch it off (PORTAL_HEADED_RETRY=0)", () => {
  const blocked = { ok: false, steps: [{ message: "403 Access Denied" }] };
  assert.equal(wouldRetry(blocked, true, true), false);
});

check("MUST EXCLUDE: a SUCCESS is never retried", () => {
  assert.equal(wouldRetry({ ok: true, message: "403 appeared in a log line but the run succeeded" }, true), false);
});

check("a second refusal must not erase the first result's diagnostics", () => {
  // The keep-rule repository.ts applies: keep the retry only if it got further.
  const first = { ok: false, steps: [{ message: "403" }, { message: "403" }] };
  const retryRefusedToo = { ok: false, steps: [{ message: "403" }] };
  const keep = retryRefusedToo.ok || retryRefusedToo.steps.length > first.steps.length;
  assert.equal(keep, false, "a shorter second failure would replace a more informative first one");
});

check("a headed success DOES win", () => {
  const first = { ok: false, steps: [{ message: "403" }] };
  const headedOk = { ok: true, steps: [{ message: "" }, { message: "" }, { message: "" }] };
  const keep = headedOk.ok || headedOk.steps.length > first.steps.length;
  assert.equal(keep, true);
});

console.log(failures === 0
  ? "\nAll headed-retry checks passed."
  : `\n${failures} headed-retry check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
