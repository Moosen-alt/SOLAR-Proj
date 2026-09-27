// THE RUN'S OWN LOGIN IS BOUND BY HOST + FIRST PATH SEGMENT, NOT BY REGISTRABLE DOMAIN (hard rule 2;
// checker close-mustfix L7 should-fix).
//
// With no credential resolver (the CLI and bench callers), the learner typed the run's own login
// into any page on the start URL's registrable domain (siteOfUrl): aca-prod.accela.com/SANDIEGO's
// password went to /LASCRUCES, and to any other *.accela.com host. The backend's resolver
// (selectCredentialUrlsFor) already binds by host + first path segment. ONE QUESTION, ONE
// PREDICATE: sameCredentialScope must agree with the backend's function on every row below, and
// the learner's fallback must actually ask it.
//
// Run: npx tsx portal-bot/src/siteOf.test.ts
// Constructing the learner starts a debug bundle (LearnRunDebug.start) — keep it out of data/learn-runs.
import "./smokeArtifactDirs";
import assert from "node:assert/strict";
import { sameCredentialScope } from "./siteOf";
import { selectCredentialUrlsFor } from "../../backend/src/portalCredentials";
import { AutoLearnAdapter } from "./adapters/autoLearnAdapter";

let failures = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${e instanceof Error ? e.message : String(e)}`); }
};

// [target, stored (the run's start URL), expected]
const TABLE: Array<[string, string, boolean]> = [
  // MUST-PASS
  ["https://aca-prod.accela.com/SANDIEGO/Login.aspx", "https://aca-prod.accela.com/SANDIEGO/Default.aspx", true],
  ["https://aca-prod.accela.com/sandiego/Cap/CapHome.aspx", "https://aca-prod.accela.com/SANDIEGO/Default.aspx", true],
  ["https://permits.example.gov/login", "https://permits.example.gov/", true],
  ["https://www.example.gov/account/login", "https://example.gov", true],
  // MUST-EXCLUDE
  ["https://aca-prod.accela.com/LASCRUCES/Login.aspx", "https://aca-prod.accela.com/SANDIEGO/Default.aspx", false],
  ["https://aca-prod.accela.com/Login.aspx", "https://aca-prod.accela.com/SANDIEGO/Default.aspx", false],
  ["https://citizenaccess.accela.com/SANDIEGO/Login.aspx", "https://aca-prod.accela.com/SANDIEGO/Default.aspx", false],
  ["https://other.gov/login", "https://permits.example.gov/", false],
  ["not a url", "https://permits.example.gov/", false],
];

await t("sameCredentialScope matches the table", () => {
  for (const [target, stored, want] of TABLE) assert.equal(sameCredentialScope(target, stored), want, `${target} vs ${stored}`);
});
await t("ONE PREDICATE: sameCredentialScope agrees with the backend's selectCredentialUrlsFor on every row", () => {
  for (const [target, stored] of TABLE) {
    const backend = selectCredentialUrlsFor(target, [stored]).length > 0;
    assert.equal(sameCredentialScope(target, stored), backend, `${target} vs ${stored}: backend says ${backend}`);
  }
});
await t("the learner's no-resolver fallback binds the run's own credential by host + first segment", async () => {
  const cred = { username: "u", password: "p" };
  const a = Object.create(AutoLearnAdapter.prototype) as Record<string, unknown>;
  a.options = {};
  a.runCredential = cred;
  a.startUrl = "https://aca-prod.accela.com/SANDIEGO/Default.aspx";
  const credentialFor = (AutoLearnAdapter.prototype as unknown as { credentialFor: (u: string) => Promise<unknown> }).credentialFor;
  assert.equal(await credentialFor.call(a, "https://aca-prod.accela.com/SANDIEGO/Login.aspx"), cred, "MUST-PASS: the start URL's own jurisdiction");
  assert.equal(await credentialFor.call(a, "https://aca-prod.accela.com/LASCRUCES/Login.aspx"), null, "MUST-EXCLUDE: another city on the same host");
  assert.equal(await credentialFor.call(a, "https://citizenaccess.accela.com/SANDIEGO/Login.aspx"), null, "MUST-EXCLUDE: another host on the same registrable domain");
});

if (failures) { console.error(`\n${failures} site-of test(s) FAILED.`); process.exit(1); }
console.log("\nAll site-of credential-scope tests passed.");
process.exit(0);
