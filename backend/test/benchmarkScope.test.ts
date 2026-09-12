// A NEM PORTAL LEARNED AS AN AHJ IS LEARNED WRONG, AND BANKED WHERE NOBODY LOOKS.
//
// runLearnBenchmark hardcoded scope:"ahj" for every target. For the interconnection
// platforms that meant the planner got a jurisdiction code profile and a
// "permitDiscipline: electrical / targetJurisdiction (AHJ)" header while it was looking at a
// net-metering application — and the recipe banked under an AHJ key that no real NEM project
// ever resolves. The verified Ameren recipe (v21, 3/3 self-test) sat at
// "il|benchmark amerenillinoisinterconnect powerclerk com|ameren illinois" while a real
// Ameren project resolved "il|unknown|ameren illinois" (v6, "NOT verified").
//
// The scope now comes from isUtilityPlatformUrl — the same predicate safety rule 5 uses to
// keep a permit track off a utility portal, so the benchmark cannot drift from the product.
//
//   npx tsx backend/test/benchmarkScope.test.ts
import assert from "node:assert";
import { isUtilityPlatformUrl } from "../src/portalChannel";
import { recipeProfileKey } from "../src/portalRecipes";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// The scope expression as runLearnBenchmark computes it.
const scopeFor = (url: string): "ahj" | "utility" => (isUtilityPlatformUrl(url) ? "utility" : "ahj");

check("PowerClerk interconnection portals learn as UTILITY", () => {
  assert.equal(scopeFor("https://amerenillinoisinterconnect.powerclerk.com/MvcAccount/Login"), "utility");
  assert.equal(scopeFor("https://pacificorpnetmetering.powerclerk.com/"), "utility");
});

check("ConnectTheGrid (ComEd, PECO) learns as UTILITY", () => {
  assert.equal(scopeFor("https://interconnect.comed.com/applications"), "utility");
  assert.equal(scopeFor("https://peco.connectthegrid.com/applications"), "utility");
});

check("MUST EXCLUDE: AHJ permit portals still learn as AHJ", () => {
  // The reverse error is just as bad: a permit portal learned as "utility" banks under a
  // utility key and loses its jurisdiction code profile, which permit planning needs.
  assert.equal(scopeFor("https://apps.miami.gov/iBuildPortal/"), "ahj");
  assert.equal(scopeFor("https://aca-prod.accela.com/oregon/"), "ahj");
  assert.equal(scopeFor("https://permiteyes.us/bellingham/userindex.php"), "ahj");
  assert.equal(scopeFor("https://ci-lynn-ma.smartgovcommunity.com/"), "ahj");
});

check("MUST EXCLUDE: a permit URL merely mentioning a utility stays AHJ", () => {
  // The host-only rule that portalChannel documents — a path substring must not flip it.
  assert.equal(scopeFor("https://permits.example.gov/apply?utility=pge.com"), "ahj");
  assert.equal(scopeFor("https://notpowerclerk.com.evil.test/"), "ahj");
});

check("a utility-scoped learn banks the key a real NEM project resolves", () => {
  // repository.ts:5355 looks up scopeType "utility" with state+utility and NO ahj.
  const bankedByBenchmark = recipeProfileKey({
    scopeType: "utility", state: "IL",
    ahj: "Benchmark amerenillinoisinterconnect.powerclerk.com", utility: "Ameren Illinois",
  });
  const soughtByRealProject = recipeProfileKey({
    scopeType: "utility", state: "IL", ahj: "City of Springfield", utility: "Ameren Illinois",
  });
  assert.equal(bankedByBenchmark, soughtByRealProject,
    `utility scope must ignore the AHJ so the benchmark's fake AHJ name cannot fork the key:\n         banked=${bankedByBenchmark}\n         sought=${soughtByRealProject}`);
});

check("...and the OLD ahj scope demonstrably forked it (the bug this fixes)", () => {
  const oldBenchmarkKey = recipeProfileKey({
    scopeType: "ahj", state: "IL",
    ahj: "Benchmark amerenillinoisinterconnect.powerclerk.com", utility: "Ameren Illinois",
  });
  const realProjectKey = recipeProfileKey({
    scopeType: "utility", state: "IL", ahj: "City of Springfield", utility: "Ameren Illinois",
  });
  assert.notEqual(oldBenchmarkKey, realProjectKey,
    "the old ahj-scoped key should NOT match a real project's utility key — if it does, this test no longer describes the bug");
});

// THE UTILITY MUST COME FROM THE PORTAL, NOT FROM THE STATE.
//
// A utility-scoped recipe is keyed ONLY on (state, utility), and the benchmark picked the
// utility from a per-STATE table. Illinois has two: CITY_BY_STATE.IL says "Ameren Illinois",
// so learning ComEd's interconnect.comed.com produced the key "il|unknown|ameren illinois" -
// Ameren's row, holding the verified 79-step v21 that every real Ameren NEM project resolves.
// It survived the 2026-09-12 ComEd re-learn only because the deeper-draft guard refused a
// shallower overwrite. A ComEd learn that went deeper would have replaced Ameren's verified
// recipe with ComEd's steps, and the next Ameren filing would have replayed the wrong
// utility's application.
const UTILITY_BY_HOST: Record<string, string> = {
  "interconnect.comed.com": "Commonwealth Edison (ComEd)",
  "peco.connectthegrid.com": "PECO",
  "amerenillinoisinterconnect.powerclerk.com": "Ameren Illinois",
  "pgenm.powerclerk.com": "Portland General Electric",
  "pacificorpnetmetering.powerclerk.com": "Pacific Power",
  "dlc-customer-owned-generation.customerapplication.com": "Duquesne Light",
};
const utilityFor = (host: string, stateDefault: string): string =>
  UTILITY_BY_HOST[host.toLowerCase()] || stateDefault;

check("two utilities in one state never share a recipe key", () => {
  const comed = recipeProfileKey({ scopeType: "utility", state: "IL", ahj: "Benchmark interconnect.comed.com",
    utility: utilityFor("interconnect.comed.com", "Ameren Illinois") } as never);
  const ameren = recipeProfileKey({ scopeType: "utility", state: "IL", ahj: "City of Springfield",
    utility: utilityFor("amerenillinoisinterconnect.powerclerk.com", "Ameren Illinois") } as never);
  assert.notEqual(comed, ameren,
    `ComEd and Ameren resolve to the SAME key (${comed}) - a ComEd learn overwrites Ameren's verified recipe`);
  assert.match(ameren, /ameren/, `the Ameren key lost its own utility: ${ameren}`);
});

check("KILL: the old state-only rule DID collide - this is the bug, not a hypothetical", () => {
  const stateOnly = (state: string) => recipeProfileKey({ scopeType: "utility", state,
    ahj: "anything", utility: "Ameren Illinois" } as never);
  assert.equal(stateOnly("IL"), stateOnly("IL"),
    "with the utility taken from the state, every IL portal shares one key");
});

check("an unlisted host keeps the state default, so a single-utility state still works", () => {
  assert.equal(utilityFor("some-new-portal.example.gov", "Idaho Power"), "Idaho Power");
});

console.log(failures === 0 ? "\nAll benchmark-scope checks passed." : `\n${failures} benchmark-scope check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
