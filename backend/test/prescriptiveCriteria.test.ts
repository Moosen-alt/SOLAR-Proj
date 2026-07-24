// Prescriptive structural criteria evaluator: each checklist row answers
// Yes/No/[verify] straight from the parsed structural snapshot (no more
// hardcoded [verify]), and the criteria feed the generated prescriptive
// application. Browser/DB-free. Run: tsx backend/test/prescriptiveCriteria.test.ts
import assert from "node:assert/strict";
import { evaluatePrescriptiveCriteria } from "../src/permitPath";
import type { ProjectRecord } from "../../shared/src/types";

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

const proj = (snapshot: Record<string, unknown>): ProjectRecord =>
  ({ parserSnapshot: snapshot } as unknown as ProjectRecord);

const answerOf = (rows: ReturnType<typeof evaluatePrescriptiveCriteria>, labelStart: string): string => {
  const row = rows.find((r) => r.label.startsWith(labelStart));
  assert.ok(row, `expected a criterion starting with "${labelStart}"`);
  return row.answer;
};

// 1) A fully-parsed passing project → every criterion answers Yes.
const passing = evaluatePrescriptiveCriteria(proj({
  mounting: "Roof Mount",
  lightFrame: "yes",
  riskCategory: "II",
  snow: 25,
  wind: "C",
  windSpeed: 110,
  roofRafterSpacing: 24,
  deadLoad: 3.2,
  moduleHeightAboveRoof: 6,
  roofLayers: 1,
}));
for (const row of passing) {
  assert.equal(row.answer, "Yes", `expected Yes for "${row.label}", got ${row.answer} (${row.detail})`);
}
ok("all criteria answer Yes when the parsed data is within prescriptive limits");

// 2) Over-limit values answer No (not [verify]).
const failing = evaluatePrescriptiveCriteria(proj({
  mounting: "Ground Mount",
  lightFrame: "no",
  riskCategory: "III",
  snow: 90,
  wind: "D",
  windSpeed: 150,
  roofRafterSpacing: 32,
  deadLoad: 6,
  moduleHeightAboveRoof: 24,
  roofLayers: 3,
}));
assert.equal(answerOf(failing, "Roof-mounted"), "No");
assert.equal(answerOf(failing, "Conventional light-frame"), "No");
assert.equal(answerOf(failing, "Risk Category"), "No");
assert.equal(answerOf(failing, "Ground snow load"), "No");
assert.equal(answerOf(failing, "Wind exposure"), "No");
assert.equal(answerOf(failing, "Ultimate design wind speed"), "No");
assert.equal(answerOf(failing, "Rafter/truss spacing"), "No");
assert.equal(answerOf(failing, "PV dead load"), "No");
assert.equal(answerOf(failing, "Module height"), "No");
assert.equal(answerOf(failing, "Existing roofing layers"), "No");
ok("over-limit / non-conforming values answer No");

// 3) Missing data answers [verify], never a false Yes/No.
const empty = evaluatePrescriptiveCriteria(proj({}));
for (const row of empty) {
  assert.equal(row.answer, "[verify]", `expected [verify] for unparsed "${row.label}", got ${row.answer}`);
}
ok("unparsed criteria answer [verify]");

// 4) Wind-speed cap is exposure-specific: 130 mph is OK for Exp B (135) but not Exp C (120).
const expB = evaluatePrescriptiveCriteria(proj({ wind: "B", windSpeed: 130 }));
assert.equal(answerOf(expB, "Ultimate design wind speed"), "Yes");
const expC = evaluatePrescriptiveCriteria(proj({ wind: "C", windSpeed: 130 }));
assert.equal(answerOf(expC, "Ultimate design wind speed"), "No");
ok("wind-speed cap is exposure-specific (135 mph Exp B, 120 mph Exp C)");

// 5) Per-AHJ limit override changes the threshold used.
const strict = evaluatePrescriptiveCriteria(proj({ snow: 60 }), { maxGroundSnowPsf: 50 });
assert.equal(answerOf(strict, "Ground snow load"), "No");
const lenient = evaluatePrescriptiveCriteria(proj({ snow: 60 }), { maxGroundSnowPsf: 70 });
assert.equal(answerOf(lenient, "Ground snow load"), "Yes");
ok("per-AHJ limit override drives the threshold");

console.log(`\nprescriptiveCriteria: all ${passed} checks passed`);
