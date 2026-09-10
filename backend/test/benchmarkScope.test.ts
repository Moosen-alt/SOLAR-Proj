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

console.log(failures === 0 ? "\nAll benchmark-scope checks passed." : `\n${failures} benchmark-scope check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
