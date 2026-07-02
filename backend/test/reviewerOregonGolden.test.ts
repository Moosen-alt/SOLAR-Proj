// GOLDEN test for the Oregon reviewer report. Captured from the engine BEFORE the
// data-driven-rules refactor; the refactor must reproduce this byte-identically
// (minus generatedAt) — blocker counts gate staging, so any drift is a regression.
//
// Fixture is deliberately adversarial: it trips the prescriptive screens
// (snow 85 > 70, dead load 5 > 4.5, rafter 32 > 24, wind D, 60 kW DC > 50 stamp,
// 30 kW export > 25) plus PGE utility checks, on a Portland AHJ so the
// Portland-specific rafter guidance applies.
//
// Regenerate ONLY when a behavior change is intended:
//   UPDATE_GOLDEN=1 tsx backend/test/reviewerOregonGolden.test.ts
// Run: tsx backend/test/reviewerOregonGolden.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";

const fixture = {
  id: "golden-or-1",
  clientId: "client-golden",
  homeownerName: "Golden Test",
  projectAddress: "123 Snowy Ridge Rd",
  city: "Portland",
  state: "OR",
  zip: "97201",
  ahj: "Portland",
  utility: "PGE",
  accountNumber: "1234567890",
  meterNumber: "987654",
  systemSizeDcKw: 60,
  systemSizeAcKw: 48,
  interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    // evaluateBaselineRules reads jurisdiction from the payload itself.
    state: "OR",
    ahj: "Portland",
    utility: "PGE",
    dcKw: "60",
    acKw: "48",
    exportKw: "30",
    snow: "85",
    deadLoad: "5",
    roofRafterSpacing: "32",
    wind: "D",
    busRating: "200",
    mainBreaker: "200",
    pvBreaker: "70",
    moduleMake: "Qcells",
    moduleModel: "Q.TRON BLK M-G2+",
    moduleWattage: "430",
    moduleQty: "140",
    inverterModel: "IQ8M",
    homeownerEmail: "golden@test.example",
    homeownerPhone: "(503) 555-0100",
    permitPath: "prescriptive",
    splitPagesText: "one-line diagram rapid shutdown site plan roof plan",
    projectDescriptionText: "Roof-mounted PV, load side interconnection.",
  },
} as unknown as ProjectRecord;

import { evaluateBaselineRules } from "../src/baselineRules";

const fixturesDir = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const goldenPath = path.join(fixturesDir, "reviewerOregonGolden.json");
const baselineGoldenPath = path.join(fixturesDir, "baselineOregonGolden.json");

function normalized(): unknown {
  const report = buildReviewerReport(fixture);
  return JSON.parse(JSON.stringify({ ...report, generatedAt: "<normalized>" }));
}

// The QC-side rule engine (evaluateBaselineRules) carries its own hardcoded Oregon
// thresholds — golden it too so the data-driven refactor can't drift it either.
function baselineNormalized(): unknown {
  return JSON.parse(JSON.stringify(evaluateBaselineRules((fixture as unknown as { parserSnapshot: never }).parserSnapshot)));
}

if (process.env.UPDATE_GOLDEN === "1") {
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(goldenPath, JSON.stringify(normalized(), null, 2));
  fs.writeFileSync(baselineGoldenPath, JSON.stringify(baselineNormalized(), null, 2));
  console.log(`goldens written: ${goldenPath}, ${baselineGoldenPath}`);
  process.exit(0);
}

let failures = 0;
try {
  assert.deepEqual(normalized(), JSON.parse(fs.readFileSync(goldenPath, "utf8")));
  const actual = normalized() as { findings: Array<{ severity: string }> };
  const blockers = actual.findings.filter((f) => f.severity === "blocker").length;
  console.log(`  ok   - Oregon reviewer golden matches (${actual.findings.length} findings, ${blockers} blockers)`);
} catch (err) {
  failures++;
  console.error("  FAIL - Oregon reviewer golden drifted. If the change is INTENDED, regenerate with UPDATE_GOLDEN=1.");
  console.error(err instanceof Error ? err.message.slice(0, 4000) : String(err));
}
try {
  assert.deepEqual(baselineNormalized(), JSON.parse(fs.readFileSync(baselineGoldenPath, "utf8")));
  console.log(`  ok   - Oregon baseline-QC golden matches (${(baselineNormalized() as unknown[]).length} results)`);
} catch (err) {
  failures++;
  console.error("  FAIL - Oregon baseline-QC golden drifted. If the change is INTENDED, regenerate with UPDATE_GOLDEN=1.");
  console.error(err instanceof Error ? err.message.slice(0, 4000) : String(err));
}
if (failures > 0) process.exit(1);
console.log("\nAll reviewer-golden tests passed.");
