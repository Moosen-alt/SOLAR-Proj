// THE MANUAL-ENTRY "PERMIT PATH" CONTROL OFFERS OREGON'S SPLIT ONLY WHERE IT EXISTS.
//
// e2e-gap close verifier MF2 (2026-09-26): the label "Permit path (prescriptive vs engineered)" and
// the hint "Prescriptive and structural applications are mutually exclusive …" rendered on EVERY
// project's Manual-entry panel (MA/TX/NM/AZ/PA/MN included). dashboard.js permitPathChoice(project)
// is the one function that decides the label, the hint and whether the two options are live; it
// is lifted from the real file here (the same lift boardGateTruth uses) and run as-is.
//
// KILL (verified red by hand): make permitPathChoice return the Oregon shape for every state →
// (u2) fails.
//
// Run: npx tsx backend/test/permitPathChoiceUi.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(process.env.DASHBOARD_JS_PATH || path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const lift = (name: string): string => {
  const re = new RegExp(`^(?:async )?function ${name}\\(`, "m");
  const m = re.exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  let i = dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  let depth = 0;
  for (; i < dashboard.length; i++) {
    const ch = dashboard[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboard.slice(m.index, i);
};
// eslint-disable-next-line no-new-func
const { permitPathChoice } = new Function(`${lift("permitPathChoice")}\nreturn { permitPathChoice };`)() as { permitPathChoice: (p: unknown) => { enabled: boolean; label: string; hint: string } };

const SPLIT_WORDS = /prescriptive vs engineered|mutually exclusive/i;

await check("(u1) MUST-PASS: an Oregon project keeps the split — options live, the Oregon label and hint", () => {
  const c = permitPathChoice({ state: "OR", parserSnapshot: {} });
  assert.equal(c.enabled, true);
  assert.match(c.label, /prescriptive vs engineered/);
  assert.match(c.hint, /mutually exclusive/);
});
await check("(u2) MUST-EXCLUDE: outside Oregon the options are dead and neither label nor hint carries the split's words", () => {
  for (const state of ["MA", "TX", "NM", "AZ", "PA", "MN", "IA", "FL", "", undefined]) {
    const c = permitPathChoice({ state, parserSnapshot: {} });
    assert.equal(c.enabled, false, `${state}: options must be dead`);
    assert.ok(!SPLIT_WORDS.test(c.label), `${state}: label "${c.label}"`);
    assert.ok(!SPLIT_WORDS.test(c.hint), `${state}: hint "${c.hint}"`);
    assert.match(c.hint, /standard structural review/, `${state}: the hint says what applies instead`);
  }
  assert.equal(permitPathChoice(undefined).enabled, false, "no project at all: dead");
});
await check("(u3) MUST-PASS: a jurisdiction whose cited process names a split (the backend's flag) gets the choice back", () => {
  assert.equal(permitPathChoice({ state: "TX", parserSnapshot: { prescriptiveSplitApplies: true } }).enabled, true);
  assert.equal(permitPathChoice({ state: "TX", prescriptiveSplitApplies: true }).enabled, true);
  assert.equal(permitPathChoice({ state: "TX", parserSnapshot: { prescriptiveSplitApplies: "yes" } }).enabled, false, "only a literal true, never a truthy string");
});
await check("(u4) the markup the function drives exists: the label span, the select and the hint by id", () => {
  const html = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.html"), "utf8");
  assert.match(html, /id="manualPermitPathLabel"/);
  assert.match(html, /id="manualPermitPath"/);
  assert.match(html, /id="manualPermitPathHint"/);
  assert.ok(!/<span id="manualPermitPathLabel">[^<]*prescriptive vs engineered/i.test(html), "the static label no longer names the split");
});

if (failures) { console.error(`\n${failures} permitPathChoiceUi check(s) failed.`); process.exit(1); }
console.log("\npermitPathChoiceUi: all checks passed");
process.exit(0);
