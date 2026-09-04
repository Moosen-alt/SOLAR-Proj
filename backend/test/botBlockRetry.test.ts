// A PORTAL THAT REFUSES ROBOTS MAY STILL ACCEPT A REAL WINDOW.
//
// Several jurisdictions front their permitting portal with a WAF that serves 403 / "Access
// Denied" to a headless browser and the ordinary site to a headed one. Measured during the
// portal sweep on gosolarapp.org and two other AZ/CA hosts, all of which the benchmark then
// scored as unreachable — portals we can reach perfectly well, in a browser they will talk to.
//
// So a run blocked that way is retried once with a real window. The whole value of that
// depends on this predicate being NARROW: a retry costs minutes, and retrying things a
// headed browser cannot fix (a wrong password, a dead host, an authorisation 403) would burn
// them for nothing. Most of this test is therefore the cases that must NOT retry.
//
// Browser-free. Run: tsx backend/test/botBlockRetry.test.ts
import assert from "node:assert/strict";
import { looksBotBlocked } from "../src/autoLearn";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// Refusals aimed at the CLIENT: a real window is worth trying.
// ---------------------------------------------------------------------------
for (const msg of [
  "403 Forbidden",
  "ERROR: The request could not be satisfied",           // CloudFront, verbatim from the sweep
  "Access Denied",                                        // palmbayfl.gov, verbatim
  "Checking your browser before accessing — Cloudflare",
  "Please verify you are a robot",
  "Verify you are human",
  "We have detected unusual traffic from your network",
]) {
  check(`retries headed: "${msg.slice(0, 46)}"`, () => {
    assert.equal(looksBotBlocked(msg), true);
  });
}

// ---------------------------------------------------------------------------
// Everything a headed browser cannot fix. These are the expensive mistakes.
// ---------------------------------------------------------------------------
check("a refused PASSWORD is not a bot block", () => {
  // eTRAKiT, Shoreline — verbatim. A real window will be refused just the same.
  assert.equal(looksBotBlocked("Still on the login form after submitting — the stored username/password was likely rejected."), false);
});

check("an AUTHORISATION 403 is not a bot block, though it says 403", () => {
  // The tell is that the refusal names the account rather than the client.
  assert.equal(looksBotBlocked("403: your account is not authorized to file in this jurisdiction"), false);
  assert.equal(looksBotBlocked("Forbidden — you do not have permission for this record type"), false);
});

check("a dead host is not a bot block", () => {
  assert.equal(looksBotBlocked("page.goto: net::ERR_TIMED_OUT"), false);
  assert.equal(looksBotBlocked("page.goto: net::ERR_NAME_NOT_RESOLVED"), false);
});

check("an ordinary learn failure is not a bot block", () => {
  assert.equal(looksBotBlocked("Auto-learn found nothing fillable on 3 page(s); no steps recorded"), false);
  assert.equal(looksBotBlocked("Could not find a login form or any signed-in signal on this portal"), false);
});

check("empty and junk input never triggers a retry", () => {
  assert.equal(looksBotBlocked(""), false);
  assert.equal(looksBotBlocked(undefined as unknown as string), false);
});

if (failures) { console.error(`\n${failures} bot-block-retry check(s) FAILED.`); process.exit(1); }
console.log("\nAll bot-block-retry checks passed.");
process.exit(0);
