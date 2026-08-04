// Deterministic parser cross-checks: pure arithmetic over the parsed payload
// that catches transposed digits / unit swaps / wrong-system values at QC time
// instead of as an AHJ correction days later. Warning severity only.
// Run: tsx backend/test/parserCrossChecks.test.ts
import assert from "node:assert/strict";
import { evaluateBaselineRules } from "../src/baselineRules";

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };
const ids = (payload: Record<string, unknown>) => evaluateBaselineRules(payload).map((r) => r.ruleId);

// 1) Module math: qty × wattage must agree with dcKw within 150 W.
assert.ok(ids({ moduleQty: 12, moduleWattage: 440, dcKw: 5.28 }).every((r) => r !== "xcheck-module-math"));
assert.ok(ids({ moduleQty: 12, moduleWattage: 440, dcKw: 8.2 }).includes("xcheck-module-math"), "transposed dcKw must fire");
assert.ok(ids({ moduleQty: 12, dcKw: 5.28 }).every((r) => r !== "xcheck-module-math"), "missing wattage stays silent");
ok("module qty × wattage vs dcKw");

// 2) Combined-size arithmetic on additions (the Kristina Anderson shape passes).
assert.ok(ids({ dcKw: 5.28, existingDcKw: 5.16, combinedDcKw: 10.44 }).every((r) => r !== "xcheck-combined-size"));
assert.ok(ids({ dcKw: 5.28, existingDcKw: 5.16, combinedDcKw: 12.9 }).includes("xcheck-combined-size"));
ok("combined = new + existing arithmetic");

// 3) DC/AC ratio: AC above DC by >10% is a swap/misread.
assert.ok(ids({ dcKw: 5.28, acKw: 5.376 }).every((r) => r !== "xcheck-dc-ac-ratio"));
assert.ok(ids({ dcKw: 5.28, acKw: 7.6 }).includes("xcheck-dc-ac-ratio"), "existing-system AC misattributed to new must fire");
ok("DC/AC ratio sanity");

// 4) PV breaker 125% continuous-output check (micro: 7 × 3.2 A × 1.25 = 28 A).
assert.ok(ids({ pvBreaker: 30, pvMicroOutputW: 3.2, pvMicroQty: 7 }).every((r) => r !== "xcheck-pv-breaker-125"));
assert.ok(ids({ pvBreaker: 20, pvMicroOutputW: 3.2, pvMicroQty: 7 }).includes("xcheck-pv-breaker-125"));
// String inverter: invOutputW amps per unit × invQty.
assert.ok(ids({ pvBreaker: 40, invOutputW: 32, invQty: 1 }).every((r) => r !== "xcheck-pv-breaker-125"));
assert.ok(ids({ pvBreaker: 35, invOutputW: 32, invQty: 1 }).includes("xcheck-pv-breaker-125"));
ok("PV breaker ≥ 125% of continuous output");

// 5) All four are warnings — never blockers.
const fired = evaluateBaselineRules({ moduleQty: 12, moduleWattage: 440, dcKw: 8, acKw: 12, existingDcKw: 2, combinedDcKw: 20, pvBreaker: 10, pvMicroOutputW: 3.2, pvMicroQty: 7 })
  .filter((r) => r.ruleId.startsWith("xcheck-"));
assert.equal(fired.length, 4);
assert.ok(fired.every((r) => r.severity === "warning" && r.qcStatus === "warning"));
ok("cross-checks are always warnings, never blockers");

console.log(`\nparserCrossChecks: all ${passed} checks passed`);
