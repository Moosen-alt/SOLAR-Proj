// THE DESCRIPTION OF WORK NAMES ONE INTERCONNECTION — THE ONE THE INTERCONNECTION METHOD SAYS.
//
// A real Newberg job (2026-09-28): the parser page wrote "Interconnection method: Supply-side
// breaker." and, on the next line, "Electrical scope includes … load breaker interconnection". The
// page-text flags had seen a "load" breaker somewhere and outranked the method field the plan set's
// own note decided ("SUPPLY SIDE TAP INTERCONNECTION ACCORDING TO NEC 705.11"). Operator: "have it be
// what it says on the plan set". The method field wins; the flags speak only when it names nothing.
// Also pins c3e06f0: a rating that carries its unit is not given a second one ("200AA").
//
//   npx tsx backend/test/scopeSentenceInterconnection.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { REPO } from "./_isolate";

const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
const start = html.indexOf("function buildProjectDescriptionScopeLines(");
assert.ok(start >= 0, "buildProjectDescriptionScopeLines not found in parser.html");
const end = html.indexOf("\n}\n", start);
const fnSrc = html.slice(start, end + 2);

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const sentence = (method: string, flags: Record<string, unknown>, plan: Record<string, unknown> = {}): string => {
  const sandbox: Record<string, unknown> = {
    state: { electricalScope: { flags } },
    clean: (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim(),
    getVal: (id: string) => (id === "interco" ? method : ""),
  };
  vm.runInNewContext(`${fnSrc}\nthis.out = buildProjectDescriptionScopeLines(${JSON.stringify(plan)});`, sandbox);
  return String((sandbox.out as string[])[0] ?? "");
};

check("MUST-PASS: 'Supply-side breaker' with a stray load-breaker flag -> supply-side breaker, never load breaker", () => {
  const s = sentence("Supply-side breaker", { loadBreaker: true, acDisconnect: true });
  assert.match(s, /supply-side breaker interconnection/);
  assert.doesNotMatch(s, /load breaker/);
});
check("MUST-PASS: 'Line side tap (supply-side)' -> line side tap interconnection", () => {
  assert.match(sentence("Line side tap (supply-side)", { loadBreaker: true }), /line side tap interconnection/);
});
check("MUST-PASS: 'Load-side breaker' -> load breaker interconnection", () => {
  assert.match(sentence("Load-side breaker", { supplyBreaker: true }), /load breaker interconnection/);
});
check("no method stated -> the text flags decide, as before", () => {
  assert.match(sentence("", { loadBreaker: true }), /load breaker interconnection/);
  assert.match(sentence("", { lineSideTap: true, tapType: "Line side tap" }), /line side tap interconnection/);
});
check("pin c3e06f0: '200A' ratings are not printed '200AA'", () => {
  const s = sentence("Supply-side breaker", { mpu: true }, { busRating: "200A", mainBreaker: "200 A" });
  assert.match(s, /200A bus \/ 200A main breaker/);
  assert.doesNotMatch(s, /AA/);
});

if (failures) { console.error(`\n${failures} scope-sentence check(s) FAILED.`); process.exit(1); }
console.log("\nAll scope-sentence interconnection checks passed.");
process.exit(0);
