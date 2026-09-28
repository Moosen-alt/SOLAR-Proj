// LEAK-FIX (forms, documents, KB) — the DB-free half. Each section pins one confirmed sweep finding
// (.probe/leak-sweep/RESULT.json) with a MUST-PASS and a MUST-EXCLUDE, so a fix that over-corrects
// fails as loudly as one that regresses. Synthetic values only: no real licence number, supervisor
// name, login handle or password appears here.
//
//   npx tsx backend/test/leakFixForms.test.ts
import "./_isolate"; // FIRST: temp cwd, reference data reachable
import assert from "node:assert/strict";

delete process.env.ANTHROPIC_API_KEY;

const { matchingForms } = await import("../src/ahjForms");

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------------------------
// F1 — the built-in City of Portland (OR) electrical application belongs to Portland, OREGON.
// ---------------------------------------------------------------------------------------------
const PORTLAND_FORM = "portland-electrical-renewable-energy";
const ids = (p: { ahj: string; state: string }) => matchingForms(p).map((d) => d.id);

await check("F1 MUST-PASS: Portland, OR still gets its own electrical application (OR, Oregon, bare 'Portland')", () => {
  assert.deepEqual(ids({ ahj: "City of Portland", state: "OR" }), [PORTLAND_FORM]);
  assert.deepEqual(ids({ ahj: "City of Portland", state: "Oregon" }), [PORTLAND_FORM]);
  assert.deepEqual(ids({ ahj: "Portland", state: "or" }), [PORTLAND_FORM]);
});

await check("F1 MUST-EXCLUDE: South Portland ME, Portland ME / TX / CT never get Portland, Oregon's form", () => {
  for (const p of [
    { ahj: "City of South Portland", state: "ME" },
    { ahj: "City of Portland", state: "ME" },
    { ahj: "Portland", state: "TX" },
    { ahj: "Town of Portland", state: "CT" },
    { ahj: "City of Portland", state: "Maine" },
  ]) assert.deepEqual(ids(p), [], `${p.ahj}, ${p.state} matched ${ids(p).join(",")}`);
});

await check("F1 MUST-EXCLUDE: a blank or unrecognised state is UNKNOWN, never Oregon", () => {
  assert.deepEqual(ids({ ahj: "City of Portland", state: "" }), []);
  assert.deepEqual(ids({ ahj: "City of Portland", state: "OR 97201" }), []);
});

await check("F1 MUST-EXCLUDE: a county or a name that only CONTAINS the word is not the city (whole words, same kind)", () => {
  assert.deepEqual(ids({ ahj: "Portlandia County", state: "OR" }), []);
  assert.deepEqual(ids({ ahj: "Multnomah County", state: "OR" }), []);
});

console.log(`\nleakFixForms: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
