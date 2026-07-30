// Existing-system (addition) support: the parser's existing*/combined* fields
// flow into the canonical snapshot flag, the NEM size screens consider the
// COMBINED capacity, and the description-of-work / worksheet call out the
// addition. Browser/DB-free. Run: tsx backend/test/existingSystem.test.ts
import assert from "node:assert/strict";
import { canonicalizeSnapshot } from "../src/normalize";
import { evaluateBaselineRules } from "../src/baselineRules";
import { resolveSource, type FillContext } from "../src/ahjForms";
import type { ProjectRecord } from "../../shared/src/types";

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

// 1) canonicalizeSnapshot: ANY existing*/combined* evidence → hasExistingSystem
//    "Yes". No evidence (or an explicit "no") sets NOTHING — a blank, never a
//    definitive "No", so absence of data can't attest "no existing generation"
//    on a form and can't tick a checkbox under either fill semantics.
{
  assert.equal(canonicalizeSnapshot({ existingSystem: "yes" }).hasExistingSystem, "Yes");
  assert.equal(canonicalizeSnapshot({ existingDcKw: 5.16 }).hasExistingSystem, "Yes");
  assert.equal(canonicalizeSnapshot({ existingInvModel: "Tesla 7.6kW 1538000-45-y" }).hasExistingSystem, "Yes");
  // Every evidence field counts — not just the first few.
  assert.equal(canonicalizeSnapshot({ existingAcKw: 7.6 }).hasExistingSystem, "Yes");
  assert.equal(canonicalizeSnapshot({ existingModuleMake: "Silfab" }).hasExistingSystem, "Yes");
  assert.equal(canonicalizeSnapshot({ existingInvQty: 1 }).hasExistingSystem, "Yes");
  assert.equal(canonicalizeSnapshot({ combinedDcKw: 10.44 }).hasExistingSystem, "Yes");
  assert.equal(canonicalizeSnapshot({}).hasExistingSystem, undefined);
  assert.equal(canonicalizeSnapshot({ existingSystem: "no" }).hasExistingSystem, undefined);
  ok("hasExistingSystem: Yes on any evidence, BLANK (never No) otherwise");
}

// 2) NEM size screens use the COMBINED capacity on additions. The Kristina
//    Anderson shape (5.28 new + 5.16 existing = 10.44 combined) stays under the
//    25 kW screen; a 6 kW addition to a 20 kW system (26 combined) crosses it.
{
  const under = evaluateBaselineRules({ state: "OR", utility: "PGE", dcKw: 5.28, combinedDcKw: 10.44 });
  assert.ok(!under.some((r) => r.ruleId === "or-nem-residential-25kw"), "10.44 kW combined must not trip the 25 kW screen");

  const over = evaluateBaselineRules({ state: "OR", utility: "PGE", dcKw: 6, combinedDcKw: 26 });
  const screen = over.find((r) => r.ruleId === "or-nem-residential-25kw");
  assert.ok(screen, "26 kW combined must trip the 25 kW screen even though the new addition is 6 kW");
  assert.ok(/combined/.test(screen!.message), "screen message should say the size is combined");

  // No combined data → legacy behavior on dcKw alone.
  const legacy = evaluateBaselineRules({ state: "OR", utility: "PGE", dcKw: 26 });
  assert.ok(legacy.some((r) => r.ruleId === "or-nem-residential-25kw"));
  assert.ok(!evaluateBaselineRules({ state: "OR", utility: "PGE", dcKw: 6 }).some((r) => r.ruleId === "or-nem-residential-25kw"));
  ok("NEM 25 kW screen keys off combined (new + existing) capacity");
}

// 3) Tier-1 export screen's DC arm also uses the combined size.
{
  const rules = evaluateBaselineRules({ state: "OR", utility: "PGE", dcKw: 10, combinedDcKw: 51 });
  const tier = rules.find((r) => r.ruleId === "or-nem-tier1-export-25kw");
  assert.ok(tier, "51 kW combined must trip the 50 kW Tier-1 DC arm");
  assert.ok(/combined/.test(tier!.message));
  ok("Tier-1 export screen DC arm keys off combined capacity");
}

// 4) computed.descriptionOfWork calls out the addition with existing + combined.
{
  const snapshot = {
    moduleQuantity: 12, moduleModel: "ZXM7-UHLD108-440/N",
    hasExistingSystem: "Yes", existingDcKw: 5.16, combinedDcKw: 10.44,
  };
  const ctx: FillContext = {
    project: { systemSizeDcKw: 5.28, parserSnapshot: snapshot } as unknown as ProjectRecord,
    client: {},
    snapshot,
  };
  const desc = resolveSource("computed.descriptionOfWork", ctx);
  assert.ok(/addition/i.test(desc), `should say addition: ${desc}`);
  assert.ok(desc.includes("5.16"), `should carry the existing size: ${desc}`);
  assert.ok(desc.includes("10.44"), `should carry the combined size: ${desc}`);
  assert.ok(desc.includes("12x ZXM7-UHLD108-440/N"), `new equipment still leads: ${desc}`);

  const plain = resolveSource("computed.descriptionOfWork", {
    project: { systemSizeDcKw: 5.28, parserSnapshot: { moduleQuantity: 12, moduleModel: "ZXM7-UHLD108-440/N" } } as unknown as ProjectRecord,
    client: {},
    snapshot: { moduleQuantity: 12, moduleModel: "ZXM7-UHLD108-440/N" },
  });
  assert.ok(!/addition|existing/i.test(plain), `no-existing project stays unchanged: ${plain}`);

  // An explicit existingSystem:"no" must NOT read as an addition ("no" is a
  // truthy string — only /^yes$/i counts).
  const said = { moduleQuantity: 12, moduleModel: "ZXM7-UHLD108-440/N", existingSystem: "no" };
  const saidNo = resolveSource("computed.descriptionOfWork", {
    project: { systemSizeDcKw: 5.28, parserSnapshot: said } as unknown as ProjectRecord,
    client: {},
    snapshot: said,
  });
  assert.ok(!/addition|existing/i.test(saidNo), `existingSystem:"no" must not claim an addition: ${saidNo}`);
  ok("descriptionOfWork calls out the addition (and only on real additions)");
}

console.log(`\nexistingSystem: all ${passed} checks passed`);
